import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const defaultEnvFile = fileURLToPath(new URL('../.env', import.meta.url));

export async function startDevTunnel(envFile = defaultEnvFile): Promise<void> {
  if (existsSync(envFile)) loadEnvFile(envFile);
  process.env.DEMO_USE_NGROK = 'true';
  await import('./server.js');
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) await startDevTunnel();
