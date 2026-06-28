import { Ollama } from 'ollama';
import { fetch as undiciFetch, Agent } from 'undici';
import { TimelineBlock } from "./timeline.service";
import { cosineSimilarity } from "../utils/youtube-parser";

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
 * Service to execute semantic RAG queries and keyword search against timeline blocks.
 */
export class SearchService {
  /**
   * Performs standard keyword search, counting term occurrences and phrase matches.
   * 
   * @param blocks List of timeline blocks to search through
   * @param query Search query text
   * @returns List of blocks with scores sorted by density in descending order
   */
  public searchTimeline(blocks: TimelineBlock[], query: string): { block: TimelineBlock; score: number }[] {
    if (!query || !Array.isArray(blocks) || blocks.length === 0) return [];

    const cleanQuery = query.toLowerCase().trim();
    if (!cleanQuery) return [];

    // Extract query terms of length > 2, removing common punctuation marks
    const searchTerms = cleanQuery
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, "")
      .split(/\s+/)
      .filter(word => word.length > 2);

    const scoredBlocks = blocks.map(block => {
      const text = block.combinedText.toLowerCase();
      let score = 0;

      // Exact substring query matching yields a high priority score boost
      if (text.includes(cleanQuery)) {
        score += 15;
      }

      // Aggregate occurrence frequency of individual search keywords
      for (const term of searchTerms) {
        const occurrences = text.split(term).length - 1;
        if (occurrences > 0) {
          score += occurrences;
        }
      }

      return { block, score };
    });

    // Return matched blocks sorted from highest keyword match density to lowest
    return scoredBlocks
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Performs semantic vector search on blocks using text embeddings.
   * 
   * @param blocks List of timeline blocks to search through
   * @param query Search query text
   * @returns Scored results above the similarity threshold, sorted by score descending
   */
  public async searchTimelineSemantic(
    blocks: TimelineBlock[], 
    query: string
  ): Promise<{ block: TimelineBlock; score: number }[]> {
    if (!query || blocks.length === 0) return [];

    // Generate local vector representation of the search query
    const queryResponse = await ollama.embeddings({
      model: 'nomic-embed-text',
      prompt: query.toLowerCase().trim()
    });

    const queryEmbedding = queryResponse.embedding;

    // Rank blocks based on mathematical cosine distance
    const scoredBlocks = blocks
      .map((block) => {
        if (!block.embedding) {
          return { block, score: 0 };
        }
        const score = cosineSimilarity(queryEmbedding, block.embedding);
        return { block, score };
      })
      // Only keep blocks that pass a threshold of 0.35 similarity
      .filter(item => item.score > 0.35);

    return scoredBlocks.sort((a, b) => b.score - a.score);
  }
}

