import { Request, Response } from 'express';
import { extractVideoId } from '../utils/youtube-parser';
import { YoutubeService } from '../services/google.service';
import { Innertube, Platform } from 'youtubei.js';
import { ProxyAgent } from 'undici';

const videoService = new YoutubeService();

/**
 * Creates a configured Innertube client instance.
 * Automatically provisions youtube-cookies or HTTP proxy agents to prevent rate limiting.
 * 
 * @returns Configured Innertube client instance
 */
async function createInnertubeClient(): Promise<any> {
   const config: any = {
      lang: 'en',
      location: 'US',
   };

   // Clean and inject authentication cookies if defined in environment variables
   const youtubeCookie = process.env.YOUTUBE_COOKIE;
   if (youtubeCookie) {
      const cleanCookie = youtubeCookie.replace(/^["']|["']$/g, "").replace(/[\r\n]+/g, "").trim();
      if (cleanCookie) {
         config.cookie = cleanCookie;
      }
   }

   // Inject ProxyAgent if PROXY_URL is configured and cookies are absent
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

   return Innertube.create(config);
}

/**
 * Parses and extracts text message events from a chat action object.
 * 
 * @param action Raw replay chat item action object
 * @returns Normalized array containing parsed message details, or null
 */
function extractChatMessage(action: any): any | null {
   try {
      let chatItems: any[] = [];
      
      // Replay actions are wrapped inside ReplayChatItemAction containers
      if (action.type === 'ReplayChatItemAction') {
         chatItems = action.actions || [];
      } else {
         chatItems = [action];
      }

      const results: any[] = [];
      
      for (const chatAction of chatItems) {
         let item: any = null;
         let offsetMsec: number | null = null;
         
         // Extract nested item body
         if (chatAction.type === 'AddChatItemAction') {
            item = chatAction.item;
         } else if (chatAction.item) {
            item = chatAction.item;
         }
         
         if (!item) continue;
         
         // Record time offset from video starting point
         if (action.video_offset_time_msec !== undefined) {
            offsetMsec = Number(action.video_offset_time_msec);
         }

         // Only process text message events (skip superchats, member alerts, etc.)
         if (item.type === 'LiveChatTextMessage') {
            const messageText = item.message?.toString?.() || 
                               item.message?.text ||
                               (item.message?.runs?.map((r: any) => r.text || r.toString?.() || '').join('')) || 
                                '';
            const author = item.author?.name?.toString?.() || 
                           item.author?.name?.text ||
                           item.author?.name?.simple_text || 
                           'Anonymous';
            const authorChannelId = item.author?.id || 
                                   item.author?.channel_id || 
                                   null;
            
            const timeInSeconds = offsetMsec !== null ? offsetMsec / 1000 : null;
            const timestamp = item.timestamp ? Number(item.timestamp) / 1000 : null;

            // Detect owner/streamer custom badges to mark their messages
            let isStreamer = false;
            const badges = item.author?.badges || [];
            for (const badge of badges) {
               if (badge?.icon_type === 'OWNER' || 
                   badge?.style === 'CHAT_BADGE' ||
                   badge?.icon?.icon_type === 'OWNER' ||
                   badge?.type === 'LiveChatAuthorBadge') {
                  const iconType = badge?.icon_type || badge?.icon?.icon_type || '';
                  if (iconType === 'OWNER') {
                     isStreamer = true;
                     break;
                  }
               }
            }

            results.push({
               timestamp,
               time_in_video: timeInSeconds,
               author,
               author_channel_id: authorChannelId,
               message: messageText,
               is_streamer: isStreamer
            });
         }
      }
      
      return results.length > 0 ? results : null;
   } catch {
      return null;
   }
}

/**
 * Scrapes livestream chat replays by invoking YouTube internal endpoints directly
 * using sequential continuation tokens.
 * This bypasses YouTube's buggy EventSource stream endpoints which return 400 errors during paging.
 * 
 * @param url Stream link
 * @param maxMessages Maximum number of messages to pull (defaults to 5000)
 * @returns Array of parsed chat logs
 */
export async function getPastStreamerChat(url: string, maxMessages = 5000): Promise<any[]> {
   const videoId = extractVideoId(url);
   if (!videoId) {
      console.warn(`[getPastStreamerChat] Invalid video URL: ${url}`);
      return [];
   }

   try {
      console.log(`[getPastStreamerChat] Initializing InnerTube for video: ${videoId}`);
      const youtube = await createInnertubeClient();

      console.log(`[getPastStreamerChat] Fetching video info for: ${videoId}`);
      const videoInfo: any = await youtube.getInfo(videoId);

      const livechatData = videoInfo.livechat;
      if (!livechatData) {
         console.log(`[getPastStreamerChat] No live chat replay available for ${videoId}`);
         return [];
      }

      const isReplay = livechatData.is_replay || false;
      const initialContinuation = livechatData.continuation;

      if (!initialContinuation) {
         console.log(`[getPastStreamerChat] No continuation token found for ${videoId}`);
         return [];
      }

      console.log(`[getPastStreamerChat] Live chat replay found (is_replay: ${isReplay}). Starting direct fetch...`);

      const chatLogs: any[] = [];
      const MAX_MESSAGES = maxMessages;
      const MAX_PAGES = 50; // Guardrail to prevent infinite loop
      let continuationToken = initialContinuation;
      let pageCount = 0;

      while (continuationToken && pageCount < MAX_PAGES && chatLogs.length < MAX_MESSAGES) {
         try {
            const endpoint = isReplay ? 'live_chat/get_live_chat_replay' : 'live_chat/get_live_chat';
            const response: any = await videoInfo.actions.execute(endpoint, {
               continuation: continuationToken,
               parse: true
            });

            const contents = response?.continuation_contents;
            if (!contents) {
               console.log(`[getPastStreamerChat] No more continuation contents at page ${pageCount}`);
               break;
            }

            const nextToken = contents.continuation?.token;
            const rawActions = contents.actions;
            const actionsArray: any[] = rawActions ? Array.from(rawActions) : [];
            
            let pageMessages = 0;
            for (const action of actionsArray) {
               const extracted = extractChatMessage(action);
               if (extracted) {
                  chatLogs.push(...extracted);
                  pageMessages += extracted.length;
               }
            }

            console.log(`[getPastStreamerChat] Page ${pageCount}: ${actionsArray.length} actions → ${pageMessages} messages (total: ${chatLogs.length})`);

            if (!nextToken || nextToken === continuationToken) {
               console.log(`[getPastStreamerChat] No more pages (token exhausted at page ${pageCount})`);
               break;
            }

            continuationToken = nextToken;
            pageCount++;

         } catch (pageErr: any) {
            const errMsg = pageErr?.message || String(pageErr);
            console.warn(`[getPastStreamerChat] Page ${pageCount} failed: ${errMsg}`);
            // Terminate fetching if a 400 Bad Request error is encountered
            break;
         }
      }

      console.log(`[getPastStreamerChat] Collection complete. ${chatLogs.length} messages from ${pageCount + 1} page(s).`);
      return chatLogs;

   } catch (error: any) {
      console.error(`[getPastStreamerChat] Failed:`, error?.message || error);
      return [];
   }
}

/**
 * Resolves a YouTube @handle or channel link to a canonical "UC..." ID.
 * 
 * @param channelLink Handle URL or channel ID string
 * @returns Canonical channel ID, or undefined
 */
async function resolveStreamerChannelId(channelLink?: string): Promise<string | undefined> {
   if (!channelLink) return undefined;
   
   // Parse handle format from link
   const handleMatch = channelLink.match(/@([a-zA-Z0-9_-]+)/);
   if (!handleMatch) {
      if (channelLink.startsWith('UC') && channelLink.length >= 24) {
         return channelLink;
      }
      return undefined;
   }

   const handle = handleMatch[1];
   
   try {
      const channelId = await videoService.resolveHandleToChannelId(handle);
      if (channelId) {
         console.log(`[resolveStreamerChannelId] Resolved @${handle} -> ${channelId}`);
         return channelId;
      }
   } catch (err: any) {
      console.warn(`[resolveStreamerChannelId] Failed to resolve @${handle}: ${err.message}`);
   }
   
   return undefined;
}

/**
 * Controller to fetch either active live chat messages, completed chat replays, 
 * or standard fallback comments for a given stream URL.
 * Supports chronological sorting, streamer identity matching, and paginated records.
 * 
 * @param req Express Request object
 * @param res Express Response object
 */
export async function getChatOrComments(req: Request, res: Response): Promise<void> {
   try {
      const { url, channelLink, onlyStreamerChat, limit, page, offset } = req.body || {};
      const videoId = extractVideoId(url);
      if (!videoId) {
         res.status(400).json({ error: 'Missing standard stream url address parameter' });
         return;
      }

      // Helper to parse integers safely
      const parseInteger = (val: any): number | undefined => {
         if (val === undefined || val === null || val === '') return undefined;
         const num = Number(val);
         return isNaN(num) ? undefined : Math.floor(num);
      };

      const rawLimit = parseInteger(limit ?? req.query.limit);
      const rawPage = parseInteger(page ?? req.query.page);
      const rawOffset = parseInteger(offset ?? req.query.offset);

      const parsedLimit = (rawLimit !== undefined && rawLimit > 0) ? rawLimit : (rawPage !== undefined ? 100 : undefined);
      const parsedPage = (rawPage !== undefined && rawPage > 0) ? rawPage : 1;
      const parsedOffset = (rawOffset !== undefined && rawOffset >= 0) ? rawOffset : ((parsedLimit !== undefined) ? (parsedPage - 1) * parsedLimit : 0);

      let activeLiveChatId: string | null = null;
      let isLiveStream = false;
      let liveStatus: string | null = null;
      let commentCount = 0;
      let videoDetails: any = null;
      let metadataFetched = false;
      let videoChannelId: string | undefined = undefined;

      try {
         videoDetails = await videoService.getVideoById(videoId);
         console.log(`[getChatOrComments] Video Details:`, JSON.stringify(videoDetails, null, 2));
         metadataFetched = true;
         commentCount = videoDetails.commentCount ? Number(videoDetails.commentCount) : 0;
         videoChannelId = videoDetails.channelId || undefined;
         
         if (videoDetails.isLiveStream) {
            isLiveStream = true;
            liveStatus = videoDetails.isLiveStream.status;
            if (videoDetails.isLiveStream.activeLiveChatId) {
               activeLiveChatId = videoDetails.isLiveStream.activeLiveChatId;
            }
         }
      } catch (err: any) {
         console.warn(`[getChatOrComments] Could not get details via API: ${err.message}`);
         isLiveStream = true; 
      }

      let combinedComments: any[] = [];
      let isLiveActive = false;

      // Case 1: Stream is actively live -> fetch active messages via YouTube Data API
      if (activeLiveChatId) {
         try {
            const liveMessages = await videoService.getActiveLiveChatMessages(activeLiveChatId);
            combinedComments = liveMessages.map((msg: any) => ({
               id: undefined,
               author: msg.author || '',
               message: msg.message || '',
               timestamp: msg.timestamp ? Number(msg.timestamp) : null,
               timeInVideo: null,
               isStreamer: !!msg.is_streamer,
               authorChannelId: msg.author_id || null,
               source: 'active_live_chat',
               replies: []
            }));
            isLiveActive = true;
         } catch (liveChatErr: any) {
            console.error(`[getChatOrComments] Failed live fetch fallback: ${liveChatErr.message}`);
         }
      }

      // Case 2: Chat replay or comment thread fallback
      if (!isLiveActive) {
         // Identify streamer channel ID (prioritize details info, fall back to handle resolution)
         let streamerChannelId: string | undefined = videoChannelId;
         if (!streamerChannelId && channelLink) {
            streamerChannelId = await resolveStreamerChannelId(channelLink);
         }
         console.log(`[getChatOrComments] Streamer channel ID: ${streamerChannelId || 'unknown'}`);

         let fullPastChatLogs: any = [];
         let regularComments: any[] = [];

         let maxMessagesToScan = 5000;
         if (!onlyStreamerChat && parsedLimit !== undefined) {
            maxMessagesToScan = parsedOffset + parsedLimit;
         }

         if (metadataFetched) {
            if (isLiveStream) {
               try {
                  console.log(`[getChatOrComments] Video is a livestream. Fetching chat replay via youtubei.js (maxMessages: ${maxMessagesToScan})...`);
                  fullPastChatLogs = await getPastStreamerChat(url, maxMessagesToScan);
               } catch (error: any) {
                  console.warn(`[getChatOrComments] Could not fetch chat replay: ${error.message}`);
               }
            } else {
               console.log(`[getChatOrComments] Video is standard VOD. Skipping chat replay.`);
            }

            // Always retrieve standard comment threads
            try {
               console.log(`[getChatOrComments] Fetching standard comments for ${videoId}`);
               regularComments = await videoService.getAllPastLiveComments(videoId, streamerChannelId);
            } catch (fallbackError: any) {
               console.warn("[getChatOrComments] Failed to fetch standard comments:", fallbackError.message);
            }
         } else {
            // Fallback scraping sequences when initial API request fails
            try {
               console.log(`[getChatOrComments] API details fetch failed. Falling back to scraping (maxMessages: ${maxMessagesToScan}).`);
               fullPastChatLogs = await getPastStreamerChat(url, maxMessagesToScan);
            } catch (error: any) {
               console.warn(`[getChatOrComments] Could not fetch chat replay fallback: ${error.message}`);
            }

            try {
               console.log(`[getChatOrComments] Fetching standard comments fallback for ${videoId}`);
               regularComments = await videoService.getAllPastLiveComments(videoId, streamerChannelId);
            } catch (fallbackError: any) {
               console.warn("[getChatOrComments] Failed to fetch standard comments fallback:", fallbackError.message);
            }
         }

         if (fullPastChatLogs && !Array.isArray(fullPastChatLogs)) {
            console.warn(`[getChatOrComments] Chat replay returned error:`, fullPastChatLogs.error || fullPastChatLogs);
            fullPastChatLogs = [];
         }

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
               authorChannelId: c.author_channel_id || null,
               source: 'live_chat',
               replies: []
            }))
            : [];

         // Re-evaluate owner state if subscriber scrapers missed the badge representation
         if (streamerChannelId) {
            for (const msg of parsedPastChat) {
               if (!msg.isStreamer && msg.authorChannelId === streamerChannelId) {
                  msg.isStreamer = true;
               }
            }
         }

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

         combinedComments = [...parsedPastChat, ...parsedRegularComments];
      }

      // Sort comments chronologically by timestamp
      combinedComments.sort((a, b) => {
         const tA = a.timestamp !== null ? a.timestamp : 0;
         const tB = b.timestamp !== null ? b.timestamp : 0;
         return tA - tB;
      });

      // Filter messages down to streamer-only responses if flag is set
      if (onlyStreamerChat) {
         combinedComments = combinedComments.filter(c => c.isStreamer);
      }

      const streamerComments = combinedComments.filter(c => c.isStreamer);

      // Implement pagination computations
      const totalItems = combinedComments.length;
      let paginatedData = combinedComments;
      let paginationInfo: any = null;

      if (parsedLimit !== undefined) {
         const start = parsedOffset;
         const end = start + parsedLimit;
         paginatedData = combinedComments.slice(start, end);
         
         const totalPages = Math.ceil(totalItems / parsedLimit);
         const currentPage = rawPage !== undefined ? rawPage : Math.floor(start / parsedLimit) + 1;
         
         paginationInfo = {
            total: totalItems,
            page: currentPage,
            limit: parsedLimit,
            offset: start,
            totalPages: totalPages,
            hasNextPage: start + parsedLimit < totalItems,
            hasPrevPage: start > 0
         };
      } else {
         paginationInfo = {
            total: totalItems,
            page: 1,
            limit: totalItems,
            offset: 0,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false
         };
      }

      const responseType = isLiveActive 
         ? 'active_live_chat' 
         : (isLiveStream ? 'mixed_live_chat_and_comments' : 'standard_video_comments');

      res.json({
         type: responseType,
         totalCommentsScanned: totalItems,
         streamerCommentCount: streamerComments.length,
         pagination: paginationInfo,
         data: paginatedData
      });

    } catch (error: any) {
       console.error("[getChatOrComments] Crash:", error);
       res.status(500).json({ error: error.message });
    }
 }