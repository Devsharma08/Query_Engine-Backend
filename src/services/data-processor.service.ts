import { Ollama } from 'ollama';
import { fetch as undiciFetch, Agent } from 'undici';
import { cosineSimilarity } from '../utils/youtube-parser';

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

export interface TimelineSegment {
  text: string;
  startInSeconds: number;
  durationInSeconds: number;
}

/**
 * Service to process transcript structures, extract keywords via semantic vector anchors,
 * and automatically compile chapter timestamps and titles using local LLMs.
 */
export class DataProcessorService {
  private modelName = 'gemma3:1b';

  /**
   * Computes the cosine similarity value between two numeric vectors.
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    return cosineSimilarity(vecA, vecB);
  }

  /**
   * Requests a vector representation of the text using Google's generative language embedding API.
   * 
   * @param text Input text content
   * @returns High-dimensional float array representing the text
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not defined in environment variables.");

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

  /**
   * Requests vector representations for a batch of strings concurrently.
   * 
   * @param texts Array of string payloads
   * @returns Array containing vector arrays for each string input
   */
  private async generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not defined in environment variables.");

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

  /**
   * Extracts and cleans the top semantic keyword tags from transcript texts.
   * Filters out common stop words, calculates candidate frequency, compares semantic vectors
   * against an introduction/description anchor context, and cleans filler words using the local LLM.
   * 
   * @param text Raw transcript text
   * @param maxTags Maximum tags to return (defaults to 8)
   * @param description Optional video description metadata to use as the semantic anchor
   * @returns Clean, translated lowercase keyword strings array
   */
  public async extractKeywords(text: string, maxTags: number = 8, description?: string): Promise<string[]> {
    const stopWords = new Set([
      // English stop words
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
      'down', 'first', 'about', 'again', 'very', 'must', 'should', 'would', 'could',
      'guys', 'hello',

      // Devanagari Hindi stop words & grammatical particles
      'गाइस', 'हेलो', 'आपको', 'कितनी', 'क्या', 'आपका', 'मैंने', 'आपने', 'मुझे', 'हमारा', 'तुम्हारा',
      'उनका', 'उसका', 'इसको', 'उसको', 'किया', 'दिया', 'लिया', 'रहा', 'रही', 'रहे', 'होता', 'होती',
      'होते', 'होना', 'होने', 'करते', 'करना', 'करने', 'जाता', 'जाती', 'जाते', 'जाना', 'जाने',
      'सकता', 'सकती', 'सकते', 'सकना', 'सकने', 'बारे', 'लिए', 'जैसे', 'वैसे', 'कैसे', 'ऐसे',
      'यहाँ', 'वहाँ', 'कहाँ', 'जहाँ', 'अब', 'जब', 'तब', 'कब', 'और', 'तथा', 'एवं', 'या', 'अथवा',
      'लेकिन', 'किन्तु', 'परन्तु', 'मगर', 'क्योंकि', 'इसलिए', 'ताकि', 'जिससे', 'जिसने', 'जिसको',
      'जिसके', 'जिसकी', 'जिसमें', 'जिसपर', 'नहीं', 'कोई', 'कुछ', 'बहुत', 'सारे', 'सकता', 'सकते',

      // Hinglish (Latin-transliterated Hindi) stop words & particles
      'hai', 'hain', 'tha', 'thi', 'the', 'ho', 'kar', 'kya', 'kaha', 'kab', 'ab', 'jab', 'tab',
      'aur', 'ya', 'lekin', 'magar', 'ki', 'ko', 'se', 'me', 'mein', 'pe', 'par', 'ne', 'toh',
      'bhi', 'hi', 'hee', 'karke', 'karna', 'karne', 'diya', 'liya', 'gaya', 'gayi', 'gaye',
      'jana', 'jane', 'sab', 'is', 'us', 'yeh', 'ye', 'wo', 'voh', 'wah', 'main', 'hum', 'tum',
      'aap', 'mujhe', 'humein', 'tujhe', 'aapko', 'mera', 'meri', 'mere', 'hamara', 'hamari',
      'hamare', 'tumhara', 'tumhari', 'tumhare', 'uska', 'uski', 'uske', 'unka', 'unki', 'unke',
      'iske', 'iski', 'iska', 'inke', 'inki', 'inka'
    ]);

    // Build frequency maps
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

    // Select candidate words representing a target percentage split (50% High, 30% Mid, 20% Low frequency)
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

    let rankedCandidates = candidates.slice(0, 15);

    // Filter candidates semantically using Cosine Similarity against the anchor context
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && candidates.length > 0) {
      try {
        let anchorText = (description && description.trim()) ? description.trim() : text.substring(0, 1500).trim();
        if (anchorText.length > 4000) {
          anchorText = anchorText.substring(0, 4000);
        }
        console.log(`[DataProcessorService] running semantic cosine similarity tagging for ${candidates.length} candidates...`);
        const anchorEmbedding = await this.generateEmbedding(anchorText);

        if (anchorEmbedding && anchorEmbedding.length > 0) {
          const candidateEmbeddings = await this.generateEmbeddingsBatch(candidates);
          
          const scoredCandidates = candidates.map((word, index) => {
            const wordEmbedding = candidateEmbeddings[index];
            if (!wordEmbedding || wordEmbedding.length === 0) {
               return { word, score: 0 };
            }
            const score = this.cosineSimilarity(anchorEmbedding, wordEmbedding);
            return { word, score };
          });

          // Sort by score descending and return the top 15 candidates
          scoredCandidates.sort((a, b) => b.score - a.score);
          rankedCandidates = scoredCandidates.map(item => item.word).slice(0, 15);
        }
      } catch (embedError: any) {
        console.warn(`[DataProcessorService] Semantic embedding selection failed, fallback to raw frequency:`, embedError.message);
      }
    }

