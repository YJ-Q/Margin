import express from 'express';
import cors from 'cors';
import achievementRoutes from './routes/achievementRoutes.js';
import actionRoutes from './routes/actionRoutes.js';
import chatRoutes from './routes/chatRoutes.js';
import learningRoutes from './routes/learningRoutes.js';
import managementRoutes from './routes/managementRoutes.js';
import memoryRoutes from './routes/memoryRoutes.js';
import stateRoutes from './routes/stateRoutes.js';
import summaryRoutes from './routes/summaryRoutes.js';
import ttsRoutes from './routes/ttsRoutes.js';
import { sendData, sendError } from './lib/apiResponse.js';
import { healthPayload } from './surfaceHealth.js';
import { createRequestLogger } from './lib/logger.js';
import { ensureMemoryStore } from './storage/memoryStore.js';

export async function createApp({ logger } = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  if (logger) {
    app.use(createRequestLogger(logger));
  }
  await ensureMemoryStore();

  app.get('/api', (_req, res) => {
    const ttsAvailable = Boolean(process.env.SILICONFLOW_API_KEY);
    sendData(res, {
      name: 'Margin',
      status: 'api-ready',
      message: 'Margin API is running.',
      endpoints: ['/health', '/state', '/actions', '/chat', '/memory', '/summary', '/learning', '/management', '/achievements', '/tts'],
      capabilities: { tts: ttsAvailable }
    });
  });

  app.get('/health', (_req, res) => {
    // Deprecated, but it answers in the same shape as every other surface: a consumer that reaches it
    // by mistake should be able to see which surface it actually hit.
    sendData(res, healthPayload({ surface: 'legacy-rest' }));
  });

  app.use('/chat', chatRoutes);
  app.use('/state', stateRoutes);
  app.use('/actions', actionRoutes);
  app.use('/achievements', achievementRoutes);
  app.use('/learning', learningRoutes);
  app.use('/management', managementRoutes);
  app.use('/memory', memoryRoutes);
  app.use('/summary', summaryRoutes);
  app.use('/tts', ttsRoutes);

  app.use((err, req, res, _next) => {
    if (logger) {
      logger.error(err.message || 'Unhandled Margin error', {
        request_id: req.requestId,
        code: err.code || 'internal_error',
        status: err.status || 500
      });
    } else {
      console.error(err);
    }
    sendError(
      res,
      err.status || 500,
      err.message || 'Margin became quiet for a moment.',
      err.code || 'internal_error'
    );
  });

  return app;
}
