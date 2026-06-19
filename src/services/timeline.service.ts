import { generateChannelId } from "../utils/youtube-parser";

/**
 * Represents a single timed event (spoken voice transcript or chat/comment).
 */
export interface TimelineEvent {
  type: 'VOICE' | 'CHAT';
  timestamp: number; // Offset from stream start in seconds
  author?: string;
  message: string;
}

/**
 * Represents a grouped window of events with stored semantic embeddings.
 */
export interface TimelineBlock {
  startInSeconds: number;
  endInSeconds: number;
  events: TimelineEvent[];
  combinedText: string;
  embedding?: number[];
}

export class TimelineService {
  /**
   * Merges transcripts (spoken text) and comments/chat logs into a single timeline,
   * adjusting chat times by typing speed offsets and sorting chronologically.
   * 
   * @param transcriptSegments Raw voice transcript segments
   * @param commentsOrChat Raw chat replay comments or standard fallback comments
   * @param videoStartTimeStr Stream starting timestamp (ISO string)
   * @param streamerChannelLink Streamer's channel URL link
   * @returns Chronologically sorted TimelineEvent array
   */
  public compileTimeline(
    transcriptSegments: any[],
    commentsOrChat: any[],
    videoStartTimeStr?: string,
    streamerChannelLink?: string
  ): TimelineEvent[] {
    const events: TimelineEvent[] = [];

    // Parse transcript segments (VOICE events)
    if (Array.isArray(transcriptSegments)) {
      for (const segment of transcriptSegments) {
        events.push({
          type: 'VOICE',
          timestamp: segment.startInSeconds || 0,
          message: segment.text || ''
        });
      }
    }

    const streamerChannelId = streamerChannelLink ? generateChannelId(streamerChannelLink) : '';

    // Parse comments and chat logs (CHAT events)
    if (Array.isArray(commentsOrChat)) {
      const videoStartMs = videoStartTimeStr ? new Date(videoStartTimeStr).getTime() : 0;

      for (const item of commentsOrChat) {
        let relativeSeconds: number | null = null;

        // Fetch timing from live chat replay offset if available
        if (typeof item.time_in_video === 'number') {
          relativeSeconds = item.time_in_video;
        } else if (item.time_in_video !== undefined && item.time_in_video !== null) {
          relativeSeconds = parseFloat(item.time_in_video);
        }
        // Fallback: Compute relative timestamp using standard comment publish date
        else if (item.publishedAt && videoStartMs > 0) {
          const commentTimeMs = new Date(item.publishedAt).getTime();
          relativeSeconds = Math.max(0, Math.floor((commentTimeMs - videoStartMs) / 1000));
        }

        if (relativeSeconds !== null && !isNaN(relativeSeconds)) {
          const isStreamer = item.is_streamer === true || item.isStreamer === true;
          const message = item.message || '';
          
          // Compensate for typing delay (assume 1.5 seconds per word typing duration)
          const wordCount = message.trim().split(/\s+/).filter((w: string) => w.length > 0).length;
          const typingDuration = wordCount * 1.5;
          const adjustedTimestamp = Math.max(0, relativeSeconds - typingDuration);

          events.push({
            type: 'CHAT',
            timestamp: adjustedTimestamp,
            author: item.author || (isStreamer ? 'Streamer' : 'User'),
            message: message
          });
        }
      }
    }

    // Sort all events chronologically from start to finish
    return events.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Batches compiled timeline events into windows of a fixed length (e.g. 120s blocks).
   * 
   * @param events Sorted timeline events
   * @param windowSeconds Window length in seconds (default is 120)
   * @returns Array of grouped timeline blocks
   */
  public generateTimelineBlocks(events: TimelineEvent[], windowSeconds: number = 120): TimelineBlock[] {
    if (events.length === 0) return [];

    const blocks: TimelineBlock[] = [];
    const maxTimestamp = events[events.length - 1].timestamp;

    for (let start = 0; start <= maxTimestamp; start += windowSeconds) {
      const end = start + windowSeconds;
      
      const windowEvents = events.filter(e => e.timestamp >= start && e.timestamp < end);

      if (windowEvents.length > 0) {
        const textParts = windowEvents.map(e => {
          const timeLabel = this.formatTimeLabel(e.timestamp);
          if (e.type === 'CHAT') {
            return `[${timeLabel}] [CHAT] ${e.author}: ${e.message}`;
          } else {
            return `[${timeLabel}] [VOICE]: ${e.message}`;
          }
        });

        blocks.push({
          startInSeconds: start,
          endInSeconds: end,
          events: windowEvents,
          combinedText: textParts.join('\n')
        });
      }
    }

    return blocks;
  }

  /**
   * Generates a readable markdown timeline summarizing all events.
   */
  public generateMarkdownTimeline(events: TimelineEvent[]): string {
    let md = "# Master Stream Timeline\n\n";
    for (const e of events) {
      const label = this.formatTimeLabel(e.timestamp);
      if (e.type === 'CHAT') {
        md += `[${label}] [CHAT] **${e.author}**: ${e.message}\n`;
      } else {
        md += `[${label}] [VOICE]: ${e.message}\n`;
      }
    }
    return md;
  }

  /**
   * Formats raw seconds into a readable label (HH:MM:SS or MM:SS).
   */
  private formatTimeLabel(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const pad = (num: number) => num.toString().padStart(2, '0');
    
    if (hrs > 0) {
      return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
  }
}
