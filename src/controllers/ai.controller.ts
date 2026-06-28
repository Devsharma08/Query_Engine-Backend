import { Request, Response } from 'express';
import { TranscriptService } from '../services/transcript.service';
import { LocalAiService } from '../services/local-ai.service';
import { SearchService } from '../services/search.service';

const transcriptService = new TranscriptService();
const localAi = new LocalAiService();
const searchService = new SearchService();

/**
 * Controller to generate an analytical bullet-point summary of a video transcript.
 * Fetches the transcript, chunks it, and feeds it progressively to the local LLM.
 * Streams intermediate chunk summary tokens and completion status via Server-Sent Events (SSE).
 * 
 * @param req Express Request object containing `url` in the body
 * @param res Express Response object configured for SSE output
 */
export async function summarizeTranscript(req: Request, res: Response): Promise<void> {
   try {
      const { url } = req.body || {};
      
      // Initialize Server-Sent Events (SSE) stream headers
      res.status(200).writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();
      
      if (!url) {
        res.write(`data:${JSON.stringify({ status: 'failure', message: 'Missing video url parameter' })}\n\n`);
        if (typeof (res as any).flush === 'function') (res as any).flush();
        res.end();
        return;
      }
  
      res.write(`data:${JSON.stringify({ status: 'progress', message: 'Starting process', percentage: 0, currentChunk: 0, totalChunks: 0 })}\n\n`);
      if (typeof (res as any).flush === 'function') (res as any).flush();
  
      // Fetch full closed captions transcript
      const transcriptData = await transcriptService.getFullVideoTranscript(url);
      
      // Request progressive summary from local AI engine and stream tokens to client
      const summaryResult = await localAi.summarizeTranscript(transcriptData.fullCaptionText, (progress) => {
        res.write(`data:${JSON.stringify(progress)}\n\n`);
        if (typeof (res as any).flush === 'function') (res as any).flush();
        
        if (progress.status === 'progress' && progress.percentage) {
          console.log(`[summarizeTranscript] ${progress.percentage}% progress`);
        }
      });
  
      // Send completed status with merged summary string
      res.write(`data:${JSON.stringify({
        status: 'completed',
        videoId: transcriptData.videoId,
        summary: summaryResult.join('\n\n')
      })}\n\n`);
      if (typeof (res as any).flush === 'function') (res as any).flush();
      
   } catch (error: any) {
      console.error("[aiController.summarizeTranscript] Error:", error.message);
      res.write(`data:${JSON.stringify({ status: 'failure', message: error.message, percentage: 0, currentChunk: 0, totalChunks: 0 })}\n\n`);
      if (typeof (res as any).flush === 'function') (res as any).flush();
   } finally {
      res.end();
   }
}

/**
 * Controller to execute natural language query QA (RAG) over a video timeline/transcript.
 * Dynamically switches between semantic vector search (if embeddings are present) and keyword density searches
 * to compile relevant context blocks, then streams the local LLM's answer back via SSE.
 * 
 * @param req Express Request object containing `url`, `question`, and optional pre-computed `timelineBlocks`
 * @param res Express Response object configured for SSE output
 */
export async function queryVideoTimeline(req: Request, res: Response): Promise<void> {
   try {
     const { url, question, timelineBlocks } = req.body || {};
     
     // Initialize SSE stream headers
     res.status(200).writeHead(200, {
       'Content-Type': 'text/event-stream',
       'Cache-Control': 'no-cache, no-store, must-revalidate',
       'Pragma': 'no-cache',
       'Expires': '0',
       'Connection': 'keep-alive',
       'X-Accel-Buffering': 'no'
     });
     if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();
 
     if (!url || !question) {
       res.write(`data: ${JSON.stringify({ status: 'error', text: 'Missing url or question fields' })}\n\n`);
       if (typeof (res as any).flush === 'function') (res as any).flush();
       res.end();
       return;
     }
 
     let searchContext = "";
 
     // Perform local search indexing if timelineBlocks are supplied
     if (Array.isArray(timelineBlocks) && timelineBlocks.length > 0) {
        let matchedResults: { block: any; score: number }[] = [];
        const hasEmbeddings = timelineBlocks.some(b => Array.isArray(b.embedding) && b.embedding.length > 0);
 
        // Run vector search if embeddings are cached, otherwise fall back to keyword matching
        if (hasEmbeddings) {
           console.log(`[aiController.queryVideoTimeline] Running semantic vector search for: "${question}"`);
           matchedResults = await searchService.searchTimelineSemantic(timelineBlocks, question);
        } else {
           console.log(`[aiController.queryVideoTimeline] Running keyword density search for: "${question}"`);
           matchedResults = searchService.searchTimeline(timelineBlocks, question);
        }
        
        // Construct contextual prompt reference from the top matching timeline blocks
        if (matchedResults.length > 0) {
           const topBlocks = matchedResults.slice(0, 3).map(item => item.block.combinedText);
           searchContext = topBlocks.join('\n\n');
           console.log(`[aiController.queryVideoTimeline] Using ${topBlocks.length} matching blocks as LLM context.`);
        }
     }
 
     // Resilient fallback: If no blocks matched, pull and use the entire text transcript as context
     if (!searchContext) {
        console.log(`[aiController.queryVideoTimeline] No direct matches. Falling back to full transcript.`);
        const transcriptData = await transcriptService.getFullVideoTranscript(url);
        searchContext = transcriptData.fullCaptionText;
      }
 
     // Query local AI engine passing the context payload and user question
     await localAi.queryVideoContext(searchContext, question, (progress) => {
       res.write(`data: ${JSON.stringify(progress)}\n\n`);
       if (typeof (res as any).flush === 'function') (res as any).flush();
     });
 
   } catch (error: any) {
     console.error("[aiController.queryVideoTimeline] Error:", error.message);
     res.write(`data: ${JSON.stringify({ status: 'error', text: error.message })}\n\n`);
     if (typeof (res as any).flush === 'function') (res as any).flush();
   } finally {
     res.end();
   }
}
