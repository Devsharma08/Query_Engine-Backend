import { Request, Response } from 'express';
import { TranscriptService } from '../services/transcript.service';
import { translateText, detectLanguage } from '../utils/youtube-parser';
import { DataProcessorService } from '../services/data-processor.service';
import { YoutubeService } from '../services/google.service';

const transcriptService = new TranscriptService();
const dataProcessor = new DataProcessorService();
const youtubeService = new YoutubeService();

/**
 * Controller to fetch the full closed caption transcript of a video.
 * Automatically detects the source language and translates it to English using the translation utilities.
 * Streams progress and outcomes via Server-Sent Events (SSE).
 * 
 * @param req Express Request object containing `url` in the body
 * @param res Express Response object configured for SSE output
 */
export async function getVideoTranscript(req: Request, res: Response): Promise<void> {
   try {
      const { url } = req.body || {};
      
      // Initialize SSE stream headers
      res.status(200).writeHead(200, {
         "Content-Type": "text/event-stream",
         "Cache-Control": "no-cache, no-store, must-revalidate",
         "Pragma": "no-cache",
         "Expires": "0",
         "Connection": "keep-alive",
         "X-Accel-Buffering": "no"
      });

      if (!url) {
         res.write(`data:${JSON.stringify({ status: 'failure', message: 'Missing url parameter' })}\n\n`);
         res.end();
         return;
      }

      res.write(`data:${JSON.stringify({ status: 'progress', message: 'Fetching video transcript' })}\n\n`);
      const transcript = await transcriptService.getFullVideoTranscript(url);
      
      res.write(`data:${JSON.stringify({ status: 'progress', message: 'Detecting transcript language' })}\n\n`);
      const { language } = detectLanguage(transcript.fullCaptionText.substring(0, 500));
      console.log(`[transcriptController.getVideoTranscript] Detected language: ${language}`);
      
      res.write(`data:${JSON.stringify({ status: 'progress', message: 'Translating content to English' })}\n\n`);
      const targetLanguage = 'en';
      const translatedText = await translateText(transcript.fullCaptionText, targetLanguage);
      
      res.write(`data:${JSON.stringify({
         status: 'completed',
         success: true,
         ...transcript,
         translatedText
      })}\n\n`);
      
   } catch (error: any) {
      console.error("[transcriptController.getVideoTranscript] Error:", error.message);
      res.write(`data:${JSON.stringify({ status: 'failure', message: error.message })}\n\n`);
   } finally {
      res.end();
   }
}

/**
 * Controller to extract chapters, summary, and keyword tags from the video transcript.
 * Retrieves additional video description metadata via the YouTube Data API to use as an anchor context,
 * then streams outcomes progressively via Server-Sent Events (SSE).
 * 
 * @param req Express Request object containing `url` in the body
 * @param res Express Response object configured for SSE output
 */
export async function processTranscriptOutcomes(req: Request, res: Response): Promise<void> {
   try {
      const { url } = req.body || {};
      
      // Initialize SSE stream headers
      res.status(200).writeHead(200, {
         "Content-Type": "text/event-stream",
         "Cache-Control": "no-cache, no-store, must-revalidate",
         "Pragma": "no-cache",
         "Expires": "0",
         "Connection": "keep-alive",
         "X-Accel-Buffering": "no"
      });

      if (!url) {
         res.write(`data:${JSON.stringify({ status: 'failure', message: 'Missing video url parameter' })}\n\n`);
         res.end();
         return;
      }

      res.write(`data:${JSON.stringify({ status: 'progress', message: 'Fetching video transcript' })}\n\n`);
      const transcriptData = await transcriptService.getFullVideoTranscript(url);
      const rawText = transcriptData.fullCaptionText;

      res.write(`data:${JSON.stringify({ status: 'progress', message: 'Fetching video details' })}\n\n`);
      let videoDescription = "";
      try {
         const videoDetails = await youtubeService.getVideoById(transcriptData.videoId);
         videoDescription = videoDetails.description || "";
      } catch (err: any) {
         console.warn(`[transcriptController.processTranscriptOutcomes] Failed to fetch video details: ${err.message}`);
      }

      res.write(`data:${JSON.stringify({ status: 'progress', message: 'Extracting semantic keyword tags' })}\n\n`);
      const extractedTags = await dataProcessor.extractKeywords(rawText, 8, videoDescription);

      res.write(`data:${JSON.stringify({ status: 'progress', message: 'Generating auto chapters and titles' })}\n\n`);
      const autoChapters = await dataProcessor.generateAutoChapters(transcriptData.timelineSegments);

      res.write(`data:${JSON.stringify({
         status: 'completed',
         success: true,
         videoId: transcriptData.videoId,
         analytics: {
            suggestedTags: extractedTags,
            totalWordsProcessed: rawText.split(/\s+/).length,
            chapters: autoChapters
         }
      })}\n\n`);

   } catch (error: any) {
      console.error("[transcriptController.processTranscriptOutcomes] Error:", error.message);
      res.write(`data:${JSON.stringify({ status: 'failure', message: error.message })}\n\n`);
   } finally {
      res.end();
   }
}


