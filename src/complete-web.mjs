/**
 * Built-in web tools for `offload complete`: DeepSeek's Search and Fetch APIs
 * (https://api-docs.deepseek.com/guides/search), run by Offload itself inside a
 * tool loop. Leaf module: it never throws for a tool failure the model can work
 * around (bad arguments, blocked page, no content, retries exhausted); those
 * become the tool result text. Only a key or balance failure is `fatal`, and
 * the caller maps it to a stable complete error code.
 *
 * Query, URL and page text are returned to the caller only; nothing here logs
 * or writes them.
 */
import { bestEffort, fetchAbortable, readJsonAbortable } from './provider/abort.mjs';
import { plainObject } from './plain-object.mjs';

export const WEB_TOOL_NAMES = Object.freeze(['web_search', 'web_fetch']);
const MAX_QUERY_CHARS = 128;
const MAX_URL_CHARS = 8_192;
const MAX_SUMMARY_CHARS = 1_200;
const MAX_TITLE_CHARS = 500;
const MAX_SITE_CHARS = 200;
const MAX_DATE_CHARS = 64;
const cap = (value, max) => (value.length > max ? value.slice(0, max) : value);
const SEARCH_MAX_BYTES = 4_000_000;
const FETCH_MAX_BYTES = 16_000_000;
const RETRIES = 2;
const CONCURRENCY = 4;
/** [min, max, default] options per built-in tool. */
const OPTION_LIMITS = Object.freeze({
  web_search: { count: [1, 20, 5] },
  web_fetch: { maxChars: [1_000, 200_000, 20_000] },
});

const DEFINITIONS = {
  web_search: (options) => ({
    name: 'web_search',
    description:
      `Search the web. Returns up to ${options.count} results, each with title, url, date, site and a summary of the page. ` +
      `The query has at most ${MAX_QUERY_CHARS} characters and supports operators: site:example.com, -site:example.com, ` +
      '"exact phrase", -term, lang:en, after:YYYY-MM-DD, before:YYYY-MM-DD. Use web_fetch to read a result in full.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query, at most 128 characters, operators allowed' } },
      required: ['query'],
      additionalProperties: false,
    },
  }),
  web_fetch: (options) => ({
    name: 'web_fetch',
    description: `Fetch one web page and return its main content as Markdown, cut to at most ${options.maxChars} characters.`,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http or https URL of the page' } },
      required: ['url'],
      additionalProperties: false,
    },
  }),
};

/**
 * Validate one `{ builtin, ...options }` tool entry. Returns the declared tool (name, description,
 * parameters as the model sees them) plus `builtin` and its options, or an error message.
 */
export function builtinTool(tool) {
  const kind = tool.builtin;
  if (typeof kind !== 'string' || !WEB_TOOL_NAMES.includes(kind)) return { error: `builtin must be one of ${WEB_TOOL_NAMES.join(', ')}` };
  const limits = OPTION_LIMITS[kind];
  for (const key of Object.keys(tool))
    if (key !== 'builtin' && !Object.hasOwn(limits, key))
      return { error: `a ${kind} tool takes only ${['builtin', ...Object.keys(limits)].join(', ')}` };
  const options = {};
  for (const [key, [min, max, fallback]] of Object.entries(limits)) {
    const value = tool[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max)
      return { error: `${kind}.${key} must be an integer from ${min} to ${max}` };
    options[key] = value;
  }
  return { tool: { ...DEFINITIONS[kind](options), builtin: kind, options } };
}

/** USD per successful request for each built-in tool, from the trusted table, or undefined. */
export function webToolPrices(table) {
  const rates = table?.tool_requests;
  if (!plainObject(rates)) return undefined;
  const prices = {};
  for (const name of WEB_TOOL_NAMES) {
    const perThousand = rates[name]?.usd_per_1k;
    if (!Number.isFinite(perThousand) || perThousand < 0) return undefined;
    prices[name] = perThousand / 1000;
  }
  return prices;
}

const toolText = (value) => JSON.stringify(value);
const toolError = (error, message) => ({ content: toolText({ error, message }), billable: false });

function searchArguments(raw) {
  const query = raw?.query;
  if (typeof query !== 'string' || !query.trim() || [...query].length > MAX_QUERY_CHARS)
    return { error: `query must be a non-blank string of at most ${MAX_QUERY_CHARS} characters` };
  return { query };
}

function fetchArguments(raw) {
  const value = raw?.url;
  if (typeof value !== 'string' || !value || value.length > MAX_URL_CHARS)
    return { error: `url must be a string of at most ${MAX_URL_CHARS} characters` };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { error: 'url must be an absolute URL' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password)
    return { error: 'url must be http or https with a host and no credentials' };
  return { url: value };
}

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * POST one Search or Fetch request with bounded retries for 408, 429 and 5xx.
 * Returns `{ body }`, `{ status }` for a final non-2xx, `{ network: true }`, or `{ fatal }`.
 */
