import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createWebhookEngine } from '../src/index.js';

const destinationUrl = 'https://93.184.216.34/hooks';
const directory = await mkdtemp(join(tmpdir(), 'webhook-ingestion-benchmark-'));
const nativeFetch = globalThis.fetch;
let dispatchAttempts = 0;
globalThis.fetch = async () => {
  dispatchAttempts += 1;
  throw new Error('The local ingestion benchmark does not allow dispatch.');
};
const engine = createWebhookEngine({
  databasePath: join(directory, 'events.sqlite'),
  clientId: 'benchmark-client',
  apiKey: 'benchmark-api-key',
  hmacSecret: 'benchmark-hmac-secret',
  defaultDestinationUrl: destinationUrl,
  logLevel: 'silent',
  config: {
    concurrency: { workerCount: 1, batchSize: 1, pollIntervalMs: 3_600_000 },
    timeoutLimitMs: 10_000,
    retry: { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 60_000 },
  },
});

function nearestRankP95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

async function enqueue(round: string, index: number): Promise<void> {
  const result = await engine.enqueue({
    idempotency_key: `benchmark-${round}-${index}`,
    payload: { round, index },
    destination_url: destinationUrl,
  });
  if (result.statusCode !== 202) {
    throw new Error(`Benchmark ingestion was rejected with status ${result.statusCode}.`);
  }
}

function assertNoDispatch(): void {
  if (dispatchAttempts > 0) {
    throw new Error('The scheduler dispatched during the ingestion benchmark.');
  }
}

try {
  await engine.start();
  // Let the scheduler finish its initial empty poll before inserting benchmark rows.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  for (let index = 0; index < 100; index += 1) {
    await enqueue('warmup', index);
  }
  assertNoDispatch();

  const roundP95Ms: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    const samples: number[] = [];
    for (let index = 0; index < 500; index += 1) {
      const startedAt = performance.now();
      await enqueue(`round-${round}`, index);
      samples.push(performance.now() - startedAt);
    }
    roundP95Ms.push(nearestRankP95(samples));
    assertNoDispatch();
  }

  const sortedRoundP95Ms = [...roundP95Ms].sort((left, right) => left - right);
  const medianP95Ms = sortedRoundP95Ms[1]!;
  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: 'embedded-enqueue-local-sqlite',
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        warmupSamples: 100,
        measuredSamples: 1_500,
        sampleCountPerRound: 500,
        dispatchAttempts,
        percentileMethod: 'nearest-rank',
        roundP95Ms,
        medianP95Ms,
        targetMs: 50,
        meetsTarget: medianP95Ms < 50,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await engine.stop();
  globalThis.fetch = nativeFetch;
  await rm(directory, { recursive: true, force: true });
}
