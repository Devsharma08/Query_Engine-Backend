import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Extend Zod schemas to support OpenAPI annotations
extendZodWithOpenApi(z);

/**
 * Registry instance serving as the central store for Zod schemas and endpoint definitions.
 */
export const registry = new OpenAPIRegistry();

// ==========================================
// Reusable Component Schemas
// ==========================================

export const AnalyzeRequestSchema = registry.register(
  'AnalyzeRequest',
  z.object({
    url: z.string().url().openapi({ example: 'https://www.youtube.com/watch?v=afLeOefHKG4' }),
    channelLink: z.string().url().optional().openapi({ example: 'https://www.youtube.com/@kidshut' })
  })
);

export const BasicVideoRequestSchema = registry.register(
  'BasicVideoRequest',
  z.object({
    url: z.string().url().openapi({ example: 'https://www.youtube.com/watch?v=afLeOefHKG4' })
  })
);

export const QueryRequestSchema = registry.register(
  'QueryRequest',
  z.object({
    question: z.string().openapi({ example: 'How can I analyze this stream?' }),
    url: z.string().url().openapi({ example: 'https://www.youtube.com/watch?v=afLeOefHKG4' }),
    timelineBlocks: z.array(z.any()).optional().openapi({ description: 'Optional pre-computed timeline blocks with embeddings' })
  })
);

export const ArchiveRequestSchema = registry.register(
  'ArchiveRequest',
  z.object({
    url: z.string().url().openapi({ example: 'https://www.youtube.com/watch?v=afLeOefHKG4' }),
    channelLink: z.string().url().optional().openapi({ example: 'https://www.youtube.com/@kidshut' }),
    onlyStreamerChat: z.boolean().optional().openapi({ example: true })
  })
);

// ==========================================
// Endpoint Declarations & Documentation
// ==========================================

// POST /api/video/analyze
registry.registerPath({
  method: 'post',
  path: '/api/video/analyze',
  summary: 'Analyze YouTube Stream',
  description: 'Scrapes transcript, logs, shifts typing latency, generates embeddings, and starts background analysis queue job.',
  request: {
    body: {
      content: {
        'application/json': { schema: AnalyzeRequestSchema }
      }
    }
  },
  responses: {
    200: {
      description: 'SSE Connection started successfully'
    }
  }
});

// POST /api/video/detail
registry.registerPath({
   method: 'post',
   path: '/api/video/detail',
   summary: 'Get video details',
   description: 'Retrieves YouTube metadata details (title, description, starts, live stream indicators) by parsing video URL.',
   request: {
      body: {
         content: {
            'application/json': { schema: BasicVideoRequestSchema }
         }
      }
   },
   responses: {
      200: {
         description: 'Video details payload'
      }
   }
});

// POST /api/ai/summarize 
registry.registerPath({
   method: 'post',
   path: '/api/ai/summarize',
   summary: 'Generate Analytical video Summary',
   description: 'Generates progressive, chronological summary points of the video transcript using the local LLM.',
   request: {
      body: {
         content: {
            'application/json': { schema: BasicVideoRequestSchema }
         }
      }
   },
   responses: {
      200: {
         description: 'SSE streaming token blocks'
      }
   }
});

// POST /api/ai/query
registry.registerPath({
   method: 'post',
   path: '/api/ai/query',
   summary: 'Query the video',
   description: 'Executes context-aware QA (RAG search) against video transcripts and chats, streaming response back.',
   request: {
      body: {
         content: {
            'application/json': { schema: QueryRequestSchema }
         }
      }
   },
   responses: {
      200: {
         description: 'SSE streaming response text tokens'
      }
   }
});

// POST /api/transcript
registry.registerPath({
   method: 'post',
   path: '/api/transcript',
   summary: 'Get video transcript',
   description: 'Pulls raw transcript closed captions, translates to target language (English), and returns contents.',
   request: {
      body: {
         content: {
            'application/json': { schema: BasicVideoRequestSchema }
         }
      }
   },
   responses: {
      200: {
         description: 'Parsed and translated video transcript structure'
      }
   }
});

// POST /api/process-outcomes
registry.registerPath({
   method: 'post',
   path: '/api/process-outcomes',
   summary: 'Compile chapters and suggested tags',
   description: 'Parses transcript segments to extract auto-chapters, keyword tags, and general statistical analytics.',
   request: {
      body: {
         content: {
            'application/json': { schema: BasicVideoRequestSchema }
         }
      }
   },
   responses: {
      200: {
         description: 'Auto-chapters list and suggested semantic tags'
      }
   }
});

// POST /api/archive/chat-or-comments
registry.registerPath({
  method: 'post',
  path: '/api/archive/chat-or-comments',
  summary: 'Fetch Stream Chat logs',
  description: 'Pulls finished stream chat replays using youtubei.js client, active live chat, or standard comments fallback.',
  request: {
    body: {
      content: { 'application/json': { schema: ArchiveRequestSchema } }
    }
  },
  responses: {
    200: { description: 'Chat messages payload list' }
  }
});

// ==========================================
// Spec Generator Helper
// ==========================================

/**
 * Returns the fully constructed OpenAPI 3.0.0 JSON specification document.
 */
export function getOpenAPIDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'Post-Stream Ingestion & Analysis Engine API',
      version: '1.0.0',
      description: 'Local semantic vector RAG search & stream parsing documentation'
    }
  });
}

