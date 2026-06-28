import { Router } from "express";
import { getVideoDetails, analyzeVideo } from "../controllers/video.controller";

const route = Router();

/**
 * Route to fetch metadata details of a YouTube video (SSE stream).
 */
route.post('/detail', getVideoDetails);

/**
 * Route to trigger background video analysis, connecting to BullMQ and streaming progress updates (SSE stream).
 */
route.post('/analyze', analyzeVideo);

export default route;

