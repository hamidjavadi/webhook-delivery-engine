import pino from 'pino';
import config from './config.ts';

const logger = pino({
  level: config.logLevel || 'info',
  transport:
    config.environment === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

export default logger;
