import { Request, Response } from "express";
import Redis from 'ioredis';
import { extractVideoId } from "../utils/youtube-parser";
import { YoutubeService } from "../services/google.service";
import { videoQueue } from "../queue/video.queue";
import { redisConnection } from "../queue/connection";

const videoService = new YoutubeService();

/**
 * Controller to fetch basic metadata details of a YouTube video.
 * Streams intermediate states and the final metadata JSON payload back to the client using Server-Sent Events (SSE).
 * 
 * @param req Express Request object containing `url` in the body
 * @param res Express Response object configured for event-stream output
 */
export async function getVideoDetails(req: Request, res: Response): Promise<void> {
   try {
      const url = req.body?.url;
      if (!url) {
         res.status(400).json({ message: "URL is required" });
         return;
      }

      // Configure response headers for Server-Sent Events (SSE)
      res.status(200).writeHead(200, {
         "Content-Type": "text/event-stream",
         "Cache-Control": "no-cache, no-store, must-revalidate",
         "Pragma": "no-cache",
         "Expires": "0",
         "Connection": "keep-alive",
         "X-Accel-Buffering": "no" // Disable buffering on Nginx/reverse proxies
      });

      res.write(`data:${JSON.stringify({ message: "Extracting video ID..." })}\n\n`);
      const videoId = extractVideoId(url);
      if (!videoId) {
         res.write(`data:${JSON.stringify({ status: "error", message: "Invalid URL" })}\n\n`);
         res.end();
         return;
      }

      res.write(`data:${JSON.stringify({ message: "Fetching metadata from YouTube Data API..." })}\n\n`);
      const video = await videoService.getVideoById(videoId);

      res.write(`data:${JSON.stringify({
         success: true,
         video
      })}\n\n`);
      res.end();
      
   } catch (error: any) {
      console.error("[videoController.getVideoDetails] Error:", error.message);
      res.write(`data:${JSON.stringify({ status: "error", message: error.message })}\n\n`);
      res.end();
   }
}

/**
 * Controller to orchestrate background video ingestion and analysis.
 * Pushes a job onto the BullMQ 'video-analysis' queue, spins up a dedicated Redis Pub/Sub listener,
 * and streams real-time processing logs back over a Server-Sent Events (SSE) stream.
 * Automatically unsubscribes and quits the Redis connection upon completion, error, or client cancellation.
 * 
 * @param req Express Request object containing `url` and `channelLink`
 * @param res Express Response object configured for event-stream output
 */
export async function analyzeVideo(req: Request, res: Response): Promise<void> {
   try {
      const { url, channelLink } = req.body || {};
      if (!url) {
         res.status(400).json({ message: "URL is required" });
         return;
      }

      // Initialize SSE stream headers instantly to avoid browser timeouts
      res.status(200).writeHead(200, {
         "Content-Type": "text/event-stream",
         "Cache-Control": "no-cache, no-store, must-revalidate",
         "Pragma": "no-cache",
         "Expires": "0",
         "Connection": "keep-alive",
         "X-Accel-Buffering": "no"
      });

      res.write(`data:${JSON.stringify({ message: "Queueing task..." })}\n\n`);

      // Enqueue processing job in BullMQ
      const job = await videoQueue.add('analyze', { url, channelLink });
      const jobId = job.id!;

      // Connect a dedicated Redis subscriber client for this unique job channel
      const subClient = new Redis({
         host: (redisConnection as any).host,
         port: (redisConnection as any).port,
      });

      await subClient.subscribe(`job-progress:${jobId}`);

      // Handle progress events published by the BullMQ worker
      subClient.on('message', (channel, message) => {
         // Pipe log text directly to the SSE HTTP stream
         res.write(`data:${message}\n\n`);

         const parsed = JSON.parse(message);
         // Clean up connection if job completed successfully or crashed
         if (parsed.success || parsed.status === "error") {
            subClient.unsubscribe(`job-progress:${jobId}`);
            subClient.quit();
            res.end();
         }
      });

      // Prevent memory leaks if the client prematurely disconnects/aborts the HTTP request
      req.on('close', () => {
         subClient.unsubscribe(`job-progress:${jobId}`);
         subClient.quit();
      });

   } catch (error: any) {
      console.error("[videoController.analyzeVideo] Queueing crash:", error);
      res.write(`data:${JSON.stringify({ status: "error", message: error.message })}\n\n`);
      res.end();
   }
}

