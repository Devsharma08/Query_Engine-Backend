import { YoutubeTranscript } from "youtube-transcript";

async function runTests() {
   const videoId = "afLeOefHKG4";
   
   console.log("=== Test 1: Standard Fetch ===");
   try {
      const res = await YoutubeTranscript.fetchTranscript(videoId);
      console.log("Test 1 SUCCESS! Segments:", res.length);
   } catch (e: any) {
      console.error("Test 1 FAILED:", e.message);
   }

   console.log("\n=== Test 2: Modern User-Agent & Headers Fetch ===");
   try {
      const res = await YoutubeTranscript.fetchTranscript(videoId, {
         fetch: (url, init) => {
            const headers = {
               ...(init?.headers || {}),
               "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
               "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
               "Accept-Language": "en-US,en;q=0.9",
               "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
               "Sec-Ch-Ua-Mobile": "?0",
               "Sec-Ch-Ua-Platform": '"Windows"',
            };
            return fetch(url, { ...init, headers });
         }
      });
      console.log("Test 2 SUCCESS! Segments:", res.length);
   } catch (e: any) {
      console.error("Test 2 FAILED:", e.message);
   }
}

runTests();
