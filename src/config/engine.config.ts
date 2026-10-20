import type { EngineConfig, EngineEnvironment } from '../core/types.js';

export const defaultEngineConfig: Readonly<EngineConfig> = {
  nodeEnv: (process.env.NODE_ENV as EngineEnvironment | undefined) ?? 'development',
  maxAttempts: 5,
  timeoutMs: 10_000,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  pollIntervalMs: 1_000,
  batchSize: 10,
  requireHttps: true,
  allowedHosts: ['example.com'],
  logLevel: 'info',
};

export function createEngineConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  const config: EngineConfig = {
    ...defaultEngineConfig,
    ...overrides,
    allowedHosts: overrides.allowedHosts ?? defaultEngineConfig.allowedHosts,
  };

  if (config.maxAttempts < 1) {
    throw new Error('Engine config maxAttempts must be at least 1.');
  }

  if (config.timeoutMs < 1) {
    throw new Error('Engine config timeoutMs must be at least 1.');
  }

  if (config.baseBackoffMs < 1) {
    throw new Error('Engine config baseBackoffMs must be at least 1.');
  }

  if (config.maxBackoffMs < config.baseBackoffMs) {
    throw new Error('Engine config maxBackoffMs must be greater than or equal to baseBackoffMs.');
  }

  if (config.batchSize < 1) {
    throw new Error('Engine config batchSize must be at least 1.');
  }

  if (config.pollIntervalMs < 100) {
    throw new Error('Engine config pollIntervalMs must be at least 100 ms.');
  }

  return config;
}
