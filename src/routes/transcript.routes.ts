import { Router } from 'express';
import { getVideoTranscript, processTranscriptOutcomes } from '../controllers/transcript.controller';

const router = Router();

/**
 * Route to fetch and translate the video closed caption transcript.
 * Handled as a Server-Sent Events (SSE) stream.
 */
router.post('/transcript', getVideoTranscript);

/**
 * Route to extract semantic analytical outcomes (chapters, keywords, stats) from video transcript.
 * Handled as a Server-Sent Events (SSE) stream.
 */
router.post('/process-outcomes', processTranscriptOutcomes);

export default router;