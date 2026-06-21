import { YoutubeTranscript } from "youtube-transcript";
import { extractVideoId } from "../utils/youtube-parser";
import { YoutubeService } from "./google.service";
import { ProxyAgent } from "undici";

interface TimelineSegment {
   text: string;
   startInSeconds: number;
   durationInSeconds: number;
}

// YoutubeTranscript.fetchTranscript return type is [
//   {
//     text: string;
//     duration: number;
//     offset: number;
//     lang:string; // only for auto generated 
//   }
// ]


export class TranscriptService {
   youtubeService = new YoutubeService();
   async getFullVideoTranscript(url: string): Promise<{ videoId: string, totalTextLength: number, fullCaptionText: string, timelineSegments: TimelineSegment[] }> {
      try {
         const videoId = extractVideoId(url);
         if (!videoId) {
            throw new Error("No valid videoId found");
         }

         const proxyUrl = process.env.PROXY_URL;
         const youtubeCookie = process.env.YOUTUBE_COOKIE;
         let fetchConfig = {};

         if (proxyUrl || youtubeCookie) {
            const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
            fetchConfig = {
               fetch: (url: string, init: any) => {
                  const headers = {
                     ...(init?.headers || {}),
                     "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                     ...(youtubeCookie && { "Cookie": youtubeCookie })
                  };
                  return fetch(url, {
                     ...init,
                     headers,
                     ...(proxyAgent && { dispatcher: proxyAgent })
                  } as any);
               }
            };
         }

         // fetch the text array from youtube
         const transcript = await YoutubeTranscript.fetchTranscript(videoId, fetchConfig);
         // console.log("transcript text from transcript service : ",transcript);

         if (!transcript || transcript.length === 0) {
            throw new Error("No transcript found for video id");
         }

         // fetching comments from the youtube video using youtube api for deep understanding of the video
         const comments = await this.youtubeService.getAllPastLiveComments(videoId);
         console.log("comments from transcript service : ",comments);

         // task - on success will match the o/p with chat for reference for doubts and some other info will figure out later
         

         const fullText = transcript.map((item) => {
            return item.text
               .replace(/&#39;/g, "'")
               .replace(/&quot;/g, '"')
               .replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>')
               .trim();
         }).join(" ");
         // return required fields only not the whole transcript array
         return {
            videoId,
            totalTextLength: fullText.length,
            fullCaptionText: fullText,
            timelineSegments: transcript.map((segment) => {
               const startInSeconds = Math.floor(segment.offset / 1000);
               const durationInSeconds = Math.floor(segment.duration / 1000);
               return{
               text: segment.text.replace(/&#39;/g, "'").trim(),
               startInSeconds: startInSeconds,
               durationInSeconds: durationInSeconds,
               totalTimeInSeconds:startInSeconds+durationInSeconds
               }
            }),

         }
      } catch (error:any) {
         console.error("Error fetching video transcript:", error);
         throw new Error(error.message || "failed to retrieve captions");
      }
   }
}