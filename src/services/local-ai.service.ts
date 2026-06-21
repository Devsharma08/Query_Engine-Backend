import { Ollama } from 'ollama';

const ollama = new Ollama({ host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434' });

export class LocalAiService {
  private modelName = 'gemma3:1b';

  /**
   * Generates a structural summary cleanly by processing text in steps
   */
async summarizeTranscript(
  transcriptText: string,
  chunkToken: (chunkTokenData: { index?: number, chunkText?: string, percentage?: number, status: 'progress' | 'token' }) => void
): Promise<string[]> {
  try {
    const words = transcriptText.split(/\s+/);
    const chunkSize = 2000;
    const chunks: string[] = [];
    
    for (let i = 0; i < words.length; i += chunkSize) {
      chunks.push(words.slice(i, i + chunkSize).join(' '));
    }

    const totalChunks = chunks.length;
    let finishedChunksCount = 0;
    const summaryResults: string[] = [];

    for (let index = 0; index < chunks.length; index++) {
      const chunkText = chunks[index];
      let chunkSummary = ''; // Accumulate summary text per chunk

      const response = await ollama.chat({
        model: this.modelName,
        messages: [
          {
            role: 'system',
            content: 'You are an analytics assistant. Provide a detailed summary of the video segment in bullet points. Do not print short conversational replies.'
          },
          {
            role: 'user',
            content: chunkText 
          }
        ],
        options: {
          temperature: 0.1,
          num_predict: 200,
          top_p: 0.9,
          
        },
        stream:true
      });

      
     for await(const token of response){
      let tempText = token.message.content ;
      chunkSummary += tempText ;
        chunkToken({
          chunkText:tempText,
          index:index,
          percentage:Math.round((index/chunks.length)*100),
          status:'token',
        })
     }

      finishedChunksCount++;
      chunkToken({
        percentage:Math.round((finishedChunksCount/chunks.length)*100),
        status:'progress',
      })

      let cleanSummary = chunkSummary.trim();
      
      // Strip conversational intros from the model response if they don't start with a bullet point
      if (cleanSummary && !cleanSummary.startsWith('-') && !cleanSummary.startsWith('*') && !cleanSummary.startsWith('•')) {
        const lines = cleanSummary.split('\n');
        if (lines.length > 1) {
          lines.shift();
          cleanSummary = lines.join('\n').trim();
        }
      }

      // Only print the main header block for the very first iteration
      if (index === 0) {
        summaryResults.push(`--- Stream Summary Notes ---\n${cleanSummary}`);
      } else {
        summaryResults.push(`\n${cleanSummary}`);
      }
    }
    
    return summaryResults;

  } catch (error: any) {
    console.error('Ollama Chunking Pipe Failure:', error.message);
    chunkToken?.({
      percentage: 0,
      status: 'progress'
    });
    throw new Error(`Local inference engine dropped frame processing tasks: ${error.message}`);
  }
}
  /**
   * Resilient Question Answering over Context
   */
  async queryVideoContext(
      transcriptText: string, 
      userQuestion: string,
      streamChunks: (streamData: { text?: string, status: 'progress' | 'token' | 'completed' | 'error' }) => void
    ): Promise<string> {
      try {
        let targetedContext = transcriptText.trim();
  
        // Only run sentence-level keyword filtering if the input is a large full-length raw transcript.
        // If it is pre-selected blocks (under 8,000 characters), pass it directly to preserve full context.
        if (transcriptText.length > 8000) {
          const stopWords = new Set(['who', 'what', 'where', 'how', 'why', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'to', 'for', 'in', 'on', 'of', 'and', 'but', 'or', 'you', 'your', 'he', 'she', 'they', 'it', 'did', 'do', 'does']);
          
          const searchTerms = userQuestion.toLowerCase()
            .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, "")
            .split(/\s+/)
            .filter(word => word.length >= 3 && !stopWords.has(word));
  
          if (searchTerms.length > 0) {
            const sentences = transcriptText.split(/[.!?\n]+/);
            const matchingSnippets = sentences.filter(sentence => 
              searchTerms.some(term => sentence.toLowerCase().includes(term))
            ).slice(0, 20);
  
            targetedContext = matchingSnippets.join('. ').trim();
          }

          // Resilient Fallback: If no sentences matched the keywords (e.g. spelling typo like "alladin" vs "aladdin" or general question),
          // take a larger slice of the transcript so we don't return an empty context.
          if (!targetedContext) {
            console.log(`[localAi.queryVideoContext] No matches for search terms ${JSON.stringify(searchTerms)}. Falling back to first 30000 chars of transcript.`);
            targetedContext = transcriptText.substring(0, 30000).trim();
          }
        }
  
        if (!targetedContext) {
          const fallbackMsg = "No specific sections matching your question keywords could be indexed in the video recording.";
          streamChunks({ text: fallbackMsg, status: 'completed' });
          return fallbackMsg;
        }
  
        console.log(`[localAi.queryVideoContext] Sending targeted context of size ${targetedContext.length} chars to Ollama.`);
  
        const responseStream = await ollama.chat({
          model: this.modelName,
          messages: [
            {
              role: 'user',
              content: `Instructions: Answer the question comprehensively and precisely using ONLY the provided video context. Provide a detailed, complete response (2-4 sentences) explaining the details. If the answer is completely missing, reply with "Information not located in video context". Do not start your response with "Okay", "Sure", or any introductory remarks.

Context:
"""
${targetedContext}
"""

Question: ${userQuestion}`
            }
          ],

          options: {
            temperature: 0.1,
            num_predict: 250,
            top_p: 0.9,
          },
          stream: true
        });

      let fullResponse = '';

      for await (const tempChunk of responseStream) {
        const textChunk = tempChunk.message.content;
        fullResponse += textChunk;
        
        streamChunks({
          text: textChunk,
          status: 'token'
        });
      }

      streamChunks({ text: fullResponse, status: 'completed' });
      return fullResponse;

    } catch (error: any) {
      console.error('Ollama Query Error:', error.message);
      streamChunks({ text: "", status: 'error' });
      throw new Error('Local chat processing dropped.');
    }
  }
}
