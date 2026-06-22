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
      try {
         const videoDetails = await videoService.getVideoById(videoId);
         if (videoDetails.isLiveStream) {
            isLiveStream = true;
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

      // If completed live stream, fetch logs using local Python downloader
      let fullPastChatLogs: any = [];
      if (isLiveStream) {
         try {
            fullPastChatLogs = await getPastStreamerChat(url);
         } catch (error: any) {
            console.warn(`[archiveChatController.getChatOrComments] Could not fetch chat replay: ${error.message}`);
         }
      }

      if (fullPastChatLogs && !Array.isArray(fullPastChatLogs)) {
         console.warn(`[archiveChatController.getChatOrComments] Python script returned error:`, fullPastChatLogs.error || fullPastChatLogs);
         fullPastChatLogs = [];
      }

      if (Array.isArray(fullPastChatLogs) && fullPastChatLogs.length > 0) {
         const streamerOnly = fullPastChatLogs.filter((msg: any) => msg.is_streamer);
         res.json({
            type: "live chat replay",
            totalChatCount: fullPastChatLogs.length,
            streamerCommentCount: streamerOnly.length,
            streamerTimeline: streamerOnly
         });
         return;
      }

      // Fallback: Fetch standard comments via YouTube API
      try {
         console.log(`[archiveChatController.getChatOrComments] Fallback: Fetching standard comments for ${videoId}`);
         const streamerChannelId = channelLink ? generateChannelId(channelLink) : undefined;
         const regularComments = await videoService.getAllPastLiveComments(videoId, streamerChannelId);
         const streamerComments = regularComments.filter((c: any) => c.isStreamer);

         res.json({
            type: 'standard_video_comments',
            totalCommentsScanned: regularComments.length,
            streamerCommentCount: streamerComments.length,
            data: streamerComments
         });
      } catch (fallbackError: any) {
         console.warn("[archiveChatController.getChatOrComments] Fallback failed (comments may be disabled):", fallbackError.message);
         res.json({
            type: 'standard_video_comments_disabled',
            totalCommentsScanned: 0,
            streamerCommentCount: 0,
            data: [],
            warning: fallbackError.message
         });
      }

   } catch (error: any) {
      console.error("[archiveChatController.getChatOrComments] Crash:", error);
      res.status(500).json({ error: error.message });
   }
}