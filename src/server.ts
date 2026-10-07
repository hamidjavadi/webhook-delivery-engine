import createApp from './app.ts';
import config from './config.ts';
import logger from './logger.ts';
import createDatabase from './storage/db.ts';

const app = createApp();
const db = createDatabase(config.databaseUrl);

const server = app.listen(config.port, () => {
  logger.info(`Server listening on port ${config.port} [${config.environment}]`);
});

// Graceful Shutdown
function gracefulShutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  server.close(() => {
    logger.info('HTTP server closed.');
    try {
      db.close();
      logger.info('Database connection closed.');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error closing database connection.');
      process.exit(1);
    }
  });

  // Force shutdown if stuck
  setTimeout(() => {
    logger.error('Forcefully terminating process due to shutdown timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
