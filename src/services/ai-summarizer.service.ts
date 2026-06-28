import { Ollama } from 'ollama';
import { fetch as undiciFetch, Agent } from 'undici';

// Initialize a connection agent with 5-minute timeout parameters for the Ollama connection
const ollamaAgent = new Agent({
  connectTimeout: 60000,
  headersTimeout: 300000,
  bodyTimeout: 300000,
});

// Configure the Ollama instance to communicate with the local host container
const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  fetch: ((input: any, init: any) => undiciFetch(input, { ...init, dispatcher: ollamaAgent })) as any
});

/**
 * Service to generate structured, analytical video summaries utilizing local LLM models.
 */
export class AiSummarizerService {
   private modelName = 'gemma3:1b';

   /**
    * Dynamically segments the input transcript text, generates high-quality summaries per segment,
    * and recursively merges them into a single cohesive summary paragraph.
    * 
    * @param textChunk Full video transcript text
    * @returns Structured 4-5 sentence summary string
    */
   async generateSummary(textChunk: string): Promise<string> {
      if (!textChunk || !textChunk.trim()) {
         return "This video covers key concepts broken down across the timeline milestones detailed below.";
      }

      try {
         // Segment words into blocks of 2000 words to respect model context constraints
         const words = textChunk.split(/\s+/);
         const chunkSize = 2000;
         const chunks: string[] = [];
         
         for (let i = 0; i < words.length; i += chunkSize) {
            chunks.push(words.slice(i, i + chunkSize).join(' '));
         }

         const chunkSummaries: string[] = [];

         // Summarize each block sequentially using the local LLM model
         for (let index = 0; index < chunks.length; index++) {
            const chunkText = chunks[index];
            const response = await ollama.chat({
               model: this.modelName,
               messages: [
                  {
                     role: 'user',
                     content: `Instructions: Summarize the following part of a video transcript in 2-3 direct sentences. Focus only on the main events and topics discussed. Do not add conversational introductions or "Okay".
 
 Transcript section:
 """
 ${chunkText}
 """`
                  }
               ],
               options: {
                  temperature: 0.1,
                  num_predict: 150,
                  top_p: 0.9,
                  num_ctx: 4096
               }
            });
            chunkSummaries.push(response.message.content.trim());
         }

         // If we have multiple chunks, merge them into a single cohesive final summary
         if (chunkSummaries.length > 1) {
            const combinedSummaries = chunkSummaries.join("\n\n");
            const finalResponse = await ollama.chat({
               model: this.modelName,
               messages: [
                  {
                     role: 'user',
                     content: `Instructions: Combine the following section summaries into a single, cohesive, and concise summary paragraph (4-5 sentences max). Make sure to distinguish between different stories, topics, or segments mentioned. Do not state that characters from different stories are the same person (e.g. Tom Sawyer is not Aladdin). Do not start with conversational remarks.
 
 Section summaries:
 """
 ${combinedSummaries}
 """`
                  }
               ],
               options: {
                  temperature: 0.1,
                  num_predict: 200,
                  top_p: 0.9,
                  num_ctx: 4096
               }
            });
            return finalResponse.message.content.trim();
         } else {
            return chunkSummaries[0] || "This video covers key concepts broken down across the timeline milestones detailed below.";
         }
      } catch (error: any) {
         console.error('[AiSummarizerService] Local AI chunked summarizer failed:', error.message);
         return "This video covers key concepts broken down across the timeline milestones detailed below.";
      }
   }
}

