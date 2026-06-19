import { Request, Response } from "express";
import { extractVideoId, detectLanguage, translateText } from "../utils/youtube-parser";
import { YoutubeService } from "../services/google.service";
import { TranscriptService } from "../services/transcript.service";
import { getPastStreamerChat } from "./archive-chat.controller";
import { TimelineService } from "../services/timeline.service";
import { AiSummarizerService } from "../services/ai-summarizer.service";
import { EmbeddingService } from "../services/embedding.service";

const videoService = new YoutubeService();
const transcriptService = new TranscriptService();
const timelineService = new TimelineService();
const aiSummarizer = new AiSummarizerService();
const embeddingService = new EmbeddingService();

/**
 * Controller to fetch metadata details of a YouTube video and stream progress via SSE.
 */
export async function getVideoDetails(req: Request, res: Response): Promise<void> {
   try {
      const url = req.body.url;
      if (!url) {
         res.status(400).json({ message: "URL is required" });
         return;
      }

      res.status(200).writeHead(200, {
         "Content-Type": "text/event-stream",
         "Cache-Control": "no-cache, no-store, must-revalidate",
         "Pragma": "no-cache",
         "Expires": "0",
         "Connection": "keep-alive",
         "X-Accel-Buffering": "no"
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
 * Controller to compile subtitle & chat timelines, translate if needed, generate 
 * 2-minute blocks, generate semantic vector embeddings, and stream results via SSE.
 */
export async function analyzeVideo(req: Request, res: Response): Promise<void> {
   try {
      const { url, channelLink } = req.body;
      if (!url) {
         res.status(400).json({ message: "URL is required" });
         return;
      }

      res.status(200).writeHead(200, {
         "Content-Type": "text/event-stream",
         "Cache-Control": "no-cache, no-store, must-revalidate",
         "Pragma": "no-cache",
         "Expires": "0",
         "Connection": "keep-alive",
         "X-Accel-Buffering": "no"
      });

      res.write(`data:${JSON.stringify({ message: "Starting analysis..." })}\n\n`);
      const videoId = extractVideoId(url);
      if (!videoId) {
         res.write(`data:${JSON.stringify({ status: "error", message: "Invalid URL" })}\n\n`);
         res.end();
         return;
      }

      res.write(`data:${JSON.stringify({ message: "Fetching video details" })}\n\n`);
      const videoDetails = await videoService.getVideoById(videoId);
      const videoStartTime = videoDetails.isLiveStream?.actualStartTime || videoDetails.publishedAt;

      res.write(`data:${JSON.stringify({ message: "Fetching transcript and chat replay" })}\n\n`);
      let transcriptData: any = null;
      let commentsOrChat: any[] = [];

      try {
         transcriptData = await transcriptService.getFullVideoTranscript(url);
      } catch (err: any) {
         console.warn(`[videoController.analyzeVideo] Subtitle scraper fallback warning: ${err.message}`);
      }

      const isLiveStream = !!videoDetails.isLiveStream;
      const activeLiveChatId = videoDetails.isLiveStream?.activeLiveChatId || null;

      // 1. Fetch active livestream chat if streaming is currently live
      if (activeLiveChatId) {
         try {
            res.write(`data:${JSON.stringify({ message: "Fetching active chat" })}\n\n`);
            const liveMessages = await videoService.getActiveLiveChatMessages(activeLiveChatId);
            commentsOrChat = liveMessages.filter((msg: any) => msg.is_streamer);
         } catch (err: any) {
            console.error(`[videoController.analyzeVideo] Failed to fetch active chat: ${err.message}`);
         }
      }

      // 2. Scrape live chat replay logs if live stream has completed
      if (commentsOrChat.length === 0 && isLiveStream) {
         try {
            res.write(`data:${JSON.stringify({ message: "Fetching completed chat replay" })}\n\n`);
            const chatReplay = await getPastStreamerChat(url);
            commentsOrChat = chatReplay.filter((msg: any) => msg.is_streamer);
         } catch (err: any) {
            console.warn(`[videoController.analyzeVideo] Failed completed chat scrape: ${err.message}`);
         }
      }

      // 3. Fallback to standard comments if no active live chat or replay chat was found
      if (commentsOrChat.length === 0) {
         try {
            console.log(`[videoController.analyzeVideo] Fetching standard comments fallback for ID ${videoId}`);
            res.write(`data:${JSON.stringify({ message: "Fetching standard comments" })}\n\n`);
            const regularComments = await videoService.getAllPastLiveComments(videoId, videoDetails.channelId);
            commentsOrChat = regularComments.filter(
               (c: any) => c.isStreamer || (c.replies && c.replies.some((r: any) => r.isStreamer))
            );
         } catch (err: any) {
            console.error(`[videoController.analyzeVideo] Failed standard comment fallback: ${err.message}`);
         }
      }

      res.write(`data:${JSON.stringify({ message: "Compiling timeline" })}\n\n`);
      const compiledEvents = timelineService.compileTimeline(
         transcriptData?.timelineSegments || [],
         commentsOrChat,
         videoStartTime,
         channelLink
      );

      // Translate timeline messages to English if non-English language is detected
      if (compiledEvents.length > 0) {
         const sampleText = compiledEvents.slice(0, 10).map(e => e.message).join(" ");
         const { language } = detectLanguage(sampleText);
         
         if (language !== 'en') {
            res.write(`data:${JSON.stringify({ message: "Translating timeline to English" })}\n\n`);
            console.log(`[videoController.analyzeVideo] Non-English language detected: "${language}". Translating...`);
            const messagesToTranslate = compiledEvents.map(e => e.message);
            try {
               const delimiter = " || ";
               const combinedText = messagesToTranslate.join(delimiter);
               const translatedTextCombined = await translateText(combinedText, 'en');
               const translatedMessages = translatedTextCombined.split(/\s*\|\|\s*/);
               
               for (let i = 0; i < compiledEvents.length; i++) {
                  if (translatedMessages[i]) {
                     compiledEvents[i].message = translatedMessages[i].trim();
                  }
               }
               console.log(`[videoController.analyzeVideo] Successfully translated ${compiledEvents.length} events.`);
            } catch (err: any) {
               console.error(`[videoController.analyzeVideo] Timeline translation failed: ${err.message}. Keeping original.`);
            }
         }
      }

      res.write(`data:${JSON.stringify({ message: "Generating timeline blocks" })}\n\n`);
      const timelineBlocks = timelineService.generateTimelineBlocks(compiledEvents);
      
      // Calculate local vector embeddings for blocks
      try {
         res.write(`data:${JSON.stringify({ message: "Generating semantic vector embeddings" })}\n\n`);
         await embeddingService.embedBlocks(timelineBlocks);
      } catch (embErr: any) {
         console.warn(`[videoController.analyzeVideo] Semantic embedding generation skipped: ${embErr.message}`);
      }

      const markdownTimeline = timelineService.generateMarkdownTimeline(compiledEvents);

      // Summarize full transcript text
      let summary = "No summary generated.";
      if (transcriptData?.fullCaptionText) {
         try {
            res.write(`data:${JSON.stringify({ message: "Summarizing full context" })}\n\n`);
            summary = await aiSummarizer.generateSummary(transcriptData.fullCaptionText);
         } catch (err: any) {
            console.warn(`[videoController.analyzeVideo] Summary API failed: ${err.message}`);
         }
      }

      res.write(`data:${JSON.stringify({
         success: true,
         videoId,
         videoDetails,
         summary,
         timelineBlocks,
         markdownTimeline,
         totalEvents: compiledEvents.length
      })}\n\n`);
      res.end();

   } catch (error: any) {
      console.error("[videoController.analyzeVideo] Ingestion pipeline crashed:", error);
      res.write(`data:${JSON.stringify({ status: "error", message: error.message })}\n\n`);
      res.end();
   }
}
