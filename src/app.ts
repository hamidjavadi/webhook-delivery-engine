import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import logger from './logger.ts';

const createApp = (): Express => {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'Unhandled application error');
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
};

export default createApp;
