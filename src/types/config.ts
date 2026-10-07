export interface AppConfig {
  environment: Environment;
  databaseUrl: string;
  logLevel: LogLevel;
  port: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Environment = 'development' | 'production' | 'test';
