import { YoutubeService } from "./services/google.service";

async function test() {
  try {
    const service = new YoutubeService();
    console.log("Fetching comments for afLeOefHKG4...");
    const comments = await service.getAllPastLiveComments("afLeOefHKG4");
    console.log("Success! Comments fetched:", comments.length);
  } catch (error: any) {
    console.error("Test failed with error:", error);
    if (error.response) {
      console.error("Response data:", JSON.stringify(error.response.data, null, 2));
    }
  }
}

test();
