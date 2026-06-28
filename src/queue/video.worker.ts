import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { redisConnection } from './connection';
import { extractVideoId, detectLanguage, translateText } from "../utils/youtube-parser";
import { YoutubeService } from "../services/google.service";
import { TranscriptService } from "../services/transcript.service";
import { TimelineService } from "../services/timeline.service";
import { AiSummarizerService } from "../services/ai-summarizer.service";
import { EmbeddingService } from "../services/embedding.service";
import { getPastStreamerChat } from "../controllers/archive-chat.controller";

// Establish a dedicated Redis connection to publish progress updates
const pubClient = new Redis({
  host: (redisConnection as any).host,
  port: (redisConnection as any).port,
});

const videoService = new YoutubeService();
const transcriptService = new TranscriptService();
const timelineService = new TimelineService();
const aiSummarizer = new AiSummarizerService();
const embeddingService = new EmbeddingService();

/**
 * BullMQ Worker instance processing the 'video-analysis' queue jobs.
 * Executes steps sequentially:
 * 1. Metadata fetching
 * 2. Transcript closed caption retrieval
 * 3. Replay chat scraping (with fallback strategies: active chat -> chat scraping -> comment threads)
 * 4. Merging chronology and translating items to English
 * 5. Formatting into fixed timeline blocks
 * 6. Generating vector representations (embeddings)
 * 7. Running AI summary extraction
 * 8. Publishing progress update events onto Redis channels
 */
export const videoWorker = new Worker('video-analysis', async (job: Job) => {
  const { url, channelLink } = job.data;
  const jobId = job.id!;

  /**
   * Helper to broadcast status changes back to the subscribing SSE handler.
   */
  const publishLog = async (data: object) => {
    await pubClient.publish(`job-progress:${jobId}`, JSON.stringify(data));
  };

  try {
    await publishLog({ message: "Extracting video ID..." });
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error("Invalid YouTube URL provided.");
    }

    await publishLog({ message: "Fetching video metadata..." });
    const videoDetails = await videoService.getVideoById(videoId);
    const videoStartTime = videoDetails.isLiveStream?.actualStartTime || videoDetails.publishedAt;

    await publishLog({ message: "Fetching video transcript..." });
    let transcriptData: any = null;
    try {
      transcriptData = await transcriptService.getFullVideoTranscript(url);
    } catch (err: any) {
      console.warn(`[Worker Job ${jobId}] Transcript fallback warning: ${err.message}`);
    }

    const isLiveStream = !!videoDetails.isLiveStream;
    const activeLiveChatId = videoDetails.isLiveStream?.activeLiveChatId || null;
    let commentsOrChat: any[] = [];

    // Fallback Sequence 1: Extract chat messages from active live stream session
    if (activeLiveChatId) {
      await publishLog({ message: "Fetching active live chat..." });
      try {
         const liveMessages = await videoService.getActiveLiveChatMessages(activeLiveChatId);
         commentsOrChat = liveMessages.filter((msg: any) => msg.is_streamer);
      } catch (err: any) {
         console.error(`[Worker Job ${jobId}] Active chat fetch failed: ${err.message}`);
      }
    }

    // Fallback Sequence 2: Scrape replay chat logs if live stream is completed
    if (commentsOrChat.length === 0 && isLiveStream) {
      await publishLog({ message: "Fetching completed livestream chat replay..." });
      try {
         const chatReplay = await getPastStreamerChat(url);
         commentsOrChat = chatReplay.filter((msg: any) => msg.is_streamer);
      } catch (err: any) {
         console.warn(`[Worker Job ${jobId}] Completed chat scrape failed: ${err.message}`);
      }
    }

    // Fallback Sequence 3: Retrieve public comments threads if scraping fails
    if (commentsOrChat.length === 0) {
      await publishLog({ message: "Fetching standard comments fallback..." });
      try {
         const regularComments = await videoService.getAllPastLiveComments(videoId, videoDetails.channelId || undefined);
         commentsOrChat = regularComments.filter(
           (c: any) => c.isStreamer || (c.replies && c.replies.some((r: any) => r.isStreamer))
         );
      } catch (err: any) {
         console.error(`[Worker Job ${jobId}] Standard comments fallback failed: ${err.message}`);
      }
    }

    await publishLog({ message: "Compiling video and chat timeline..." });
    const compiledEvents = timelineService.compileTimeline(
      transcriptData?.timelineSegments || [],
      commentsOrChat,
      videoStartTime,
      channelLink
    );

    // Apply translation to English if the events contain foreign language elements
    if (compiledEvents.length > 0) {
      const sampleText = compiledEvents.slice(0, 10).map(e => e.message).join(" ");
      const { language } = detectLanguage(sampleText);
      
      if (language !== 'en') {
        await publishLog({ message: "Translating timeline events to English..." });
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
        } catch (err: any) {
          console.error(`[Worker Job ${jobId}] Translation failed: ${err.message}`);
        }
      }
    }

    await publishLog({ message: "Structuring chronological timeline blocks..." });
    const timelineBlocks = timelineService.generateTimelineBlocks(compiledEvents);
    
    // Attempt local high-dimensional vector embedding generation
    try {
      await publishLog({ message: "Generating local vector embeddings..." });
      await embeddingService.embedBlocks(timelineBlocks);
    } catch (embErr: any) {
      console.warn(`[Worker Job ${jobId}] Vector embeddings skipped: ${embErr.message}`);
    }

    const markdownTimeline = timelineService.generateMarkdownTimeline(compiledEvents);

    // Run AI summarizing tasks
    let summary = "No summary generated.";
    if (transcriptData?.fullCaptionText) {
      await publishLog({ message: "Generating analytical summary..." });
      try {
        summary = await aiSummarizer.generateSummary(transcriptData.fullCaptionText);
      } catch (err: any) {
        console.warn(`[Worker Job ${jobId}] Summary generation failed: ${err.message}`);
      }
    }

    // Publish completion message with structured outputs
    await publishLog({
      success: true,
      videoId,
      videoDetails,
      summary,
      timelineBlocks,
      markdownTimeline,
      totalEvents: compiledEvents.length
    });

  } catch (error: any) {
    console.error(`[Worker Job ${jobId}] Error processing job:`, error.message);
    await publishLog({ status: "error", message: error.message });
    throw error;
  }
}, { connection: redisConnection });

