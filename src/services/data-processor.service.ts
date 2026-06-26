import { Ollama } from 'ollama';
import { fetch as undiciFetch, Agent } from 'undici';
import { cosineSimilarity } from '../utils/youtube-parser';

const ollamaAgent = new Agent({
  connectTimeout: 60000,
  headersTimeout: 300000,
  bodyTimeout: 300000,
});

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  fetch: ((input: any, init: any) => undiciFetch(input, { ...init, dispatcher: ollamaAgent })) as any
});

export interface TimelineSegment {
  text: string;
  startInSeconds: number;
  durationInSeconds: number;
}

export class DataProcessorService {
  private modelName = 'gemma3:1b';

  private async generateEmbedding(text: string): Promise<number[]> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not defined");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text }] }
        })
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini embed failed: status ${response.status}`);
    }

    const data = await response.json() as any;
    if (data.embedding?.values) {
      return data.embedding.values;
    }
    throw new Error("Invalid response format received from Gemini API");
  }

  private async generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not defined");

    const requests = texts.map(text => ({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text }] }
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests })
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini batch embed failed: status ${response.status}`);
    }

    const data = await response.json() as any;
    if (Array.isArray(data.embeddings)) {
      return data.embeddings.map((e: any) => e.values || []);
    }
    throw new Error("Invalid response format received from Gemini batch embedding API");
  }

  public async extractKeywords(text: string, maxTags: number = 8): Promise<string[]> {
    const stopWords = new Set([
      'the', 'is', 'and', 'a', 'to', 'in', 'it', 'you', 'of', 'for', 'on', 'with', 
      'this', 'that', 'by', 'an', 'your', 'from', 'we', 'are', 'i', 'me', 'my',
      'have', 'has', 'had', 'what', 'will', 'there', 'they', 'when', 'would', 'should',
      'could', 'their', 'them', 'these', 'those', 'about', 'other', 'some', 'than', 'then',
      'into', 'only', 'more', 'also', 'just', 'here', 'now', 'very', 'even', 'how',
      'many', 'much', 'been', 'were', 'was', 'who', 'which', 'where', 'why', 'can', 'cant',
      'cannot', 'dont', 'does', 'doing', 'did', 'done', 'go', 'get', 'make', 'take', 'look',
      'come', 'give', 'use', 'find', 'want', 'tell', 'say', 'like', 'know', 'think',
      'after', 'all', 'any', 'but', 'not', 'our', 'out', 'up', 'down', 'over', 'under',
      'again', 'once', 'both', 'each', 'few', 'most', 'such', 'no', 'nor', 'own', 'same', 'so',
      'too', 'your', 'mine', 'her', 'his', 'its', 'us', 'our', 'them', 'theirs',
      'went', 'came', 'said', 'told', 'took', 'asked', 'called', 'made', 'saw', 'gave',
      'lived', 'upon', 'time', 'away', 'back', 'come', 'next', 'then', 'into', 'some',
      'down', 'first', 'about', 'again', 'very', 'must', 'should', 'would', 'could'
    ]);

    // Build frequency map from the entire text
    const words = text
      .toLowerCase()
      .replace(/\[[^\]]*\]/g, "")
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, "")
      .split(/\s+/);

    const frequencyMap: Record<string, number> = {};
    words.forEach(word => {
      if (word.length > 3 && !stopWords.has(word)) {
        frequencyMap[word] = (frequencyMap[word] || 0) + 1;
      }
    });

    const sortedWords = Object.keys(frequencyMap).sort((a, b) => frequencyMap[b] - frequencyMap[a]);

    if (sortedWords.length === 0) {
      return [];
    }

    // Select candidate words representing a target percentage split (50% High, 30% Mid, 20% Low)
    // Target candidate pool size: 30 words
    const poolSize = 30;
    const highTarget = Math.round(poolSize * 0.5); // 15
    const midTarget = Math.round(poolSize * 0.3);  // 9
    const lowTarget = Math.round(poolSize * 0.2);  // 6

    let candidates: string[] = [];
    const totalWordsCount = sortedWords.length;

    if (totalWordsCount <= poolSize) {
      candidates = sortedWords;
    } else {
      // 1. High frequency band (sample 15 from the top 20 unique words)
      const highPool = sortedWords.slice(0, 20);
      const highPicks: string[] = [];
      const highStep = Math.max(1, Math.floor(highPool.length / highTarget));
      for (let i = 0; i < highTarget && i * highStep < highPool.length; i++) {
        highPicks.push(highPool[i * highStep]);
      }

      // 2. Mid frequency band (sample 9 from the middle 30 unique words)
      const midStart = Math.max(20, Math.floor(totalWordsCount / 2) - 15);
      const midEnd = Math.min(midStart + 30, totalWordsCount);
      const midPool = sortedWords.slice(midStart, midEnd);
      const midPicks: string[] = [];
      const midStep = Math.max(1, Math.floor(midPool.length / midTarget));
      for (let i = 0; i < midTarget && i * midStep < midPool.length; i++) {
        midPicks.push(midPool[i * midStep]);
      }

      // 3. Low frequency band (sample 6 from the bottom 30 unique words with frequency >= 2)
      const lowPoolFiltered = sortedWords.filter(w => frequencyMap[w] >= 2);
      const lowPool = lowPoolFiltered.slice(-30);
      const lowPicks: string[] = [];
      const lowStep = Math.max(1, Math.floor(lowPool.length / lowTarget));
      for (let i = 0; i < lowTarget && i * lowStep < lowPool.length; i++) {
        lowPicks.push(lowPool[i * lowStep]);
      }

      candidates = Array.from(new Set([...highPicks, ...midPicks, ...lowPicks]));
    }

    // Semantic Vector Filtering using Cosine Similarity against the introduction anchor context
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && candidates.length > 0) {
      try {
        console.log(`[DataProcessorService] running semantic cosine similarity tagging for ${candidates.length} candidates...`);
        // We use the first 1,500 characters of the transcript as the anchor topic description
        const anchorText = text.substring(0, 1500).trim();
        const anchorEmbedding = await this.generateEmbedding(anchorText);

        if (anchorEmbedding && anchorEmbedding.length > 0) {
          const candidateEmbeddings = await this.generateEmbeddingsBatch(candidates);
          
          const scoredCandidates = candidates.map((word, index) => {
            const wordEmbedding = candidateEmbeddings[index];
            if (!wordEmbedding || wordEmbedding.length === 0) {
              return { word, score: 0 };
            }
            const score = cosineSimilarity(anchorEmbedding, wordEmbedding);
            return { word, score };
          });

          // Sort by similarity descending
          scoredCandidates.sort((a, b) => b.score - a.score);
          console.log(`[DataProcessorService] top semantic candidates:`, JSON.stringify(scoredCandidates.slice(0, 8), null, 2));

          const resultTags = scoredCandidates
            .slice(0, maxTags)
            .map(item => item.word);

          if (resultTags.length > 0) {
            return resultTags;
          }
        }
      } catch (embedError: any) {
        console.warn(`[DataProcessorService] Semantic embedding selection failed, falling back to local LLM:`, embedError.message);
      }
    }

    // Fallback: local LLM prompt based cleanup on candidates list
    try {
      console.log(`[DataProcessorService] Fallback to local LLM keyword selection...`);
      const response = await ollama.chat({
        model: this.modelName,
        messages: [
          {
            role: 'user',
            content: `Instructions: You are given a list of candidate words extracted from a video transcript. Filter out any common words, general verbs, adjectives, or conversational elements. Select and format up to 8 of the most relevant, descriptive nouns, topics, or names. Return ONLY a comma-separated list of these words. Do not include conversational remarks, introduction, or formatting (e.g. return: "aladdin, gold, thieves").

Candidate Words:
"${candidates.join(', ')}"`
          }
        ],
        options: {
          temperature: 0.1,
          num_predict: 50,
          num_ctx: 2048
        }
      });

      const extracted = response.message.content
        .split(',')
        .map(t => t.replace(/[.#*_\-\"\']/g, "").trim().toLowerCase())
        .filter(t => t.length > 2 && t.length < 20 && !t.includes(' '));

      if (extracted.length > 0) {
        return extracted.slice(0, maxTags);
      }
    } catch (err: any) {
      console.warn('[DataProcessorService] Fallback local LLM keyword extraction failed, using raw frequency:', err.message);
    }

    // Ultimate Fallback: Return raw top high frequency words
    return sortedWords.slice(0, maxTags);
  }

  public async generateAutoChapters(segments: TimelineSegment[]): Promise<{ timestamp: string; seconds: number; highlightText: string }[]> {
    const rawChapters: { timestamp: string; seconds: number; rawText: string; contextText: string }[] = [];
    
    // A balanced set of narrative transition cues
    const transitionPhrases = [
      'welcome', 'first', 'next', 'finally', 'then', 'now we', 'moving on', 'let\'s'
    ];

    let lastChapterSeconds = 0; // Track the time of the last chapter placement

    // Always seed the very beginning as the first chapter
    if (segments.length > 0) {
      const contextSegments = segments.slice(0, 5).map(s => s.text);
      rawChapters.push({
        timestamp: "00:00",
        seconds: 0,
        rawText: segments[0].text,
        contextText: contextSegments.join(" ")
      });
    }

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const lowerText = segment.text.toLowerCase();
      
      const timeSinceLast = segment.startInSeconds - lastChapterSeconds;
      
      // Enforce chapter spacing: min 6 minutes (360s) for matching keywords, OR forced chapter at 10 minutes (600s)
      if (timeSinceLast >= 360) {
        const matchesPhrase = transitionPhrases.some(phrase => lowerText.includes(phrase));
        const isForced = timeSinceLast >= 600;

        if (matchesPhrase || isForced) {
          const contextSegments = segments.slice(i, i + 5).map(s => s.text);
          rawChapters.push({
            timestamp: this.formatTime(segment.startInSeconds),
            seconds: segment.startInSeconds,
            rawText: segment.text,
            contextText: contextSegments.join(" ")
          });
          lastChapterSeconds = segment.startInSeconds;
        }
      }
    }

    // Generate all AI chapter titles concurrently in parallel
    const titlePromises = rawChapters.map(async (ch) => {
      // Don't call Ollama for 00:00 introduction chapter to keep it simple and clean
      if (ch.seconds === 0) {
        return {
          timestamp: "00:00",
          seconds: 0,
          highlightText: "Introduction"
        };
      }

      try {
        const response = await ollama.chat({
          model: this.modelName,
          messages: [
            {
              role: 'user',
              content: `Instructions: Create a short, professional chapter title (2-4 words max) representing the topic beginning with the text below. Return ONLY the title itself, with no quotes, periods, conversational introduction, or formatting.

Start Text:
"${ch.contextText}"`
            }
          ],
          options: {
            temperature: 0.1,
            num_predict: 15,
            num_ctx: 1024
          }
        });

        let title = response.message.content.trim().replace(/^["']|["']$/g, "");
        if (title.endsWith('.')) {
          title = title.slice(0, -1);
        }
        
        // Capitalize first letter of each word
        title = title.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

        return {
          timestamp: ch.timestamp,
          seconds: ch.seconds,
          highlightText: title || ch.rawText
        };
      } catch (err: any) {
        console.warn(`[DataProcessorService] Failed to generate AI title for chapter ${ch.timestamp}, using fallback:`, err.message);
        let fallbackText = ch.rawText.trim();
        if (fallbackText.length > 0) {
          fallbackText = fallbackText.charAt(0).toUpperCase() + fallbackText.slice(1);
        }
        return {
          timestamp: ch.timestamp,
          seconds: ch.seconds,
          highlightText: fallbackText
        };
      }
    });

    const structuralChapters = await Promise.all(titlePromises);
    return structuralChapters;
  }

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}