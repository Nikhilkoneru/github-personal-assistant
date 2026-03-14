import cors from 'cors';
import express from 'express';

import { env } from './config.js';
import attachmentRoutes from './routes/attachments.js';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import copilotRoutes from './routes/copilot.js';
import healthRoutes from './routes/health.js';
import modelRoutes from './routes/models.js';
import projectRoutes from './routes/projects.js';
import threadRoutes from './routes/threads.js';

const app = express();

app.use(
  cors({
    origin: env.clientOrigin === '*' ? true : env.clientOrigin,
  }),
);
app.use(express.json({ limit: '1mb' }));

app.use(healthRoutes);
app.use(authRoutes);
app.use(copilotRoutes);
app.use(attachmentRoutes);
app.use(modelRoutes);
app.use(projectRoutes);
app.use(threadRoutes);
app.use(chatRoutes);

app.listen(env.port, env.host, () => {
  console.log(`Github Personal Assistant API listening on http://${env.host}:${env.port}`);
  if (env.publicApiUrl) {
    console.log(`Advertised public API URL: ${env.publicApiUrl}`);
  }
});
