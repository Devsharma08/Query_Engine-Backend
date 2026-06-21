import { YoutubeTranscript } from "youtube-transcript";
import { ProxyAgent } from "undici";
import * as dotenv from "dotenv";
import * as crypto from "crypto";

dotenv.config();

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

async function runTests() {
   const videoId = "afLeOefHKG4";

   console.log("\n=== Test 4: Cookie Fetch (No Proxy) ===");
   const youtubeCookie = process.env.YOUTUBE_COOKIE;
   const youtubeUA = process.env.YOUTUBE_USER_AGENT;
   const cleanCookie = youtubeCookie 
      ? youtubeCookie.replace(/^["']|["']$/g, "").replace(/[\r\n]+/g, "").trim() 
      : undefined;
   if (!cleanCookie) {
      console.error("Test 4 FAILED: YOUTUBE_COOKIE is not set in .env");
      return;
   }
   console.log("Using YouTube Cookie...");
   try {
      const res = await YoutubeTranscript.fetchTranscript(videoId, {
         fetch: async (url: any, init: any) => {
            let requestUrl = url;
            // Force XML formatting if it's a timedtext request and missing fmt=srv3
            if (url.includes("/api/timedtext") && !url.includes("&fmt=srv3")) {
               requestUrl = `${url}&fmt=srv3`;
            }

            const isInnerTube = url.includes("/youtubei/v1/player");
            
            // Extract original User-Agent if any
            let originalUA: string | undefined;
            if (init?.headers) {
               for (const [key, value] of Object.entries(init.headers)) {
                  if (key.toLowerCase() === "user-agent") {
                     originalUA = value as string;
                     break;
                  }
               }
            }

            let resolvedUA = youtubeUA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
            if (isInnerTube) {
               resolvedUA = originalUA || "com.google.android.youtube/20.10.38 (Linux; U; Android 14)";
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
            headers["Cookie"] = cleanCookie;

            const sapisid = getSapisidFromCookie(cleanCookie);
            if (sapisid) {
               headers["Authorization"] = generateSapisidHash(sapisid);
            }

            console.log(`[Fetch Request] URL: ${requestUrl}`);
            console.log(`[Fetch Request] Headers:`, JSON.stringify({
               ...headers,
               Cookie: headers.Cookie ? headers.Cookie.substring(0, 50) + "..." : undefined
            }));
            
            try {
               const response = await fetch(requestUrl, {
                  ...init,
                  headers
               } as any);
               
               const text = await response.text();
               console.log(`[Fetch Response] Status: ${response.status} ${response.statusText}`);
               console.log(`[Fetch Response] Body (first 200 chars):`, text.substring(0, 200));
               
               return new Response(text, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers
               });
            } catch (err: any) {
               console.error(`[Fetch Network Error]:`, err.message);
               throw err;
            }
         }
      });
      console.log("Test 4 SUCCESS! Segments:", res.length);
   } catch (e: any) {
      console.error("Test 4 FAILED:", e.message);
   }
}

runTests();

