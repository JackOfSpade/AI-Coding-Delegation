// `token` is ambiguous in structured telemetry: inputTokens/outputTokens and
// cache token counts are accounting data, not credentials.  Keep the
// credential rule precise so persistence does not silently destroy metering.
const USAGE_TOKEN_KEY =
  /^(?:tokens|(?:input|output|prompt|completion|total|cached|cachehit|cachemiss|reasoning)(?:tokens?|tokencount)|minoutputtokens|conservativeinputtokens)$/i;

/**
 * Only numeric token accounting is safe to preserve under a token-shaped
 * field name. A string in one of these fields could still be a credential.
 * This is exported for the durable store, which applies an earlier redaction
 * pass before this foundation layer.
 */
export function safeTokenAccountingValue(key, value) {
  const normalized = String(key).replace(/[-_ ]/g, '').toLowerCase();
  return USAGE_TOKEN_KEY.test(normalized) && Number.isSafeInteger(value) && value >= 0;
}
function sensitiveKey(key, value) {
  if (safeTokenAccountingValue(key, value)) return false;
  return /(?:apikey|authorization|password|secret|credential|cookie|privatekey|(?:access|refresh|auth|session|bearer|id)?token)/i.test(
    String(key).replace(/[-_ ]/g, '').toLowerCase(),
  );
}
const BEARER = /\b(Bearer)[ \t]+[A-Za-z0-9._~+\/-]+=*/gi;
const ASSIGNMENT = /\b((?:(?:[A-Za-z_][A-Za-z0-9_]*_)?(?:TOKEN|SECRET|PASSWORD|API_KEY|KEY)|AUTHORIZATION|COOKIE))=([^\s'"`]+)/gi;
const SENSITIVE_HEADER = /\b(?:(?:x-)?api[-_ ]?key|authorization|(?:set-)?cookie|token|secret|password)\s*:\s*[^\r\n]*/gi;
const ASSIGNMENT_SUFFIX = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|KEY)$/i;
const EXACT_ASSIGNMENT = /^(?:AUTHORIZATION|COOKIE)$/i;
const HEADER_SUFFIX = /(?:^|[^A-Za-z0-9_])(?:(?:x-)?api[-_ ]?key|authorization|(?:set-)?cookie|token|secret|password)$/i;
const WORD = /[A-Za-z0-9_]/;
const IDENTIFIER = /[A-Za-z0-9_]/;
const BEARER_VALUE = /^[A-Za-z0-9._~+\/=\-]$/;
const BEARER_WHITESPACE = /^[ \t]$/;
const HEADER_WHITESPACE = /^\s$/;
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

// Keep the literal terminal-cleaning rule used at every provider boundary in
// one module.  The streaming projector below uses the same semantics, but
// retains raw source offsets while it does so.
export function stripTerminalControls(value) {
  return String(value)
    .replace(/\x1B(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

const sensitiveAssignment = (identifier) => {
  const tail = identifier.slice(-64);
  return EXACT_ASSIGNMENT.test(identifier) || ASSIGNMENT_SUFFIX.test(tail);
};
const sensitiveHeader = (tail) => HEADER_SUFFIX.test(tail.trimEnd());

/**
 * Project UTF-8 scalar tokens to terminal-safe, redacted output while
 * preserving each emitted span's original byte offsets.  It deliberately
 * scans state from the beginning of a stream: a caller starting a page in
 * the middle of a credential will still receive a single redaction span,
 * never the credential's suffix.  Memory is bounded (small token/tail state
 * plus the current redaction's offsets), including for a very long secret.
 *
 * `emit` receives `{ start, end, text, redacted }`; source bytes represented
 * by a span are contiguous and text may be empty for stripped controls.
 */
export class RedactionProjector {
  #emit;
  #ansi = 'normal';
  #ansiStart;
  #mode = 'normal';
  #redaction;
  #bearer = [];
  #previousWord = false;
  #identifier = '';
  #headerTail = '';
  #sensitiveHeaderPending = false;

  constructor(emit) {
    if (typeof emit !== 'function') throw new TypeError('emit must be a function');
    this.#emit = emit;
  }

  get canStopAtBoundary() {
    // A completed page can safely stop only after an ANSI escape and an
    // already-recognized secret have both reached their real source end.
    return this.#ansi === 'normal' && this.#mode !== 'redaction';
  }

  #span(start, end, text, redacted = false) {
    if (end > start) this.#emit({ start, end, text, redacted });
  }

  #trackNormal(char) {
    this.#previousWord = WORD.test(char);
    if (IDENTIFIER.test(char)) this.#identifier = `${this.#identifier}${char}`.slice(-64);
    else this.#identifier = '';
    if (char === '\n' || char === '\r') {
      this.#headerTail = '';
      // redactText's header grammar accepts folded whitespace. Retain an
      // already recognized sensitive field name through CR/LF as well, and
      // clear it only when a non-whitespace token proves this is not a colon.
      return;
    }
    // Do not use the bounded tail as a lookbehind for the whitespace between
    // a known sensitive field name and its colon. Once the finite header name
    // has been recognized, this state remains through arbitrary horizontal
    // whitespace; controls/ANSI sequences call `skip` and therefore cannot
    // reset it.
    if (this.#sensitiveHeaderPending && !HEADER_WHITESPACE.test(char)) this.#sensitiveHeaderPending = false;
    this.#headerTail = `${this.#headerTail}${char}`.slice(-96);
    if (sensitiveHeader(this.#headerTail)) this.#sensitiveHeaderPending = true;
  }

  #normal(token, { detectBearer = true } = {}) {
    const { char, start, end } = token;
    if (char === '=' && sensitiveAssignment(this.#identifier)) {
      this.#mode = 'assignment';
      this.#redaction = { start, end };
      this.#identifier = '';
      this.#previousWord = false;
      this.#headerTail = `${this.#headerTail}${char}`.slice(-96);
      return;
    }
    if (char === ':' && (this.#sensitiveHeaderPending || sensitiveHeader(this.#headerTail))) {
      this.#mode = 'redaction';
      this.#redaction = { start, end, text: ': [REDACTED]', kind: 'header' };
      this.#identifier = '';
      this.#previousWord = false;
      this.#headerTail = '';
      this.#sensitiveHeaderPending = false;
      return;
    }
    if (detectBearer && (char === 'B' || char === 'b') && !this.#previousWord) {
      this.#mode = 'bearer';
      this.#bearer = [token];
      return;
    }
    this.#span(start, end, char);
    this.#trackNormal(char);
  }

  #flushBearer() {
    const tokens = this.#bearer;
    this.#bearer = [];
    this.#mode = 'normal';
    for (const token of tokens) this.#normal(token, { detectBearer: false });
  }

  #finishRedaction(end) {
    const value = this.#redaction;
    this.#span(value.start, end, value.text, true);
    this.#redaction = undefined;
    this.#mode = 'normal';
    this.#identifier = '';
    this.#previousWord = false;
  }

  #pushClean(token) {
    const { char, start, end } = token;
    if (this.#mode === 'redaction') {
      const kind = this.#redaction.kind;
      const terminates =
        (kind === 'header' && (char === '\n' || char === '\r')) ||
        (kind === 'assignment' && /[\s'"`]/.test(char)) ||
        (kind === 'bearer' && !BEARER_VALUE.test(char));
      if (terminates) {
        // Keep delimiters visible, but never any part of their value.
        this.#finishRedaction(start);
        this.#normal(token);
      } else this.#redaction.end = end;
      return;
    }
    if (this.#mode === 'assignment') {
      if (!/[^\s'"`]/.test(char)) {
        const pending = this.#redaction;
        this.#mode = 'normal';
        this.#redaction = undefined;
        this.#span(pending.start, pending.end, '=');
        this.#trackNormal('=');
        this.#normal(token);
      } else {
        this.#mode = 'redaction';
        this.#redaction = { start: this.#redaction.start, end, text: '=[REDACTED]', kind: 'assignment' };
      }
      return;
    }
    if (this.#mode === 'bearer') {
      const expected = 'bearer';
      const position = this.#bearer.length;
      if (char.toLowerCase() === expected[position]) {
        this.#bearer.push(token);
        if (this.#bearer.length === expected.length) {
          // The label is ordinary text and must remain visible. More
          // importantly, emitting it here lets a one-byte page advance
          // through `Bearer` rather than leaving an empty, markerless page.
          this.#flushBearer();
          this.#mode = 'bearer-await-whitespace';
        }
        return;
      }
      this.#flushBearer();
      this.#pushClean(token);
      return;
    }
    if (this.#mode === 'bearer-await-whitespace') {
      if (BEARER_WHITESPACE.test(char)) {
        this.#span(start, end, char);
        this.#trackNormal(char);
        this.#mode = 'bearer-after-whitespace';
        return;
      }
      // `BearerX` is an ordinary identifier, not a credential scheme.
      this.#mode = 'normal';
      this.#pushClean(token);
      return;
    }
    if (this.#mode === 'bearer-after-whitespace') {
      if (BEARER_WHITESPACE.test(char)) {
        this.#span(start, end, char);
        this.#trackNormal(char);
        return;
      }
      if (BEARER_VALUE.test(char)) {
        this.#mode = 'redaction';
        this.#redaction = { start, end, text: '[REDACTED]', kind: 'bearer' };
        return;
      }
      this.#mode = 'normal';
      this.#pushClean(token);
      return;
    }
    this.#normal(token);
  }

  /** Feed one decoded source scalar and its exact raw byte span. */
  push(char, start, end) {
    if (typeof char !== 'string' || char.length === 0) throw new TypeError('char is required');
    if (this.#ansi === 'escape') {
      if (char === '[') this.#ansi = 'csi';
      else if (char === ']') this.#ansi = 'osc';
      else {
        this.#ansi = 'normal';
        this.skip(this.#ansiStart, start);
        this.#pushClean({ char, start, end });
      }
      return;
    }
    if (this.#ansi === 'csi') {
      if (/[\x40-\x7e]/.test(char)) {
        this.#ansi = 'normal';
        this.skip(this.#ansiStart, end);
      }
      return;
    }
    if (this.#ansi === 'osc') {
      if (char === '\x07') {
        this.#ansi = 'normal';
        this.skip(this.#ansiStart, end);
      } else if (char === '\x1b') this.#ansi = 'osc-escape';
      return;
    }
    if (this.#ansi === 'osc-escape') {
      if (char === '\\') {
        this.#ansi = 'normal';
        this.skip(this.#ansiStart, end);
      } else this.#ansi = 'osc';
      return;
    }
    if (char === '\x1b') {
      this.#ansi = 'escape';
      this.#ansiStart = start;
      return;
    }
    if (CONTROL.test(char)) {
      this.skip(start, end);
      return;
    }
    this.#pushClean({ char, start, end });
  }

  /** Account for source bytes deliberately stripped before redaction. */
  skip(start, end) {
    if (this.#mode === 'redaction' || this.#mode === 'assignment') this.#redaction.end = end;
    else this.#span(start, end, '');
  }

  /** Resolve harmless partial labels at a normal pagination boundary. */
  flushBoundary() {
    if (this.#ansi !== 'normal' || this.#mode === 'redaction') return false;
    if (this.#mode === 'bearer') this.#flushBearer();
    else if (this.#mode === 'bearer-await-whitespace' || this.#mode === 'bearer-after-whitespace') this.#mode = 'normal';
    else if (this.#mode === 'assignment') {
      const pending = this.#redaction;
      this.#redaction = undefined;
      this.#mode = 'normal';
      this.#span(pending.start, pending.end, '=');
      this.#trackNormal('=');
    }
    return true;
  }

  /** Flush the final source span at EOF. Unterminated terminal escapes drop. */
  finish(end) {
    if (this.#ansi !== 'normal') {
      this.skip(this.#ansiStart, end);
      this.#ansi = 'normal';
    }
    if (this.#mode === 'redaction') this.#finishRedaction(end);
    else this.flushBoundary();
  }
}

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
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sensitiveKey(key, item) ? '[REDACTED]' : redact(item, secrets)]),
    );
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
