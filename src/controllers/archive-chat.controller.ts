import { Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { extractVideoId, generateChannelId } from '../utils/youtube-parser';
import { YoutubeService } from '../services/google.service';

const videoService = new YoutubeService();

/**
 * Runs Python sub-process to pull live chat replays for completed streams using chat-downloader.
 */
export async function getPastStreamerChat(url: string): Promise<any[]> {
   return new Promise((resolve, reject) => {
      let pythonPath = 'python';
      const venvWin = path.join(process.cwd(), '..', '.venv', 'Scripts', 'python.exe');
      const venvUnix = path.join(process.cwd(), '..', '.venv', 'bin', 'python');

      if (fs.existsSync(venvWin)) {
         pythonPath = venvWin;
      } else if (fs.existsSync(venvUnix)) {
         pythonPath = venvUnix;
      }

      const pythonProcess = spawn(pythonPath, [
         'src/utils/fetch_archive_chat.py',
         url
      ]);

      const timeoutId = setTimeout(() => {
         console.warn(`[archiveChatController.getPastStreamerChat] Python execution timed out. Terminating.`);
         pythonProcess.kill();
         reject(new Error('Python execution timed out'));
      }, 10000);

      let resultData = '';
      pythonProcess.stdout.on('data', (data) => {
         resultData += data.toString();
      });

      pythonProcess.stderr.on('data', (code) => {
         console.error('[archiveChatController.getPastStreamerChat] Script stderr:', code.toString());
      });

      pythonProcess.on('close', (code) => {
         clearTimeout(timeoutId);
         if (code !== 0) {
            reject(new Error(`python script exited with code ${code}`));
            return;
         }
         try {
            const comments = JSON.parse(resultData);
            resolve(comments);
         } catch (parseError) {
            console.error('[archiveChatController.getPastStreamerChat] JSON Parse error:', parseError);
            reject(new Error('Failed to parse comments'));
         }
      });
   });
}

/**
 * Controller to fetch either active live chat messages, completed chat replays, 
 * or standard fallback comments for a given stream URL.
 */
export async function getChatOrComments(req: Request, res: Response): Promise<void> {
   try {
      const { url, channelLink, onlyStreamerChat } = req.body || {};
      const videoId = extractVideoId(url);
      if (!videoId) {
         res.status(400).json({ error: 'Missing standard stream url address parameter' });
         return;
      }

      let activeLiveChatId: string | null = null;
      let isLiveStream = false;
      let liveStatus: string | null = null;
      let commentCount = 0;
      let videoDetails: any = null;
      let metadataFetched = false;

      try {
         videoDetails = await videoService.getVideoById(videoId);
         console.log(`[archiveChatController.getChatOrComments] Video Details:`, JSON.stringify(videoDetails, null, 2));
         metadataFetched = true;
         commentCount = videoDetails.commentCount ? Number(videoDetails.commentCount) : 0;
         if (videoDetails.isLiveStream) {
            isLiveStream = true;
            liveStatus = videoDetails.isLiveStream.status;
            if (videoDetails.isLiveStream.activeLiveChatId) {
               activeLiveChatId = videoDetails.isLiveStream.activeLiveChatId;
            }
         }
      } catch (err: any) {
         console.warn(`[archiveChatController.getChatOrComments] Could not get details via API: ${err.message}`);
         isLiveStream = true; 
      }

      // If active, stream live messages directly via YouTube API
      if (activeLiveChatId) {
         try {
            let liveMessages = await videoService.getActiveLiveChatMessages(activeLiveChatId);
            if (onlyStreamerChat) {
               liveMessages = liveMessages.filter((msg: any) => msg.is_streamer);
            }
            res.json({
               type: "active_live_chat",
               totalChatCount: liveMessages.length,
               streamerCommentCount: liveMessages.length,
               data: liveMessages
            });
            return;
         } catch (liveChatErr: any) {
            console.error(`[archiveChatController.getChatOrComments] Failed live fetch fallback: ${liveChatErr.message}`);
         }
      }

      let fullPastChatLogs: any = [];
      let regularComments: any[] = [];
      const streamerChannelId = channelLink ? generateChannelId(channelLink) : undefined;

      if (metadataFetched) {
         const isLive = isLiveStream;
         const hasComments = commentCount > 0;

         if (!isLive && !hasComments) {
            console.log(`[archiveChatController.getChatOrComments] Standard video with 0 comments. Returning empty array.`);
            res.json({
               type: 'standard_video_comments',
               totalCommentsScanned: 0,
               streamerCommentCount: 0,
               data: []
            });
            return;
         }

         if (isLive) {
            // Live stream (active fallback or completed)
            try {
               console.log(`[archiveChatController.getChatOrComments] Video is a livestream (${liveStatus}). Invoking python scraper.`);
               fullPastChatLogs = await getPastStreamerChat(url);
            } catch (error: any) {
               console.warn(`[archiveChatController.getChatOrComments] Could not fetch chat replay: ${error.message}`);
            }

            if (hasComments) {
               try {
                  console.log(`[archiveChatController.getChatOrComments] Fetching standard comments for ${videoId} (commentCount: ${commentCount})`);
                  regularComments = await videoService.getAllPastLiveComments(videoId, streamerChannelId);
               } catch (fallbackError: any) {
                  console.warn("[archiveChatController.getChatOrComments] Failed to fetch standard comments:", fallbackError.message);
               }
            } else {
               console.log(`[archiveChatController.getChatOrComments] Skipping standard comments fetch since commentCount is 0.`);
            }
         } else {
            // Standard video with comments: skip scraper entirely
            console.log(`[archiveChatController.getChatOrComments] Video is standard VOD. Skipping Python scraper.`);
            try {
               console.log(`[archiveChatController.getChatOrComments] Fetching standard comments for ${videoId} (commentCount: ${commentCount})`);
               regularComments = await videoService.getAllPastLiveComments(videoId, streamerChannelId);
            } catch (fallbackError: any) {
               console.warn("[archiveChatController.getChatOrComments] Failed to fetch standard comments:", fallbackError.message);
            }
         }
      } else {
         // Fallback logic when API metadata check fails
         try {
            console.log(`[archiveChatController.getChatOrComments] API details fetch failed. Falling back to scraping.`);
            fullPastChatLogs = await getPastStreamerChat(url);
         } catch (error: any) {
            console.warn(`[archiveChatController.getChatOrComments] Could not fetch chat replay fallback: ${error.message}`);
         }

         try {
            console.log(`[archiveChatController.getChatOrComments] Fetching standard comments fallback for ${videoId}`);
            regularComments = await videoService.getAllPastLiveComments(videoId, streamerChannelId);
         } catch (fallbackError: any) {
            console.warn("[archiveChatController.getChatOrComments] Failed to fetch standard comments fallback:", fallbackError.message);
         }
      }

      if (fullPastChatLogs && !Array.isArray(fullPastChatLogs)) {
         console.warn(`[archiveChatController.getChatOrComments] Python script returned error:`, fullPastChatLogs.error || fullPastChatLogs);
         fullPastChatLogs = [];
      }

      // Normalize and combine standard comments & live chat logs
      const parseDate = (dStr: string) => {
         const t = Date.parse(dStr);
         return isNaN(t) ? null : t;
      };

      const parsedPastChat = Array.isArray(fullPastChatLogs) 
         ? fullPastChatLogs.map((c: any) => ({
            id: c.id || undefined,
            author: c.author || '',
            message: c.message || '',
            timestamp: c.timestamp ? Number(c.timestamp) : null,
            timeInVideo: c.time_in_video ? Number(c.time_in_video) : null,
            isStreamer: !!c.is_streamer,
            source: 'live_chat',
            replies: []
         }))
         : [];

      const parsedRegularComments = Array.isArray(regularComments)
         ? regularComments.map((c: any) => ({
            id: c.id || undefined,
            author: c.author || '',
            message: c.message || '',
            timestamp: c.publishedAt ? parseDate(c.publishedAt) : null,
            timeInVideo: null,
            isStreamer: !!c.isStreamer,
            source: 'standard_comment',
            replies: c.replies || []
         }))
         : [];

      let combinedComments = [...parsedPastChat, ...parsedRegularComments];

      // Sort chronologically by timestamp
      combinedComments.sort((a, b) => {
         const tA = a.timestamp !== null ? a.timestamp : 0;
         const tB = b.timestamp !== null ? b.timestamp : 0;
         return tA - tB;
      });

      // Filter by streamer if requested
      if (onlyStreamerChat) {
         combinedComments = combinedComments.filter(c => c.isStreamer);
      }

      const streamerComments = combinedComments.filter(c => c.isStreamer);

      res.json({
         type: isLiveStream ? 'mixed_live_chat_and_comments' : 'standard_video_comments',
         totalCommentsScanned: combinedComments.length,
         streamerCommentCount: streamerComments.length,
         data: combinedComments
      });

   } catch (error: any) {
      console.error("[archiveChatController.getChatOrComments] Crash:", error);
      res.status(500).json({ error: error.message });
   }
}