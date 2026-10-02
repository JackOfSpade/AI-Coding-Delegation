// `token` is ambiguous in structured telemetry: inputTokens/outputTokens and
// cache token counts are accounting data, not credentials.  Keep the
// credential rule precise so persistence does not silently destroy metering.
const USAGE_TOKEN_KEY = /^(?:tokens|(?:input|output|prompt|completion|total|cached|cachehit|cachemiss|reasoning)(?:tokens?|tokencount))$/i;
function sensitiveKey(key) {
  const normalized = String(key).replace(/[-_ ]/g, '').toLowerCase();
  if (USAGE_TOKEN_KEY.test(normalized)) return false;
  return /(?:apikey|authorization|password|secret|credential|cookie|privatekey|(?:access|refresh|auth|session|bearer|id)?token)/i.test(
    normalized,
  );
}
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi;
const ASSIGNMENT = /\b((?:(?:[A-Za-z_][A-Za-z0-9_]*_)?(?:TOKEN|SECRET|PASSWORD|API_KEY|KEY)|AUTHORIZATION|COOKIE))=([^\s'"`]+)/gi;
const SENSITIVE_HEADER = /\b(?:(?:x-)?api[-_ ]?key|authorization|(?:set-)?cookie|token|secret|password)\s*:\s*[^\r\n]*/gi;

/** Redact known literal secrets and common credential-bearing text forms. */
export function redactText(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(BEARER, '$1 [REDACTED]')
    .replace(ASSIGNMENT, '$1=[REDACTED]')
    .replace(SENSITIVE_HEADER, (value) => value.replace(/:\s*[\s\S]*/, ': [REDACTED]'));
}

/** Deep-copy a serializable value while redacting sensitive object fields and strings. */
export function redact(value, secrets = []) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey(key) ? '[REDACTED]' : redact(item, secrets)]));
  }
  return value;
}

export function redactError(error, secrets = []) {
  return {
    name: redactText(error?.name || 'Error', secrets),
    code: error?.code == null ? undefined : redactText(error.code, secrets),
    message: redactText(error?.message || 'Unknown error', secrets),
  };
}
