import { Router } from 'express';
import { getChatOrComments } from '../controllers/archive-chat.controller';

const router = Router();

/**
 * Route to fetch chat replays, active live chat comments, or standard public comments.
 * Returns a JSON payload containing comment data and pagination details.
 */
router.post('/chat-or-comments', getChatOrComments);

export default router;