import { TimelineBlock } from './timeline.service';

export class EmbeddingService {
  /**
   * Generates a single embedding vector for a given text using Google's text-embedding-004 model
   */
  public async generateEmbedding(text: string): Promise<number[]> {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY environment variable is not defined.");
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: {
              parts: [{ text }]
            }
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json() as any;
      if (data.embedding?.values) {
        return data.embedding.values;
      }
      throw new Error("Invalid response format received from Gemini API");
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