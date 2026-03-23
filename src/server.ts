import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import { prisma } from './prisma.js';
import { chatRouter } from './chat/chatRouter.js';
import { keysRouter } from './keys/keysRouter.js';
import { statsRouter } from './stats/statsRouter.js';

const app = express();

app.set('trust proxy', true);

app.use(express.json());

app.use('/chat', chatRouter);
app.use('/keys', keysRouter);
app.use('/stats', statsRouter);

app.get('/health', async (_: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'healthy', database: 'connected' });
  } catch {
    res.status(503).json({ status: 'unhealthy', database: 'disconnected' });
  }
});

const port = process.env.PORT || '8000';

const server = app.listen(port, async () => {
  console.log(`Server listening at http://localhost:${port}`);
  console.log(`Proxying to LLM at ${process.env.FETCH_URL || 'http://localhost:8000/v1/chat/completions'}`);

  try {
    await prisma.$connect();
    console.log('Database connected successfully');
  } catch (error) {
    console.error('Failed to connect to database:', error);
    process.exit(1);
  }
});

const gracefulShutdown = async () => {
  console.log('Shutting down gracefully...');

  server.close(async () => {
    console.log('HTTP server closed');
    await prisma.$disconnect();
    console.log('Database disconnected');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
