import { TimelineBlock } from './timeline.service';
import { Ollama } from 'ollama';
import { fetch as undiciFetch, Agent } from 'undici';

const ollamaAgent = new Agent({
  connectTimeout: 60000,
  headersTimeout: 300000,
  bodyTimeout: 300000,
});

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  fetch: (input, init) => undiciFetch(input, { ...init, dispatcher: ollamaAgent })
});

export class EmbeddingService {
  /**
   * Generates a single embedding vector for a given text using nomic-embed-text
   */
  public async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await ollama.embeddings({
        model: 'nomic-embed-text',
        prompt: text,
      });
      return response.embedding;
    } catch (error: any) {
      console.error(`[EMBEDDING] Failed to generate embedding: ${error.message}`);
      return [];
    }
  }

  /**
   * Generates and assigns embeddings for a list of timeline blocks in parallel
   */
  public async embedBlocks(blocks: TimelineBlock[]): Promise<TimelineBlock[]> {
    if (!Array.isArray(blocks) || blocks.length === 0) return [];
    
    console.log(`[EMBEDDING] Generating embeddings for ${blocks.length} blocks...`);
    await Promise.all(
      blocks.map(async (block) => {
        const embedding = await this.generateEmbedding(block.combinedText);
        if (embedding.length > 0) {
          block.embedding = embedding;
        }
      })
    );
    console.log(`[EMBEDDING] Successfully generated embeddings.`);
    return blocks;
  }
}