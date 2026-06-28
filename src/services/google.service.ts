import { google, youtube_v3 } from 'googleapis';
import { normaliseDate } from '../utils/youtube-parser';
import dotenv from 'dotenv';

dotenv.config({
   path: '.env'
});

/**
 * Service to interact with the YouTube Data API v3.
 * Requires YT_V3_API_KEY environment variable.
 */
export class YoutubeService {
   private youtube: youtube_v3.Youtube;

   constructor() {
      const youtube_key = process.env.YT_V3_API_KEY;
      if (!youtube_key) {
         throw new Error("YouTube API Key not provided in environment variables (YT_V3_API_KEY).");
      }

      this.youtube = google.youtube({
         version: 'v3',
         auth: youtube_key
      });
   }

   /**
    * Fetches video metadata details by its YouTube video ID.
    * Parses live broadcast details to check if the video is an active live stream.
    * 
    * @param video_id 11-character YouTube video ID
    * @returns Structured video metadata including statistics and live status
    */
   async getVideoById(video_id: string) {
      try {
         const res = await this.youtube.videos.list({
            part: ['snippet', 'statistics', 'liveStreamingDetails'],
            id: [video_id]
         });
         const item = res.data.items?.[0];
         if (!item) {
            throw new Error("Video not found");
         }
         const isLiveStream = !!item.liveStreamingDetails;
         const liveStatus = item?.snippet?.liveBroadcastContent;

         return {
            id: item.id,
            title: item?.snippet?.title,
            description: item?.snippet?.description,
            publishedAt: normaliseDate(item?.snippet?.publishedAt || ""),
            channelId: item?.snippet?.channelId,
            channelTitle: item?.snippet?.channelTitle,
            categoryId: item?.snippet?.categoryId,
            viewCount: item?.statistics?.viewCount || 0,
            likeCount: item?.statistics?.likeCount || 0,
            commentCount: item?.statistics?.commentCount || 0,
            isLiveStream: isLiveStream ? {
               status: liveStatus,
               actualStartTime: normaliseDate(item.liveStreamingDetails?.actualStartTime || ""),
               activeLiveChatId: item.liveStreamingDetails?.activeLiveChatId || null
            } : null
         };
      } catch (error) {
         console.error("[YoutubeService.getVideoById] Error fetching video by id:", error);
         throw error;
      }
   }

   /**
    * Fetches chat messages from an active YouTube live stream's live chat ID.
    * Only works if the stream is currently live and the chat is active.
    * 
    * @param liveChatId Unique ID representing the active chat session
    * @returns Normalized array of chat messages with streamer/owner markers
    */
   async getActiveLiveChatMessages(liveChatId: string) {
      try {
         const res = await this.youtube.liveChatMessages.list({
            liveChatId: liveChatId,
            part: ['snippet', 'authorDetails'],
            maxResults: 200
         });

         const items = res.data.items || [];
         return items.map((item: any) => {
            const authorDetails = item.authorDetails;
            const snippet = item.snippet;
            
            return {
               timestamp: snippet?.publishedAt ? new Date(snippet.publishedAt).getTime() : null,
               time_in_video: null,
               author: authorDetails?.displayName,
               message: snippet?.displayMessage || snippet?.textMessageDetails?.messageText,
               is_streamer: authorDetails?.isChatOwner || authorDetails?.isChatModerator || false,
               author_id: authorDetails?.channelId
            };
         });
      } catch (error) {
         console.error("[YoutubeService.getActiveLiveChatMessages] Error fetching active live chat messages:", error);
         throw error;
      }
   }

   /**
    * Fetches standard public comments and comment thread replies for a given video.
    * Implements a maximum page retrieval limit (e.g., 5 pages / 500 comments) to safeguard
    * API quota limits from depletion.
    * 
    * @param videoId 11-character YouTube video ID
    * @param streamerChannelId Optional UC... channel ID of the streamer to detect author responses
    * @returns Array of public comment threads
    */
   async getAllPastLiveComments(videoId: string, streamerChannelId?: string) {
      let allComments: any[] = [];
      let nextPageToken: string | undefined = undefined;
      try {
         // Loop through up to 5 pages (500 comments max to protect API quota)
         for (let i = 0; i < 5; i++) {
            const response: any = await this.youtube.commentThreads.list({
               part: ['snippet', 'replies'],
               videoId: videoId,
               maxResults: 100,
               pageToken: nextPageToken,
               order: 'time', // Order chronologically by newest first
            });

            const items: any = response.data.items || [];
            console.log(`[YoutubeService.getAllPastLiveComments] API response status: ${response.status}, total items: ${items.length}`);
            
            const parsed = items.map((item: any) => {
               const topComment = item.snippet?.topLevelComment?.snippet;
               return {
                  id: item.id,
                  author: topComment?.authorDisplayName,
                  message: topComment?.textDisplay,
                  publishedAt: topComment?.publishedAt,
                  isStreamer: streamerChannelId ? (topComment?.authorChannelId?.value === streamerChannelId) : false,
                  replies: item.replies?.comments?.map((reply: any) => {
                     const replySnippet = reply.snippet;
                     return {
                        id: reply.id,
                        message: replySnippet?.textDisplay,
                        author: replySnippet?.authorDisplayName,
                        publishedAt: replySnippet?.publishedAt,
                        isStreamer: streamerChannelId ? (replySnippet?.authorChannelId?.value === streamerChannelId) : false
                     };
                  }) || []
               };
            });

            allComments = [...allComments, ...parsed];
            nextPageToken = response.data.nextPageToken;

            // Stop scrolling if there are no more pages
            if (!nextPageToken) break;
         }
         console.log(`[YoutubeService.getAllPastLiveComments] Finished pulling comments. Total normalized: ${allComments.length}`);
         return allComments;
      } catch (error: any) {
         const errorMsg = error?.message || "";
         if (errorMsg.includes("disabled comments") || errorMsg.includes("commentsDisabled")) {
            console.warn(`[YoutubeService.getAllPastLiveComments] Comments are disabled for video ${videoId}. Returning empty array.`);
            return [];
         }
         console.error('[YoutubeService.getAllPastLiveComments] Failed official comment pull sequence:', error);
         throw error;
      }
   }

   /**
    * Resolves a YouTube @handle (e.g. "@username") to a canonical "UC..." channel ID.
    * 
    * @param handle User handle string
    * @returns The canonical channel ID or null if not found
    */
   async resolveHandleToChannelId(handle: string): Promise<string | null> {
      try {
         const res = await this.youtube.channels.list({
            part: ['id'],
            forHandle: handle,
            maxResults: 1
         });

         const channelId = res.data.items?.[0]?.id;
         if (channelId) {
            console.log(`[YoutubeService.resolveHandleToChannelId] Resolved @${handle} -> ${channelId}`);
            return channelId;
         }
         
         console.warn(`[YoutubeService.resolveHandleToChannelId] No channel found for @${handle}`);
         return null;
      } catch (error: any) {
         console.error(`[YoutubeService.resolveHandleToChannelId] Error resolving @${handle}:`, error.message);
         throw error;
      }
   }
}
