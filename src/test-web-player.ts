import * as dotenv from "dotenv";
import * as crypto from "crypto";

dotenv.config();

const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

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

async function testClient(label: string, clientName: string, clientVersion: string, userAgent: string) {
   const videoId = "afLeOefHKG4";
   const youtubeCookie = process.env.YOUTUBE_COOKIE;
   
   const cleanCookie = youtubeCookie 
      ? youtubeCookie.replace(/^["']|["']$/g, "").replace(/[\r\n]+/g, "").trim() 
      : undefined;

   console.log(`\n=== Running Test: ${label} ===`);
   console.log(`Client: ${clientName} (${clientVersion})`);
   console.log(`User-Agent: ${userAgent}`);

   try {
      const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': userAgent,
          'Origin': 'https://www.youtube.com',
          'Referer': 'https://www.youtube.com/',
      };

      if (cleanCookie) {
         headers['Cookie'] = cleanCookie;
         const sapisid = getSapisidFromCookie(cleanCookie);
         if (sapisid) {
            headers['Authorization'] = generateSapisidHash(sapisid);
            console.log(`Generated Authorization header: ${headers['Authorization']}`);
         } else {
            console.log("No SAPISID found in cookie.");
         }
      }

      const resp = await fetch(INNERTUBE_API_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
              context: {
                  client: {
                      clientName: clientName,
                      clientVersion: clientVersion,
                  }
              },
              videoId: videoId,
          }),
      });

      console.log(`Status: ${resp.status} ${resp.statusText}`);
      const data = await resp.json();
      console.log("Has captions property:", !!data.captions);
      console.log("PlayabilityStatus:", JSON.stringify(data.playabilityStatus));
      
      const loggedInVal = data?.responseContext?.serviceTrackingParams
         ?.find((s: any) => s.service === 'GFEEDBACK')
         ?.params?.find((p: any) => p.key === 'logged_in')?.value;
      console.log("Logged In Status (logged_in):", loggedInVal);

      if (data.captions) {
         const tracks = data.captions.playerCaptionsTracklistRenderer?.captionTracks;
         console.log("Found caption tracks:", !!tracks);
         if (tracks && tracks.length > 0) {
            console.log("First track URL:", tracks[0].baseUrl);
            
            console.log("Fetching timedtext URL...");
            const timedtextResp = await fetch(tracks[0].baseUrl + "&fmt=srv3", {
               headers: {
                  'User-Agent': userAgent,
                  'Referer': 'https://www.youtube.com/',
                  ...(cleanCookie && { 'Cookie': cleanCookie }),
                  ...(headers['Authorization'] && { 'Authorization': headers['Authorization'] })
               }
            });
            console.log(`Timedtext Status: ${timedtextResp.status} ${timedtextResp.statusText}`);
            const timedtextBody = await timedtextResp.text();
            console.log("Timedtext Body Length:", timedtextBody.length);
            console.log("Timedtext Body (first 200 chars):", timedtextBody.substring(0, 200));
         }
      }
   } catch (e: any) {
      console.error(`Error in ${label}:`, e.message);
   }
}

async function run() {
   const mobileUA = process.env.YOUTUBE_USER_AGENT || "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36";
   const desktopUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
   const androidAppUA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14)";

   // Test 1: Web Client with Desktop User-Agent
   await testClient("Web Desktop Client", "WEB", "2.20240308.01.00", desktopUA);

   // Test 2: Web Client with Mobile/Pixel 9 User-Agent
   await testClient("Web Mobile Client", "WEB", "2.20240308.01.00", mobileUA);

   // Test 3: Android App Client with Android App User-Agent
   await testClient("Android App Client", "ANDROID", "20.10.38", androidAppUA);

   // Test 4: Android App Client with Mobile/Pixel 9 User-Agent
   await testClient("Android Client with Mobile browser UA", "ANDROID", "20.10.38", mobileUA);

   // Test 5: MWEB Client with Mobile/Pixel 9 User-Agent
   await testClient("MWEB Client", "MWEB", "2.20240308.01.00", mobileUA);
}

run();

