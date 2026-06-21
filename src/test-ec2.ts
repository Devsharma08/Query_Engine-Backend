import { YoutubeTranscript } from "youtube-transcript";
import { ProxyAgent } from "undici";
import * as dotenv from "dotenv";

dotenv.config();

async function runTests() {
   const videoId = "afLeOefHKG4";

   console.log("\n=== Test 4: Cookie Fetch (No Proxy) ===");
   const youtubeCookie = process.env.YOUTUBE_COOKIE;
   const cleanCookie = youtubeCookie ? youtubeCookie.replace(/[\r\n]+/g, "").trim() : undefined;
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

            const headers = {
               ...(init?.headers || {}),
               "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
               "Cookie": cleanCookie
            };
            console.log(`[Fetch Request] URL: ${requestUrl}`);
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
