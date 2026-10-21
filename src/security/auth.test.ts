import { describe, expect, it } from 'vitest';
import { createApiKeyAuthenticator } from './auth.js';

describe('createApiKeyAuthenticator', () => {
  it('returns only the configured client identity for a valid API key', () => {
    const authenticate = createApiKeyAuthenticator({
      apiKey: 'correct-secret',
      clientId: 'client-1',
    });

    expect(authenticate('correct-secret')).toEqual({
      authenticated: true,
      clientId: 'client-1',
    });
  });

  it('returns the same unauthorized result for missing, invalid, and unequal-length keys', () => {
    const authenticate = createApiKeyAuthenticator({
      apiKey: 'correct-secret',
      clientId: 'client-1',
    });

    const missing = authenticate(undefined);
    const sameLengthWrong = authenticate('incorrect-secret');
    const unequalLengthWrong = authenticate('x');

    expect(missing).toEqual({ authenticated: false, statusCode: 401 });
    expect(sameLengthWrong).toEqual(missing);
    expect(unequalLengthWrong).toEqual(missing);
  });

  it('does not include credentials in authentication results', () => {
    const apiKey = 'sensitive-test-key';
    const authenticate = createApiKeyAuthenticator({ apiKey, clientId: 'client-1' });
    const results = [authenticate(apiKey), authenticate('invalid-key'), authenticate(undefined)];

    expect(JSON.stringify(results)).not.toContain(apiKey);
    expect(JSON.stringify(results)).not.toContain('invalid-key');
  });

  it('rejects empty authentication configuration without exposing its values', () => {
    expect(() => createApiKeyAuthenticator({ apiKey: '', clientId: 'client-1' })).toThrow(
      'apiKey and clientId must be non-empty strings.',
    );
    expect(() => createApiKeyAuthenticator({ apiKey: 'secret', clientId: '' })).toThrow(
      'apiKey and clientId must be non-empty strings.',
    );
  });
});
