import { YoutubeTranscript } from "youtube-transcript";
import { extractVideoId } from "../utils/youtube-parser";
import { ProxyAgent } from "undici";
import * as crypto from "crypto";

/**
 * Extracts the SAPISID token from a raw YouTube Cookie header.
 * 
 * @param cookieStr Raw semi-colon delimited Cookie string
 * @returns SAPISID token value if matched, otherwise undefined
 */
function getSapisidFromCookie(cookieStr: string): string | undefined {
   const match = cookieStr.match(/SAPISID=([^;]+)/);
   return match ? match[1].trim() : undefined;
}

/**
 * Generates the dynamic SAPISIDHASH signature required for authenticated InnerTube API requests.
 * 
 * @param sapisid SAPISID token value
 * @param origin Request origin domain (defaults to https://www.youtube.com)
 * @returns Formatted Authorization header value
 */
function generateSapisidHash(sapisid: string, origin: string = "https://www.youtube.com"): string {
   const timestamp = Math.floor(Date.now() / 1000);
   const message = `${timestamp} ${sapisid} ${origin}`;
   const hash = crypto.createHash("sha1").update(message).digest("hex");
   return `SAPISIDHASH ${timestamp}_${hash}`;
}

export interface TimelineSegment {
   text: string;
   startInSeconds: number;
   durationInSeconds: number;
   totalTimeInSeconds?: number;
}

/**
 * Service to fetch and parse YouTube video transcripts (closed captions).
 */
export class TranscriptService {
   /**
    * Retrieves the full caption transcript for a given YouTube video URL.
    * Automatically handles custom user-agent, cookies, and HTTP proxy configuration.
    * 
    * @param url Fully qualified YouTube video link
    * @returns Structured object containing the parsed full text and timed segments
    */
   async getFullVideoTranscript(url: string): Promise<{ videoId: string, totalTextLength: number, fullCaptionText: string, timelineSegments: TimelineSegment[] }> {
      try {
         const videoId = extractVideoId(url);
         if (!videoId) {
            throw new Error("No valid videoId found");
         }

         const proxyUrl = process.env.PROXY_URL;
         const youtubeCookie = process.env.YOUTUBE_COOKIE;
         const youtubeUA = process.env.YOUTUBE_USER_AGENT;
         
         console.log(`[TranscriptService.getFullVideoTranscript] Ingesting videoId: ${videoId}`);
         
         const cleanCookie = youtubeCookie
            ? youtubeCookie.replace(/^["']|["']$/g, "").replace(/[\r\n]+/g, "").trim()
            : undefined;
         let fetchConfig = {};

         if (proxyUrl || cleanCookie || youtubeUA) {
            // When cookies are present, bypass proxy routing because direct connection works,
            // whereas proxy IPs are frequently rate-limited (HTTP 429) by Google.
            const proxyAgent = (proxyUrl && !cleanCookie) ? new ProxyAgent(proxyUrl) : undefined;
            if (proxyUrl && cleanCookie) {
               console.log("[TranscriptService] Cookie is present. Bypassing PROXY_URL to avoid proxy rate limits.");
            }
            
            fetchConfig = {
               fetch: async (url: string, init: any) => {
                  let requestUrl = url;
                  // Force XML output format if it's a timedtext request lacking the srv3 parameter
                  if (url.includes("/api/timedtext") && !url.includes("&fmt=srv3")) {
                     requestUrl = `${url}&fmt=srv3`;
                  }

                  // Resolve relative paths to absolute YouTube URLs
                  if (requestUrl.startsWith("/")) {
                     requestUrl = `https://www.youtube.com${requestUrl}`;
                  }

                  const isInnerTube = url.includes("/youtubei/v1/player");

                  // Fall back to a default Android mobile User Agent if none is configured
                  let resolvedUA = youtubeUA || "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36";

                  let bodyOverride = init?.body;
                  if (isInnerTube && init?.body) {
                     try {
                        const bodyObj = JSON.parse(init.body);
                        if (bodyObj.context?.client) {
                           // Force InnerTube to treat client as MWEB (mobile web client),
                           // which works reliably with cookie-based authorization headers.
                           bodyObj.context.client.clientName = "MWEB";
                           bodyObj.context.client.clientVersion = "2.20240308.01.00";
                           bodyOverride = JSON.stringify(bodyObj);
                        }
                     } catch (e) {
                        // Ignore body parsing issues and proceed with original body
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

                  try {
                     const response = await fetch(requestUrl, {
                        ...init,
                        body: bodyOverride,
                        headers,
                        ...(proxyAgent && { dispatcher: proxyAgent })
                     } as any);

                     let text = await response.text();

                     // Intercept InnerTube player responses to prepend YouTube origin to relative URLs
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
                           // Ignore parser warnings
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

         // Fetch timed-text transcript via youtube-transcript library
         const transcript = await YoutubeTranscript.fetchTranscript(videoId, fetchConfig);

         if (!transcript || transcript.length === 0) {
            throw new Error("No transcript captions found for the requested video ID.");
         }

         // Merge timed transcript parts and sanitize special character codes
         const fullText = transcript.map((item) => {
            return item.text
               .replace(/&#39;/g, "'")
               .replace(/&quot;/g, '"')
               .replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>')
               .trim();
         }).join(" ");

         // Return clean video details and parsed segments
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
               };
            }),
         };
      } catch (error: any) {
         console.error("[TranscriptService.getFullVideoTranscript] Error:", error);
         throw new Error(error.message || "Failed to retrieve video captions.");
      }
   }
}