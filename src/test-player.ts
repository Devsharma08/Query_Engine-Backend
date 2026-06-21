import * as dotenv from "dotenv";

dotenv.config();

const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_CLIENT_VERSION = '20.10.38';
const INNERTUBE_CONTEXT = {
    client: {
        clientName: 'ANDROID',
        clientVersion: INNERTUBE_CLIENT_VERSION,
    },
};
const INNERTUBE_USER_AGENT = `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`;

async function run() {
   const videoId = "afLeOefHKG4";
   const youtubeCookie = process.env.YOUTUBE_COOKIE;
   const cleanCookie = youtubeCookie ? youtubeCookie.replace(/[\r\n]+/g, "").trim() : undefined;
   
   console.log("Requesting InnerTube player API...");
   try {
      const resp = await fetch(INNERTUBE_API_URL, {
          method: 'POST',
          headers: {
              'Content-Type': 'application/json',
              'User-Agent': INNERTUBE_USER_AGENT,
              ...(cleanCookie && { 'Cookie': cleanCookie })
          },
          body: JSON.stringify({
              context: INNERTUBE_CONTEXT,
              videoId: videoId,
          }),
      });

      console.log(`Status: ${resp.status} ${resp.statusText}`);
      const data = await resp.json();
      console.log("Has captions property:", !!data.captions);
      console.log("PlayabilityStatus:", JSON.stringify(data.playabilityStatus));
      if (data.captions) {
         console.log("Captions detail:", JSON.stringify(data.captions).substring(0, 500));
      } else {
         console.log("Full response keys:", Object.keys(data));
         // Print first 1000 chars of full response
         console.log("Response JSON (first 1000 chars):", JSON.stringify(data).substring(0, 1000));
      }
   } catch (e: any) {
      console.error("Error:", e.message);
   }
}

run();
