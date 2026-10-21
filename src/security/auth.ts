import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Configuration for the v1 single-key authenticator.
 */
export interface ApiKeyAuthenticatorConfig {
  /** Configured API key accepted by the authenticator. */
  readonly apiKey: string;
  /** Tenant identity returned after successful authentication. */
  readonly clientId: string;
}

/**
 * Result of checking a presented API key.
 *
 * Failed authentication always has the same result shape and carries no
 * credential material.
 */
export type ApiKeyAuthenticationResult =
  | { readonly authenticated: true; readonly clientId: string }
  | { readonly authenticated: false; readonly statusCode: 401 };

/**
 * Function that authenticates a candidate API key.
 */
export type ApiKeyAuthenticator = (
  candidateToken: string | undefined,
) => ApiKeyAuthenticationResult;

const unauthorizedResult: ApiKeyAuthenticationResult = Object.freeze({
  authenticated: false,
  statusCode: 401,
});

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function createAuthenticator(expectedDigest: Buffer, clientId: string): ApiKeyAuthenticator {
  return (candidateToken) => {
    const token = typeof candidateToken === 'string' ? candidateToken : '';
    const candidateDigest = digest(token);
    const authenticated = timingSafeEqual(expectedDigest, candidateDigest);

    return authenticated ? { authenticated: true, clientId } : unauthorizedResult;
  };
}

/**
 * Creates an authenticator for one configured API key and tenant identity.
 *
 * The configured key is reduced to a fixed-length SHA-256 digest before the
 * returned function is exposed. Each candidate, including an absent token,
 * is hashed and compared with `timingSafeEqual`; credentials are never
 * returned or logged. The HTTP layer maps an unauthorized result to a 401
 * response.
 *
 * @param config - API key and its configured tenant identity.
 * @returns A function that returns the tenant identity only for a valid key.
 * @throws {@link TypeError} when either configured value is not a non-empty string.
 */
export function createApiKeyAuthenticator(config: ApiKeyAuthenticatorConfig): ApiKeyAuthenticator {
  const { apiKey, clientId } = config;
  if (
    typeof apiKey !== 'string' ||
    apiKey.length === 0 ||
    typeof clientId !== 'string' ||
    clientId.length === 0
  ) {
    throw new TypeError('apiKey and clientId must be non-empty strings.');
  }

  return createAuthenticator(digest(apiKey), clientId);
}
