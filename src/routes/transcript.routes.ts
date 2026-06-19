import { Router } from 'express';
import { getVideoTranscript, processTranscriptOutcomes } from '../controllers/transcript.controller';

const router = Router();

router.post('/transcript', getVideoTranscript);
router.post('/process-outcomes', processTranscriptOutcomes);

export default router;