import { Router } from 'express';
import { summarizeTranscript, queryVideoTimeline } from '../controllers/ai.controller';

const router = Router();

/**
 * Route to generate a progressive analytical summary of a video transcript.
 * Handled as a Server-Sent Events (SSE) stream.
 */
router.post('/summarize', summarizeTranscript);

/**
 * Route to query specific milestones or topics from the video transcript using RAG.
 * Handled as a Server-Sent Events (SSE) stream.
 */
router.post('/query', queryVideoTimeline);

export default router;

