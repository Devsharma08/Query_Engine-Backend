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
            console.log(`[Fetch Request] URL: ${url}`);
            try {
               const response = await fetch(url, {
                  ...init,
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
