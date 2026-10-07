import dotenv from 'dotenv';
import path from 'node:path';
import type { AppConfig, Environment, LogLevel } from './types/config.ts';

dotenv.config();

const config: AppConfig = {
  environment: (process.env.NODE_ENV as Environment) || 'development',
  port: Number(process.env.PORT) || 3000,
  databaseUrl:
    process.env.DATABASE_URL || path.resolve(process.cwd(), 'src', 'data', 'webhook_engine.db'),
  logLevel: (process.env.LOG_LEVEL as LogLevel) || 'info',
};

export default config;
