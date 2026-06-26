import express, { Request, Response } from 'express';
import dotenv from 'dotenv'
import cors from 'cors';
import { setGlobalDispatcher, Agent } from 'undici';
import { exec } from 'child_process';

// Increase fetch timeouts globally to prevent HeadersTimeoutError (UND_ERR_HEADERS_TIMEOUT)
// when waiting for local Ollama LLM inference/embedding generations.
setGlobalDispatcher(new Agent({
  connectTimeout: 60000,
  headersTimeout: 300000,
  bodyTimeout: 300000,
}));

import vedioRouter from './routes/video.routes';
import archiveRouter from './routes/archive.routes';
import transcriptRouter from './routes/transcript.routes';
import aiRouter from './routes/ai.routes'

import {apiReference} from '@scalar/express-api-reference';
import { getOpenAPIDocument } from './utils/openapi';

dotenv.config({
  path:'.env'
})

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());

app.use('/reference',apiReference({
  spec:{
    content:getOpenAPIDocument(),
  }
}));

app.use(cors({
  origin:'http://localhost:3000'
}))
app.use('/api/video',vedioRouter);
app.use('/api/archive',archiveRouter);
app.use('/api',transcriptRouter);
app.use('/api/ai',aiRouter);

app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend server successfully running on http://localhost:${PORT}`);
  
  // Dynamically update yt-dlp and yt-dlp-ejs to the latest versions on startup in the background
  console.log('[Startup] Checking and updating yt-dlp and yt-dlp-ejs inside the container...');
  exec('pip install --upgrade yt-dlp yt-dlp-ejs', (error, stdout, stderr) => {
    if (error) {
      console.error('[Startup] Failed to auto-update yt-dlp:', error);
      return;
    }
    console.log('[Startup] yt-dlp update success:', stdout.trim());
    if (stderr) {
      console.warn('[Startup] yt-dlp update warning/info:', stderr.trim());
    }
  });
});
