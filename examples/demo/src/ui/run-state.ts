import type { DemoScenarioId, DemoScenarioRequest } from '../scenarios.js';

export interface AttemptView {
  attemptNumber: number;
  attemptedAt: string;
  statusCode: number | null;
  latencyMs: number | null;
  outcome: string;
  error: string | null;
}

export interface ReceiverAttemptView {
  attemptNumber: number;
  receivedAt: string;
  timestamp: string;
  signature: string;
  eventId: string;
  contentBytes: number;
}

export interface DemoRunView {
  runId: string;
  eventId: string | null;
  idempotencyKey?: string;
  scenario: DemoScenarioId;
  createdAt: string;
  status: string;
  attemptCount?: number;
  nextRetryAt?: string | null;
  reason?: string | null;
  payload?: unknown;
  scenarioRequest?: DemoScenarioRequest;
  attempts: AttemptView[];
  receiverAttempts: ReceiverAttemptView[];
}

const TERMINAL_STATUSES = new Set(['delivered', 'failed', 'rejected']);

export function isRunActive(run: Pick<DemoRunView, 'status' | 'nextRetryAt'>): boolean {
  return !TERMINAL_STATUSES.has(run.status) || run.nextRetryAt != null;
}

export function pollRunOnce(
  runId: string,
  inFlight: Set<string>,
  refresh: () => Promise<void>,
): boolean {
  if (inFlight.has(runId)) return false;
  inFlight.add(runId);
  void refresh().finally(() => inFlight.delete(runId));
  return true;
}

export function replayRun(
  run: Pick<DemoRunView, 'scenario' | 'scenarioRequest'>,
  start: (scenario: DemoScenarioId, request: DemoScenarioRequest) => Promise<void>,
  createIdempotencyKey: () => string = () => `replay-${crypto.randomUUID()}`,
): boolean {
  if (run.scenarioRequest === undefined) return false;
  const request = run.scenarioRequest.scenario === 'custom'
    ? { ...run.scenarioRequest, idempotency_key: createIdempotencyKey() }
    : run.scenarioRequest;
  void start(run.scenario, request);
  return true;
}

export function mergeRunUpdate(current: DemoRunView, incoming: DemoRunView): DemoRunView {
  const currentIsSettled = !isRunActive(current);
  const incomingIsSettled = !isRunActive(incoming);
  if (currentIsSettled && !incomingIsSettled) return current;
  return {
    ...incoming,
    scenarioRequest: current.scenarioRequest,
  };
}
