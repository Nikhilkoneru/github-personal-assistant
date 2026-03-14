import cors from 'cors';
import express from 'express';

import { env } from './config';
import attachmentRoutes from './routes/attachments';
import authRoutes from './routes/auth';
import chatRoutes from './routes/chat';
import copilotRoutes from './routes/copilot';
import healthRoutes from './routes/health';
import modelRoutes from './routes/models';
import projectRoutes from './routes/projects';
import threadRoutes from './routes/threads';

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
