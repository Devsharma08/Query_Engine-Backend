import { Ollama } from 'ollama';
import { fetch as undiciFetch, Agent } from 'undici';

const ollamaAgent = new Agent({
  connectTimeout: 60000,
  headersTimeout: 300000,
  bodyTimeout: 300000,
});

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  fetch: ((input: any, init: any) => undiciFetch(input, { ...init, dispatcher: ollamaAgent })) as any
});

export class AiSummarizerService {
   private modelName = 'gemma3:1b';

   async generateSummary(textChunk: string): Promise<string> {
      if (!textChunk || !textChunk.trim()) {
         return "This video covers key concepts broken down across the timeline milestones detailed below.";
      }

      try {
         const words = textChunk.split(/\s+/);
         const chunkSize = 2000;
         const chunks: string[] = [];
         
         for (let i = 0; i < words.length; i += chunkSize) {
            chunks.push(words.slice(i, i + chunkSize).join(' '));
         }

         const chunkSummaries: string[] = [];

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
                  num_ctx: 2048
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
                  num_ctx: 2048
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
