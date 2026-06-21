import { YoutubeTranscript } from "youtube-transcript";
import { ProxyAgent } from "undici";
import * as dotenv from "dotenv";

dotenv.config();

async function runTests() {
   const videoId = "afLeOefHKG4";
   const proxyUrl = process.env.PROXY_URL;
   if (!proxyUrl) {
      console.error("PROXY_URL is not set in .env");
      return;
   }
   console.log("Using proxy:", proxyUrl);
   const proxyAgent = new ProxyAgent(proxyUrl);

   try {
      const res = await YoutubeTranscript.fetchTranscript(videoId, {
         fetch: async (url: any, init: any) => {
            const headers = {
               ...(init?.headers || {}),
               "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
            };
            console.log(`[Fetch Request] URL: ${url}`);
            console.log(`[Fetch Request] Headers:`, JSON.stringify(headers));
            try {
               const response = await fetch(url, {
                  ...init,
                  headers,
                  dispatcher: proxyAgent
               } as any);
               console.log(`[Fetch Response] Status: ${response.status} ${response.statusText}`);
               return response;
            } catch (err: any) {
               console.error(`[Fetch Network Error]:`, err.message);
               throw err;
            }
         }
      });
      console.log("SUCCESS! Segments:", res.length);
   } catch (e: any) {
      console.error("FAILED:", e.message);
   }
}

runTests();
