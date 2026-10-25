import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const blockedIpv4Cidrs = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const;

const blockedIpv6Cidrs = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const;

/**
 * A destination URL validation result that never exposes DNS answers or
 * resolver error details.
 */
export type DestinationUrlValidationResult =
  | { readonly valid: true; readonly url: string }
  | {
      readonly valid: false;
      readonly reason:
        | 'invalid_url'
        | 'unsupported_protocol'
        | 'credentials_not_allowed'
        | 'unsafe_address'
        | 'dns_resolution_failed';
    };

/**
 * Internal delivery-only DNS result. Callers must not expose addresses in
 * public API results, logs, or persisted records.
 */
export type DestinationDispatchResolutionResult =
  | {
      readonly valid: true;
      readonly url: string;
      readonly hostname: string;
      readonly addresses: readonly string[];
    }
  | {
      readonly valid: false;
      readonly reason: Extract<DestinationUrlValidationResult, { valid: false }>['reason'];
    };

function ipv4ToBigInt(address: string): bigint {
  return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6ToBigInt(address: string): bigint {
  const halves = address.toLowerCase().split('::');
  const left = halves[0] === '' ? [] : halves[0]!.split(':');
  const right = halves.length === 2 && halves[1] !== '' ? halves[1]!.split(':') : [];
  const zeroGroups = 8 - left.length - right.length;
  const groups = [...left, ...Array.from({ length: zeroGroups }, () => '0'), ...right];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function isIpv4InCidr(address: string, network: string, prefixLength: number): boolean {
  const shift = BigInt(32 - prefixLength);
  return ipv4ToBigInt(address) >> shift === ipv4ToBigInt(network) >> shift;
}

function isIpv6InCidr(address: bigint, network: string, prefixLength: number): boolean {
  const networkAddress = ipv6ToBigInt(network);
  const shift = BigInt(128 - prefixLength);
  return address >> shift === networkAddress >> shift;
}

function isBlockedIpv4(address: string): boolean {
  return blockedIpv4Cidrs.some(([network, prefixLength]) =>
    isIpv4InCidr(address, network, prefixLength),
  );
}

function isBlockedIpv6(address: string): boolean {
  const addressValue = ipv6ToBigInt(address);
  const mappedIpv4Prefix = addressValue >> 32n;
  if (mappedIpv4Prefix === 0xffffn) {
    const embeddedIpv4 = Number(addressValue & 0xffffffffn);
    const ipv4Address = [
      (embeddedIpv4 >>> 24) & 0xff,
      (embeddedIpv4 >>> 16) & 0xff,
      (embeddedIpv4 >>> 8) & 0xff,
      embeddedIpv4 & 0xff,
    ].join('.');
    return isBlockedIpv4(ipv4Address);
  }

  // Only global-unicast IPv6 is eligible; this excludes unspecified, loopback,
  // ULA, link-local, multicast, and other non-global allocation ranges.
  if (!isIpv6InCidr(addressValue, '2000::', 3)) {
    return true;
  }

  return blockedIpv6Cidrs.some(([network, prefixLength]) =>
    isIpv6InCidr(addressValue, network, prefixLength),
  );
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isBlockedIpv4(address);
  }
  if (family === 6) {
    return isBlockedIpv6(address);
  }
  return true;
}

function hostnameFromUrl(url: URL): string {
  if (url.hostname.startsWith('[') && url.hostname.endsWith(']')) {
    return url.hostname.slice(1, -1);
  }
  return url.hostname;
}

async function resolveAddresses(hostname: string): Promise<readonly string[]> {
  const resolved = await lookup(hostname, { all: true, verbatim: true });
  return resolved.map(({ address }) => address);
}

function hasForbiddenUrlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f || character === '\\')
    );
  });
}

/**
 * Resolves and validates a destination immediately before HTTP dispatch.
 *
 * Only absolute HTTPS URLs without embedded credentials are accepted. Literal
 * addresses are classified without DNS; hostnames are rejected if any
 * resolved IPv4 or IPv6 address is unsafe. Hostname lookup requests every
 * address using Node DNS. Successful results include the vetted addresses for
 * the delivery connector to pin. This internal result must never be exposed
 * through the public API or logs.
 *
 * @param destinationUrl - Persisted destination URL for one dispatch attempt.
 * @returns A canonical URL and vetted addresses or a generic safe failure.
 */
export async function resolveDestinationForDispatch(
  destinationUrl: string,
): Promise<DestinationDispatchResolutionResult> {
  if (
    typeof destinationUrl !== 'string' ||
    destinationUrl.length === 0 ||
    destinationUrl !== destinationUrl.trim() ||
    hasForbiddenUrlCharacters(destinationUrl)
  ) {
    return { valid: false, reason: 'invalid_url' };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(destinationUrl);
  } catch {
    return { valid: false, reason: 'invalid_url' };
  }

  if (parsedUrl.protocol !== 'https:') {
    return { valid: false, reason: 'unsupported_protocol' };
  }
  const authority = /^https:\/\/([^/?#]*)/iu.exec(destinationUrl)?.[1];
  if (authority === undefined || authority.length === 0 || parsedUrl.hostname.length === 0) {
    return { valid: false, reason: 'invalid_url' };
  }
  if (authority.includes('@') || parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
    return { valid: false, reason: 'credentials_not_allowed' };
  }

  const hostname = hostnameFromUrl(parsedUrl);
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/u, '');
  if (normalizedHostname === 'localhost' || normalizedHostname.endsWith('.localhost')) {
    return { valid: false, reason: 'unsafe_address' };
  }

  const addressFamily = isIP(hostname);
  if (addressFamily !== 0) {
    return isBlockedAddress(hostname)
      ? { valid: false, reason: 'unsafe_address' }
      : { valid: true, url: parsedUrl.toString(), hostname, addresses: [hostname] };
  }

  let addresses: readonly string[];
  try {
    addresses = await resolveAddresses(hostname);
  } catch {
    return { valid: false, reason: 'dns_resolution_failed' };
  }
  if (addresses.length === 0) {
    return { valid: false, reason: 'dns_resolution_failed' };
  }
  if (addresses.some(isBlockedAddress)) {
    return { valid: false, reason: 'unsafe_address' };
  }

  return { valid: true, url: parsedUrl.toString(), hostname, addresses };
}

/**
 * Validates a destination URL before it can be persisted.
 *
 * @param destinationUrl - Untrusted destination URL supplied by a caller or configuration.
 * @returns A canonical URL on success or a generic safe failure reason.
 */
export async function validateDestinationUrl(
  destinationUrl: string,
): Promise<DestinationUrlValidationResult> {
  const result = await resolveDestinationForDispatch(destinationUrl);
  if (!result.valid) {
    return result;
  }
  return { valid: true, url: result.url };
}
