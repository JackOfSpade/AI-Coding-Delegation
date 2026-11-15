import test from 'node:test';
import assert from 'node:assert/strict';
import {
  redact,
  redactError,
  redactText,
  redactBriefText,
  redactTokenShapes,
  RedactionProjector,
  stripTerminalControls,
  safeErrorText,
} from '../../src/redact.mjs';

test('client error sanitization recognizes credentials split by terminal formatting', () => {
  assert.equal(safeErrorText('API_\x1b[31mKEY=opaque-secret'), 'API_KEY=[REDACTED]');
  assert.equal(safeErrorText('sk-\x1b[0m1234567890abcdefghijklmnop'), '[REDACTED]');
  assert.equal(safeErrorText('before\n\tmessage\x1b]unfinished'), 'beforemessage');
});

test('terminal stripping follows ANSI boundaries and drops unfinished escapes without rescanning the suffix', () => {
  for (const [source, expected] of [
    ['before\x1b[31mred\x1b[0m after', 'beforered after'],
    ['\x1b]first\x1b\\visible\x1b]second\x1b\\tail', 'visibletail'],
    ['\x1b]title\x07visible', 'visible'],
    ['before\x1b]unfinished title', 'before'],
    ['before\x1b[31', 'before'],
    [`before${'\x1b]'.repeat(64_000)}`, 'before'],
    ['café 🐈\n\t\r\x00\x07\x7f', 'café 🐈\n\t\r'],
    ['before\x1bMafter', 'beforeMafter'],
  ]) {
    assert.equal(stripTerminalControls(source), expected);
    let streamed = '';
    const projector = new RedactionProjector(({ text }) => {
      streamed += text;
    });
    for (let index = 0; index < source.length; index++) projector.push(source[index], index, index + 1);
    projector.finish(source.length);
    assert.equal(streamed, expected, 'whole-value and streaming terminal stripping agree');
  }
});

test('redaction removes explicit secrets and credential-looking text', () => {
  const value = redactText('Authorization: Bearer abc.def SECRET_TOKEN=xyz', ['abc.def']);
  assert.doesNotMatch(value, /abc\.def|xyz/);
  assert.match(value, /REDACTED/);
  assert.deepEqual(redact({ apiKey: 'nope', nested: { note: 'token=something' } }), {
    apiKey: '[REDACTED]',
    nested: { note: 'token=[REDACTED]' },
  });
  assert.doesNotMatch(redactError(new Error('failed super-secret'), ['super-secret']).message, /super-secret/);
  assert.doesNotMatch(redactText('x-api-key: value Authorization: Bearer very-secret', ['x']), /value|very-secret/);
  assert.equal(redactText('a', ['a']), '[REDACTED]');
});

test('structured token accounting remains numeric while credential tokens redact', () => {
  const redacted = redact({
    inputTokens: 12,
    output_tokens: 4,
    cacheHitTokens: 8,
    cache_miss_tokens: 4,
    totalTokenCount: 16,
    conservativeInputTokens: 100,
    minOutputTokens: 16,
    token: 'secret',
    accessToken: 'a',
    auth_token: 'b',
    refreshToken: 'c',
  });
  assert.deepEqual(redacted, {
    inputTokens: 12,
    output_tokens: 4,
    cacheHitTokens: 8,
    cache_miss_tokens: 4,
    totalTokenCount: 16,
    conservativeInputTokens: 100,
    minOutputTokens: 16,
    token: '[REDACTED]',
    accessToken: '[REDACTED]',
    auth_token: '[REDACTED]',
    refreshToken: '[REDACTED]',
  });
});

test('token-shaped accounting fields redact non-numeric values', () => {
  assert.deepEqual(
    redact({
      inputTokens: 'credential-looking-value',
      conservativeInputTokens: 'must-not-survive',
      minOutputTokens: 'also-not-a-count',
      outputTokens: -1,
      totalTokens: Number.POSITIVE_INFINITY,
    }),
    {
      inputTokens: '[REDACTED]',
      conservativeInputTokens: '[REDACTED]',
      minOutputTokens: '[REDACTED]',
      outputTokens: '[REDACTED]',
      totalTokens: '[REDACTED]',
    },
  );
});
test('redaction removes complete authentication header values and error codes', () => {
  const value = redactText('Authorization: Basic c2VjcmV0 Cookie: session=also-secret\nSet-Cookie: session=third-secret');
  assert.doesNotMatch(value, /c2VjcmV0|also-secret|third-secret/);
  const error = new Error('failed');
  error.code = 'AUTHORIZATION=error-secret';
  assert.doesNotMatch(redactError(error).code, /error-secret/);
});

test('cache-write accounting remains numeric through redaction while credential-shaped values are scrubbed', () => {
  assert.equal(redact({ cacheWriteTokens: 123 }).cacheWriteTokens, 123);
  assert.equal(redact({ cacheWriteTokens: 'secret' }).cacheWriteTokens, '[REDACTED]');
  assert.equal(redact({ cacheWriteTokens: -1 }).cacheWriteTokens, '[REDACTED]');
});

test('source token properties and placeholders are not credential headers', () => {
  const source = 'return { token: match[1], rest };';
  for (const value of [source, JSON.stringify({ content: source }), 'host.career.<kind>.<entity>.<n>', '- <catalog ID> - <reason>'])
    assert.equal(redactText(value), value);
  assert.equal(redactText('Token: actual-secret\nPassword: another-secret'), 'Token: [REDACTED]\nPassword: [REDACTED]');
});