async function post({ path, body, baseUrl, apiKey, fetchImpl, signal, maxBytes, retryDelayMs }) {
  const url = new URL(path, `${baseUrl}/`).href;
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetchAbortable(fetchImpl, url, {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (attempt < RETRIES) {
        await pause(retryDelayMs * 2 ** attempt, signal);
        continue;
      }
      return { network: true };
    }
    const status = response.status;
    if (response.ok) {
      try {
        return { body: await readJsonAbortable(response.body, { signal, maxBytes }) };
      } catch (error) {
        if (signal.aborted) throw error;
        return { status: 502 };
      }
    }
    bestEffort(() => response.body?.cancel?.());
    if (status === 401)
      return { fatal: { code: 'auth_failed', message: 'DeepSeek rejected the API key for a web tool', httpStatus: status } };
    if (status === 402)
      return {
        fatal: { code: 'credit_exhausted', message: 'DeepSeek account balance is insufficient for a web tool', httpStatus: status },
      };
    if ((status === 408 || status === 429 || status >= 500) && attempt < RETRIES) {
      await pause(retryDelayMs * 2 ** attempt, signal);
      continue;
    }
    return { status };
  }
}

function failureText(name, outcome) {
  if (outcome.network) return toolError('unavailable', `${name} could not reach DeepSeek; try again later or answer without it`);
  const status = outcome.status;
  if (name === 'web_fetch' && status === 403) return toolError('blocked', 'the page was rejected by the fetch security policy');
  if (name === 'web_fetch' && status === 404) return toolError('no_content', 'the page could not be retrieved or has no readable content');
  if (status === 429) return toolError('rate_limited', `${name} is rate limited; try fewer calls`);
  if (status === 400 || status === 413) return toolError('invalid_arguments', `${name} rejected the arguments (HTTP ${status})`);
  return toolError('unavailable', `${name} failed (HTTP ${status}); try again later or answer without it`);
}

/** Run one built-in call. Returns `{ content, billable }` or `{ fatal }`. */
async function runOne(call, tool, context) {
  let raw;
  try {
    raw = JSON.parse(call.arguments);
  } catch {
    return toolError('invalid_arguments', 'arguments must be one JSON object');
  }
  if (tool.builtin === 'web_search') {
    const args = searchArguments(raw);
    if (args.error) return toolError('invalid_arguments', args.error);
    const outcome = await post({
      ...context,
      path: '/v1/tools/search',
      body: { query: args.query, count: tool.options.count, need_content: false },
      maxBytes: SEARCH_MAX_BYTES,
    });
    if (outcome.fatal) return outcome;
    if (!outcome.body) return failureText('web_search', outcome);
    const results = (Array.isArray(outcome.body?.results) ? outcome.body.results : [])
      .filter((item) => plainObject(item) && typeof item.url === 'string')
      .slice(0, tool.options.count)
      .map((item) => ({
        title: typeof item.title === 'string' ? cap(item.title, MAX_TITLE_CHARS) : '',
        url: cap(item.url, MAX_URL_CHARS),
        ...(typeof item.date === 'string' ? { date: cap(item.date, MAX_DATE_CHARS) } : {}),
        ...(typeof item.site_name === 'string' ? { site: cap(item.site_name, MAX_SITE_CHARS) } : {}),
        summary: String(typeof item.summary === 'string' && item.summary ? item.summary : (item.snippet ?? '')).slice(0, MAX_SUMMARY_CHARS),
      }));
    // DeepSeek bills a search only when it returns results.
    return { content: toolText({ results }), billable: results.length > 0 };
  }
  const args = fetchArguments(raw);
  if (args.error) return toolError('invalid_arguments', args.error);
  const outcome = await post({ ...context, path: '/v1/tools/fetch', body: { url: args.url }, maxBytes: FETCH_MAX_BYTES });
  if (outcome.fatal) return outcome;
  if (!outcome.body) return failureText('web_fetch', outcome);
  const title = typeof outcome.body?.title === 'string' ? cap(outcome.body.title.replace(/\s+/g, ' ').trim(), MAX_TITLE_CHARS) : '';
  const page = typeof outcome.body?.content === 'string' ? outcome.body.content : '';
  if (!page) return toolError('no_content', 'the page has no readable content');
  const limit = tool.options.maxChars;
  const text = page.length > limit ? `${page.slice(0, limit)}\n\n[cut: first ${limit} of ${page.length} characters]` : page;
  return { content: title ? `# ${title}\n\n${text}` : text, billable: true };
}

/**
 * Run a turn's built-in calls, at most four at a time; results come back in call order.
 * `billed` ({ web_search, web_fetch }) is counted up as each call finishes, so a caller that
 * stops waiting (abort or timeout) still sees what DeepSeek already billed. After a key or
 * balance failure no further call starts. Returns `{ results: [{ toolCallId, content }] }` or `{ fatal }`.
 */
export async function runWebCalls(calls, tools, { baseUrl, apiKey, fetchImpl, signal, retryDelayMs = 500, billed }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const outcomes = new Array(calls.length);
  let next = 0;
  let fatal;
  const worker = async () => {
    while (next < calls.length && !fatal) {
      const index = next++;
      const outcome = await runOne(calls[index], byName.get(calls[index].name), { baseUrl, apiKey, fetchImpl, signal, retryDelayMs });
      outcomes[index] = outcome;
      if (outcome.billable && billed) billed[calls[index].name]++;
      if (outcome.fatal) fatal ??= outcome.fatal;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, calls.length) }, worker));
  if (fatal) return { fatal };
  return { results: calls.map((call, index) => ({ toolCallId: call.id, content: outcomes[index].content })) };
}
