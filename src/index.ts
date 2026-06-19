import express, { Request, Response } from 'express';
import dotenv from 'dotenv'
import cors from 'cors';


import vedioRouter from './routes/video.routes';
import archiveRouter from './routes/archive.routes';
import transcriptRouter from './routes/transcript.routes';
import aiRouter from './routes/ai.routes'

dotenv.config({
  path:'.env'
})

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
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
});