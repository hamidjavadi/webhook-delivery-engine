import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDevTunnel } from './dev-tunnel.js';

const envKeys = ['DEMO_USE_NGROK', 'DEMO_TUNNEL_TEST_VALUE'] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
let temporaryDirectory: string | undefined;

afterEach(async () => {
  for (const key of envKeys) {
    const originalValue = originalEnv.get(key);
    if (originalValue === undefined) delete process.env[key];
    else process.env[key] = originalValue;
  }
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe('development tunnel launcher', () => {
  it('sets tunnel mode and starts the server when no env file exists', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'demo-tunnel-'));
    process.env.DEMO_USE_NGROK = 'false';

    await startDevTunnel(join(temporaryDirectory, 'missing.env'));

    expect(process.env.DEMO_USE_NGROK).toBe('true');
    expect(process.env.DEMO_TUNNEL_TEST_VALUE).toBeUndefined();
  });

  it('loads an existing env file before setting tunnel mode and starting the server', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'demo-tunnel-'));
    const envFile = join(temporaryDirectory, '.env');
    await writeFile(envFile, 'DEMO_TUNNEL_TEST_VALUE=loaded\n');
    process.env.DEMO_USE_NGROK = 'false';

    await startDevTunnel(envFile);

    expect(process.env.DEMO_TUNNEL_TEST_VALUE).toBe('loaded');
    expect(process.env.DEMO_USE_NGROK).toBe('true');
  });
});
