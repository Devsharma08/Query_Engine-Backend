import { Ollama } from 'ollama';

const ollama = new Ollama({ host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434' });

export interface TimelineSegment {
  text: string;
  startInSeconds: number;
  durationInSeconds: number;
}

export class DataProcessorService {
  private modelName = 'gemma3:1b';

  public async extractKeywords(text: string, maxTags: number = 8): Promise<string[]> {
    try {
      // Use local LLM to extract keywords from the text (works best when text is the summary)
      const response = await ollama.chat({
        model: this.modelName,
        messages: [
          {
            role: 'user',
            content: `Instructions: Extract up to 8 key nouns, topics, or character names from the text below. Return ONLY a comma-separated list of these words. Do not include conversational remarks, introduction, or formatting (e.g. return: "aladdin, gold, thieves").

Text:
"${text.substring(0, 1000)}"`
          }
        ],
        options: {
          temperature: 0.1,
          num_predict: 50,
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
      console.warn('[DataProcessorService] AI keyword extraction failed, using fallback:', err.message);
    }

    // Fallback: rule-based word frequency check
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

    return Object.keys(frequencyMap)
      .sort((a, b) => frequencyMap[b] - frequencyMap[a])
      .slice(0, maxTags);
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
            num_predict: 15
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