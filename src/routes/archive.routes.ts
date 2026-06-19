import { Router } from 'express';
import { getChatOrComments } from '../controllers/archive-chat.controller';

const router = Router();

router.post('/chat-or-comments', getChatOrComments);

export default router;