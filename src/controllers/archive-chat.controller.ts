import { Request, Response } from 'express';
import { extractVideoId, generateChannelId } from '../utils/youtube-parser';
import { YoutubeService } from '../services/google.service';
import { Innertube, Platform } from 'youtubei.js';
import { ProxyAgent } from 'undici';

const videoService = new YoutubeService();

/**
 * Fetches live chat replays natively using youtubei.js.
 */
export async function getPastStreamerChat(url: string): Promise<any[]> {
   const videoId = extractVideoId(url);
   if (!videoId) {
      console.warn(`[archiveChatController.getPastStreamerChat] Invalid video URL: ${url}`);
      return [];
   }

   try {
      console.log(`[archiveChatController.getPastStreamerChat] Initializing InnerTube client for video: ${videoId}`);
      
      const config: any = {
         lang: 'en',
         location: 'US',
      };

      const youtubeCookie = process.env.YOUTUBE_COOKIE;
      if (youtubeCookie) {
         const cleanCookie = youtubeCookie.replace(/^["']|["']$/g, "").replace(/[\r\n]+/g, "").trim();
         if (cleanCookie) {
            config.cookie = cleanCookie;
         }
      }

      const proxyUrl = process.env.PROXY_URL;
      if (proxyUrl && !youtubeCookie) {
         const cleanProxy = proxyUrl.replace(/^["']|["']$/g, "").replace(/[\r\n]+/g, "").trim();
         if (cleanProxy) {
            const proxyAgent = new ProxyAgent(cleanProxy);
            config.fetch = (input: any, init: any) => {
               return Platform.shim.fetch(input, {
                  ...init,
                  dispatcher: proxyAgent
               });
            };
         }
      }

      const youtube = await Innertube.create(config);
      
      console.log(`[archiveChatController.getPastStreamerChat] Fetching info for stream VOD: ${videoId}`);
      const videoInfo = await youtube.getInfo(videoId);
      
      if (!videoInfo.has_live_chat) {
         console.log(`[archiveChatController.getPastStreamerChat] No historical live chat replay track found for video ${videoId}.`);
         return [];
      }

      console.log(`[archiveChatController.getPastStreamerChat] Live chat stream found. Pulling replay chunks...`);
      const liveChat = await videoInfo.getLiveChat();
      const chatLogs: any[] = [];

      if (liveChat.initial_data && liveChat.initial_data.actions) {
         for (const action of liveChat.initial_data.actions) {
            const replayAction = action.replay_item_action_renderer;
            if (!replayAction) continue;
            
            const actionsList = replayAction.actions || [];
            for (const act of actionsList) {
               const item = act.add_chat_item_action?.item;
               if (!item) continue;
               
               const msgRenderer = item.live_chat_text_message_renderer;
               if (msgRenderer) {
                  const messageText = msgRenderer.message?.runs?.map((r: any) => r.text).join('') || '';
                  const author = msgRenderer.author_name?.simple_text || 'Anonymous';
                  const offsetMsec = replayAction.video_offset_time_msec;
                  const timeInSeconds = offsetMsec ? Number(offsetMsec) / 1000 : null;
                  const timestampUsec = msgRenderer.timestamp_usec;
                  const timestamp = timestampUsec ? Number(timestampUsec) / 1000 : null;

                  const badges = msgRenderer.author_badges || [];
                  let isStreamer = false;
                  for (const badge of badges) {
                     const badgeRenderer = badge.live_chat_author_badge_renderer;
                     if (badgeRenderer?.icon?.icon_type === 'OWNER') {
                        isStreamer = true;
                        break;
                     }
                  }

                  chatLogs.push({
                     timestamp: timestamp,
                     time_in_video: timeInSeconds,
                     author: author,
                     message: messageText,
                     is_streamer: isStreamer
                  });
               }
            }
         }
      }

      console.log(`[archiveChatController.getPastStreamerChat] Successfully retrieved ${chatLogs.length} live chat replay logs natively.`);
      return chatLogs;

   } catch (error) {
      console.error(`[archiveChatController.getPastStreamerChat Internal Error] Native JS extraction failed:`, error);
      return [];
   }
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
         if (isLiveStream) {
            // livestream: fetch live chat replay via Python scraper
            try {
               console.log(`[archiveChatController.getChatOrComments] Video is a livestream. Invoking python scraper.`);
               fullPastChatLogs = await getPastStreamerChat(url);
            } catch (error: any) {
               console.warn(`[archiveChatController.getChatOrComments] Could not fetch chat replay: ${error.message}`);
            }
         } else {
            console.log(`[archiveChatController.getChatOrComments] Video is standard VOD. Skipping Python scraper.`);
         }

         // Always attempt to fetch standard comments via YouTube API
         try {
            console.log(`[archiveChatController.getChatOrComments] Fetching standard comments for ${videoId}`);
            regularComments = await videoService.getAllPastLiveComments(videoId, streamerChannelId);
         } catch (fallbackError: any) {
            console.warn("[archiveChatController.getChatOrComments] Failed to fetch standard comments:", fallbackError.message);
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