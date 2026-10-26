import type { IngestionRequest } from 'webhook-delivery-engine';

type JsonValue = IngestionRequest['payload'];

export const DEMO_SCENARIOS = [
  { id: 'success', label: 'First try 200', description: 'Delivered on the first attempt.' },
  {
    id: 'retry-recovery',
    label: '503 retry recovery',
    description: 'Returns 503 once, then succeeds after the engine retry delay.',
  },
  { id: 'terminal-401', label: '401 terminal', description: 'A non-retryable response ends delivery.' },
  {
    id: 'max-retries',
    label: 'Max retries exceeded',
    description: 'Returns 503 until the engine marks the event failed.',
  },
  {
    id: 'ssrf-rejection',
    label: 'SSRF rejection',
    description: 'The engine rejects a fixed loopback destination before dispatch.',
  },
  { id: 'custom', label: 'Custom event', description: 'Send a bounded payload to the demo receiver.' },
] as const;

export type DemoScenarioId = (typeof DEMO_SCENARIOS)[number]['id'];

export const DEMO_SCENARIO_GROUPS: ReadonlyArray<{ title: string; ids: readonly DemoScenarioId[] }> = [
  { title: 'Reliability & Retries', ids: ['success', 'retry-recovery', 'max-retries'] },
  { title: 'Security & Guardrails', ids: ['terminal-401', 'ssrf-rejection'] },
];

export type DemoScenarioRequest =
  | { readonly scenario: Exclude<DemoScenarioId, 'custom'> }
  | {
      readonly scenario: 'custom';
      readonly idempotency_key: string;
      readonly payload: JsonValue;
    };

const scenarioIds = new Set<string>(DEMO_SCENARIOS.map(({ id }) => id));
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export function parseScenarioRequest(input: unknown): DemoScenarioRequest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Request must be a JSON object.');
  }

  const request = input as Record<string, unknown>;
  if (Object.keys(request).some((key) => !['scenario', 'idempotency_key', 'payload'].includes(key))) {
    throw new TypeError('Request contains unsupported fields.');
  }
  if (typeof request.scenario !== 'string' || !scenarioIds.has(request.scenario)) {
    throw new TypeError('Unknown demo scenario.');
  }

  if (request.scenario !== 'custom') {
    if ('payload' in request || 'idempotency_key' in request) {
      throw new TypeError('Predefined scenarios do not accept custom fields.');
    }
    return { scenario: request.scenario as Exclude<DemoScenarioId, 'custom'> };
  }

  if (
    typeof request.idempotency_key !== 'string' ||
    request.idempotency_key.trim().length === 0 ||
    request.idempotency_key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !isJsonValue(request.payload)
  ) {
    throw new TypeError('Custom events require a valid payload and idempotency key (max 128 chars).');
  }

  return {
    scenario: 'custom',
    idempotency_key: request.idempotency_key,
    payload: request.payload,
  };
}

export function getScenarioDestination(scenario: DemoScenarioId, publicOrigin: string): string {
  const origin = new URL(publicOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    isIpLiteral(origin.hostname) ||
    !origin.hostname.includes('.') ||
    origin.hostname === 'localhost'
  ) {
    throw new TypeError('Demo receiver must use a public HTTPS hostname.');
  }

  if (scenario === 'ssrf-rejection') {
    return 'https://127.0.0.1/api/mock-sink/ssrf-rejection';
  }

  return new URL(`/api/mock-sink/${scenario}`, origin).toString();
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.includes(':') || hostname.startsWith('[')) return true;
  const parts = hostname.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
}
