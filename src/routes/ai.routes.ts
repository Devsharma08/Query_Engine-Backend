import { Router } from 'express';
import { summarizeTranscript, queryVideoTimeline } from '../controllers/ai.controller';

const router = Router();

router.post('/summarize', summarizeTranscript);
router.post('/query', queryVideoTimeline);

export default router;