    // Call the local LLM to translate and filter filler words
    try {
      console.log(`[DataProcessorService] translating & filtering ${rankedCandidates.length} candidates via local LLM...`);
      const response = await ollama.chat({
        model: this.modelName,
        messages: [
          {
            role: 'user',
            content: `Instructions: You are given a list of candidate words extracted from a video transcript. Some words may be in Devanagari/Hindi or other languages.
1. Translate all non-English words to English (e.g. "रिज्यूे" -> "resume", "सीएसएस" -> "css", "बैकग्राउंड" -> "background").
2. Filter out any common conversational filler words, pronouns, adjectives, or general verbs (like "guys", "hello", "what", "you", "me", "your", "my", "how", "this", "that").
3. Select and return ONLY a comma-separated list of the top 8 most relevant, clean English keywords. Do NOT include conversational remarks, quotes, or formatting.
 
 Candidate Words:
 "${rankedCandidates.join(', ')}"`
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
        console.log(`[DataProcessorService] successfully generated tags:`, JSON.stringify(extracted.slice(0, maxTags)));
        return extracted.slice(0, maxTags);
      }
    } catch (err: any) {
      console.warn('[DataProcessorService] Local LLM keyword cleanup failed, using raw frequency:', err.message);
    }

    // Fallback: Return raw top high frequency words
    return sortedWords.slice(0, maxTags);
  }

  /**
   * Generates auto-chapters for the video timeline.
   * Identifies narrative transition points (welcome, first, next, finally, etc.)
   * and queries the local LLM concurrently to generate professional chapter titles.
   * 
   * @param segments Video timeline segments containing offsets and spoken text
   * @returns Array containing auto-generated chapters with timestamp, offset, and highlight title
   */
  public async generateAutoChapters(segments: TimelineSegment[]): Promise<{ timestamp: string; seconds: number; highlightText: string }[]> {
    const rawChapters: { timestamp: string; seconds: number; rawText: string; contextText: string }[] = [];
    
    // Narrative transition cues
    const transitionPhrases = [
      'welcome', 'first', 'next', 'finally', 'then', 'now we', 'moving on', 'let\'s'
    ];

    let lastChapterSeconds = 0;

    // Seed the first segment at 00:00 as the introduction chapter
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
      
      // Enforce chapter spacing guardrails: minimum 6 minutes (360s) for matched transition phrases,
      // or a forced chapter cut at 10 minutes (600s).
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

    // Generate AI titles concurrently in parallel
    const titlePromises = rawChapters.map(async (ch) => {
      // Return static introduction title for the starting segment
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

  /**
   * Formats raw seconds to MM:SS string representation.
   */
  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}