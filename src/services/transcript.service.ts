import { YoutubeTranscript } from "youtube-transcript";
import { extractVideoId } from "../utils/youtube-parser";
import { YoutubeService } from "./google.service";
import { ProxyAgent } from "undici";
import * as crypto from "crypto";

function getSapisidFromCookie(cookieStr: string): string | undefined {
   const match = cookieStr.match(/SAPISID=([^;]+)/);
   return match ? match[1].trim() : undefined;
}

function generateSapisidHash(sapisid: string, origin: string = "https://www.youtube.com"): string {
   const timestamp = Math.floor(Date.now() / 1000);
   const message = `${timestamp} ${sapisid} ${origin}`;
   const hash = crypto.createHash("sha1").update(message).digest("hex");
   return `SAPISIDHASH ${timestamp}_${hash}`;
}

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
         const youtubeUA = process.env.YOUTUBE_USER_AGENT;
         
         console.log(`[EXPRESS-APP-DEBUG] Ingesting videoId: ${videoId}`);
         console.log(`[EXPRESS-APP-DEBUG] YOUTUBE_COOKIE length: ${youtubeCookie?.length || 0}`);
         console.log(`[EXPRESS-APP-DEBUG] YOUTUBE_USER_AGENT: ${youtubeUA}`);
         
         const cleanCookie = youtubeCookie
            ? youtubeCookie.replace(/^["']|["']$/g, "").replace(/[\r\n]+/g, "").trim()
            : undefined;
         let fetchConfig = {};

         if (proxyUrl || cleanCookie || youtubeUA) {
            const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
            fetchConfig = {
               fetch: async (url: string, init: any) => {
                  let requestUrl = url;
                  // Force XML formatting if it's a timedtext request and missing fmt=srv3
                  if (url.includes("/api/timedtext") && !url.includes("&fmt=srv3")) {
                     requestUrl = `${url}&fmt=srv3`;
                  }

                  // Resolve relative URLs
                  if (requestUrl.startsWith("/")) {
                     requestUrl = `https://www.youtube.com${requestUrl}`;
                  }

                  const isInnerTube = url.includes("/youtubei/v1/player");

                  // We use the mobile UA for both watch pages and InnerTube if we force MWEB
                  let resolvedUA = youtubeUA || "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36";

                  let bodyOverride = init?.body;
                  if (isInnerTube && init?.body) {
                     try {
                        const bodyObj = JSON.parse(init.body);
                        if (bodyObj.context?.client) {
                           // Force MWEB client which is known to work with cookies & headers
                           bodyObj.context.client.clientName = "MWEB";
                           bodyObj.context.client.clientVersion = "2.20240308.01.00";
                           bodyOverride = JSON.stringify(bodyObj);
                        }
                     } catch (e) {
                        // ignore
                     }
                  }

                  const headers: Record<string, string> = {
                     "Origin": "https://www.youtube.com",
                     "Referer": "https://www.youtube.com/"
                  };

                  if (init?.headers) {
                     for (const [key, value] of Object.entries(init.headers)) {
                        const lowerKey = key.toLowerCase();
                        if (lowerKey !== "user-agent" && lowerKey !== "cookie") {
                           headers[key] = value as string;
                        }
                     }
                  }

                  headers["User-Agent"] = resolvedUA;
                  if (cleanCookie) {
                     headers["Cookie"] = cleanCookie;
                     const sapisid = getSapisidFromCookie(cleanCookie);
                     if (sapisid) {
                        headers["Authorization"] = generateSapisidHash(sapisid);
                     }
                  }

                  console.log(`[EXPRESS-APP-DEBUG.fetch] Request URL: ${requestUrl}`);
                  console.log(`[EXPRESS-APP-DEBUG.fetch] Request Headers:`, JSON.stringify({
                     ...headers,
                     Cookie: headers.Cookie ? headers.Cookie.substring(0, 50) + "..." : undefined
                  }));

                  try {
                     const response = await fetch(requestUrl, {
                        ...init,
                        body: bodyOverride,
                        headers,
                        ...(proxyAgent && { dispatcher: proxyAgent })
                     } as any);

                     let text = await response.text();
                     console.log(`[EXPRESS-APP-DEBUG.fetch] Response Status: ${response.status} ${response.statusText}`);

                     // Intercept /youtubei/v1/player response to rewrite relative baseUrl paths
                     if (isInnerTube && response.status === 200) {
                        try {
                           const data = JSON.parse(text);
                           const captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                           if (Array.isArray(captionTracks)) {
                              for (const track of captionTracks) {
                                 if (track.baseUrl && track.baseUrl.startsWith("/")) {
                                    track.baseUrl = "https://www.youtube.com" + track.baseUrl;
                                 }
                              }
                           }
                           text = JSON.stringify(data);
                        } catch (e) {
                           // ignore
                        }
                     }

                     return new Response(text, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers
                     });
                  } catch (err) {
                     throw err;
                  }
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
         console.log("comments from transcript service : ", comments);

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
               return {
                  text: segment.text.replace(/&#39;/g, "'").trim(),
                  startInSeconds: startInSeconds,
                  durationInSeconds: durationInSeconds,
                  totalTimeInSeconds: startInSeconds + durationInSeconds
               }
            }),

         }
      } catch (error: any) {
         console.error("Error fetching video transcript:", error);
         throw new Error(error.message || "failed to retrieve captions");
      }
   }
}