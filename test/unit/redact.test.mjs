import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactError, redactText } from '../../src/redact.mjs';

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
    token: '[REDACTED]',
    accessToken: '[REDACTED]',
    auth_token: '[REDACTED]',
    refreshToken: '[REDACTED]',
  });
});
test('redaction removes complete authentication header values and error codes', () => {
  const value = redactText('Authorization: Basic c2VjcmV0 Cookie: session=also-secret\nSet-Cookie: session=third-secret');
  assert.doesNotMatch(value, /c2VjcmV0|also-secret|third-secret/);
  const error = new Error('failed');
  error.code = 'AUTHORIZATION=error-secret';
  assert.doesNotMatch(redactError(error).code, /error-secret/);
});
