import { Request, Response } from 'express';
import { extractVideoId } from '../utils/youtube-parser';
import { YoutubeService } from '../services/google.service';
import { Innertube, Platform } from 'youtubei.js';
import { ProxyAgent } from 'undici';

const videoService = new YoutubeService();

/**
 * Creates a configured Innertube instance with optional cookie/proxy support.
 */
async function createInnertubeClient(): Promise<any> {
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

   return Innertube.create(config);
}

/**
 * Extracts a single chat message from a chat action item.
 * Returns null if the item isn't a parseable text message.
 */
function extractChatMessage(action: any): any | null {
   try {
      // Handle both replay wrapper and direct actions
      let chatItems: any[] = [];
      
      // Replay format: ReplayChatItemAction wrapping multiple actions
      if (action.type === 'ReplayChatItemAction') {
         chatItems = action.actions || [];
      } else {
         chatItems = [action];
      }

      const results: any[] = [];
      
      for (const chatAction of chatItems) {
         let item: any = null;
         let offsetMsec: number | null = null;
         
         // Try to get the item from AddChatItemAction
         if (chatAction.type === 'AddChatItemAction') {
            item = chatAction.item;
         } else if (chatAction.item) {
            item = chatAction.item;
         }
         
         if (!item) continue;
         
         // Get offset from the parent replay action
         if (action.video_offset_time_msec !== undefined) {
            offsetMsec = Number(action.video_offset_time_msec);
         }

         // Handle LiveChatTextMessage
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

            // Check for OWNER badge (streamer)
            let isStreamer = false;
            const badges = item.author?.badges || [];
            for (const badge of badges) {
               if (badge?.icon_type === 'OWNER' || 
                   badge?.style === 'CHAT_BADGE' ||
                   badge?.icon?.icon_type === 'OWNER' ||
                   badge?.type === 'LiveChatAuthorBadge') {
                  // Check if this is specifically the owner badge
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
   } catch (err) {
      return null;
   }
}

/**
 * Fetches live chat replays by directly calling the YouTube internal API
 * with manual continuation token management.
 * Bypasses the buggy LiveChat event system that spams 400 errors on continuation.
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

      // Check if this video has live chat replay available
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
      const MAX_PAGES = 50;
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

            // Extract the next continuation token
            const nextToken = contents.continuation?.token;

            // Extract actions from this page — actions is an ObservedArray from Parser.parse()
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
            // Stop on errors (400 = invalid continuation token, no point retrying)
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
 * Resolves a YouTube @handle or channel URL to a proper UC... channel ID
 * using the YouTube Data API v3 channels.list with forHandle.
 */
async function resolveStreamerChannelId(channelLink?: string): Promise<string | undefined> {
   if (!channelLink) return undefined;
   
   // Extract handle from URL like https://www.youtube.com/@RealInterviewExperience
   const handleMatch = channelLink.match(/@([a-zA-Z0-9_-]+)/);
   if (!handleMatch) {
      // Maybe it's already a channel ID
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
 */
export async function getChatOrComments(req: Request, res: Response): Promise<void> {
   try {
      const { url, channelLink, onlyStreamerChat, limit, page, offset } = req.body || {};
      const videoId = extractVideoId(url);
      if (!videoId) {
         res.status(400).json({ error: 'Missing standard stream url address parameter' });
         return;
      }

      // Helper to parse integer safely from body or query
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

      // If active, stream live messages directly via YouTube API
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

      if (!isLiveActive) {
         // Resolve the streamer's channel ID from their @handle link
         // Use the channelId from video metadata as primary, fall back to resolving the handle
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
               // livestream: fetch live chat replay via youtubei.js
               try {
                  console.log(`[getChatOrComments] Video is a livestream. Fetching chat replay via youtubei.js (maxMessages: ${maxMessagesToScan})...`);
                  fullPastChatLogs = await getPastStreamerChat(url, maxMessagesToScan);
               } catch (error: any) {
                  console.warn(`[getChatOrComments] Could not fetch chat replay: ${error.message}`);
               }
            } else {
               console.log(`[getChatOrComments] Video is standard VOD. Skipping chat replay.`);
            }

            // Always attempt to fetch standard comments via YouTube API
            try {
               console.log(`[getChatOrComments] Fetching standard comments for ${videoId}`);
               regularComments = await videoService.getAllPastLiveComments(videoId, streamerChannelId);
            } catch (fallbackError: any) {
               console.warn("[getChatOrComments] Failed to fetch standard comments:", fallbackError.message);
            }
         } else {
            // Fallback logic when API metadata check fails
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
               authorChannelId: c.author_channel_id || null,
               source: 'live_chat',
               replies: []
            }))
            : [];

         // For live chat messages, also match streamer by channel ID if badge detection missed it
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

      // Apply pagination
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