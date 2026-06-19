import { Request, Response } from 'express';
import { TranscriptService } from '../services/transcript.service';
import { translateText, detectLanguage } from '../utils/youtube-parser';
import { DataProcessorService } from '../services/data-processor.service';
import { AiSummarizerService } from '../services/ai-summarizer.service';

const transcriptService = new TranscriptService();
const dataProcessor = new DataProcessorService();
const aiSummarizer = new AiSummarizerService();

/**
 * Controller to fetch full video transcript and translate it if needed.
 */
export async function getVideoTranscript(req: Request, res: Response): Promise<void> {
   try {
      const { url } = req.body;
      if (!url) {
         res.status(400).json({ error: 'Missing url' });
         return;
      }
      const transcript = await transcriptService.getFullVideoTranscript(url);
      const { language } = detectLanguage(transcript.fullCaptionText.substring(0, 500));
      console.log(`[transcriptController.getVideoTranscript] Detected language: ${language}`);
      
      const targetLanguage = 'en';
      const translatedText = await translateText(transcript.fullCaptionText, targetLanguage);
      res.json({ success: true, ...transcript, translatedText });
   } catch (error: any) {
      console.error("[transcriptController.getVideoTranscript] Error:", error.message);
      res.status(500).json({ error: error.message });
   }
}

/**
 * Controller to extract chapters, summary, and keywords from the video transcript.
 */
export async function processTranscriptOutcomes(req: Request, res: Response): Promise<void> {
  try {
    const { url } = req.body;
    if (!url) {
      res.status(400).json({ error: 'Missing video url parameter' });
      return;
    }

    const transcriptData = await transcriptService.getFullVideoTranscript(url);
    const rawText = transcriptData.fullCaptionText;

    const extractedTags = dataProcessor.extractKeywords(rawText);
    const autoChapters = dataProcessor.generateAutoChapters(transcriptData.timelineSegments);
    const aiSummary = await aiSummarizer.generateSummary(rawText);

    res.json({
      status: 'success',
      videoId: transcriptData.videoId,
      analytics: {
        aiSummary: aiSummary,
        suggestedTags: extractedTags,
        totalWordsProcessed: rawText.split(/\s+/).length,
        chapters: autoChapters
      }
    });

  } catch (error: any) {
    console.error("[transcriptController.processTranscriptOutcomes] Error:", error.message);
    res.status(500).json({ 
      error: 'Data processing engine execution failed', 
      details: error.message 
    });
  }
}