test('token shapes require a credential separator and known secrets still redact in opaque signatures', () => {
  const signature = 'AbCdEf+/skabcdefghijklmnop+/keyabcdefghijklmnop/AbCdEf==';
  assert.equal(redactTokenShapes(signature), signature);
  assert.equal(redactTokenShapes('keyboardShortcutConfiguration'), 'keyboardShortcutConfiguration');
  assert.equal(redactText(redactTokenShapes(signature), ['skabcdefghijklmnop']), 'AbCdEf+/[REDACTED]+/keyabcdefghijklmnop/AbCdEf==');
  for (const prefix of ['sk-', 'rk-', 'key_', 'bearer-']) assert.equal(redactTokenShapes(`${prefix}abcdefghijklmnop`), '[REDACTED]');
});

test('streaming header detection agrees with text redaction across long source prefixes and header indentation', () => {
  for (const value of [
    `return { ${' '.repeat(200)}token: match[1], rest };`,
    `${' '.repeat(200)}Token: actual-secret`,
    'return { token: match[1], rest };\nToken: actual-secret',
  ]) {
    let output = '';
    const projector = new RedactionProjector((span) => {
      output += span.text;
    });
    for (let index = 0; index < value.length; index++) projector.push(value[index], index, index + 1);
    projector.finish(value.length);
    assert.equal(output, redactText(value));
  }
});

test('brief redaction keeps a brief line that only names a header', () => {
  const sentence = 'Send the request with the x-api-key: key header, then the body {"id":1}, poll every 2s and accept 201.';
  assert.deepEqual(redactBriefText(sentence), { text: sentence, spans: 0 });
  const placeholder = 'Send the request with the x-api-key: <key> header, then the body {"id":1}, poll every 2s and accept 201.';
  assert.deepEqual(redactBriefText(placeholder), { text: placeholder, spans: 0 });
});

test('brief redaction replaces only a secret-shaped header value and keeps the rest of the line', () => {
  assert.deepEqual(redactBriefText('Send x-api-key: ak9f8d7s6a5q4w3e2r1t0zz, then poll status 204 twice.'), {
    text: 'Send x-api-key: [REDACTED], then poll status 204 twice.',
    spans: 1,
  });
});

test('brief redaction judges the credential after an authorization scheme word', () => {
  assert.deepEqual(redactBriefText('Use authorization: Basic dXNlcjpwYXNzd29yZA==, then retry the call.'), {
    text: 'Use authorization: Basic [REDACTED], then retry the call.',
    spans: 1,
  });
  assert.deepEqual(redactBriefText('Use authorization: Basic <token>, then retry the call.'), {
    text: 'Use authorization: Basic <token>, then retry the call.',
    spans: 0,
  });
});

test('brief redaction judges every cookie pair and keeps names and attributes', () => {
  assert.deepEqual(redactBriefText('cookie: session=sk9f8d7s6a5q4w3e2r1t0zz; theme=<dark>; secure'), {
    text: 'cookie: session=[REDACTED]; theme=<dark>; secure',
    spans: 1,
  });
});

test('brief redaction leaves later lines of a multi-line brief untouched', () => {
  assert.deepEqual(redactBriefText('Send x-api-key: ak9f8d7s6a5q4w3e2r1t0zz\nStatus codes 201 and 204.\nPoll every 2s.'), {
    text: 'Send x-api-key: [REDACTED]\nStatus codes 201 and 204.\nPoll every 2s.',
    spans: 1,
  });
});

test('brief redaction replaces a known literal secret', () => {
  assert.deepEqual(redactBriefText('the value sup3r-s3cret-value goes here', ['sup3r-s3cret-value']), {
    text: 'the value [REDACTED] goes here',
    spans: 1,
  });
});

test('brief redaction is idempotent on its own output', () => {
  const brief = [
    'Send x-api-key: ak9f8d7s6a5q4w3e2r1t0zz then authorization: Basic dXNlcjpwYXNzd29yZA==',
    'and cookie: a=sk9f8d7s6a5q4w3e2r1t0zz; theme=<dark>',
  ].join('\n');
  const once = redactBriefText(brief);
  assert.equal(once.spans, 3);
  assert.deepEqual(redactBriefText(once.text), { text: once.text, spans: 0 });
});

test('redactText still cuts the whole line after a sensitive header name', () => {
  assert.equal(
    redactText('Send the request with the x-api-key: key header, then the body.'),
    'Send the request with the x-api-key: [REDACTED]',
  );
  assert.equal(redactText('cookie: theme=<dark>; secure'), 'cookie: [REDACTED]');
});

test('brief redaction treats a mixed-case letter run as a credential but keeps single-case and Capitalized words', () => {
  assert.deepEqual(redactBriefText('Authorization: Basic dXNlcjpwYXNz then more'), {
    text: 'Authorization: Basic [REDACTED] then more',
    spans: 1,
  });
  assert.deepEqual(redactBriefText('x-api-key: AbCdEfGhIjKlMnOp tail'), { text: 'x-api-key: [REDACTED] tail', spans: 1 });
  for (const kept of [
    'x-api-key: Key, body',
    'x-api-key: YOUR_API_KEY, body',
    'x-api-key: your-api-key, body',
    'Authorization: Basic credentials here',
  ])
    assert.deepEqual(redactBriefText(kept), { text: kept, spans: 0 });
});
