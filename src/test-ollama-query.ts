import { fetch as undiciFetch, Agent } from 'undici';
import { Ollama } from 'ollama';

const ollamaAgent = new Agent({
  connectTimeout: 60000,
  headersTimeout: 300000,
  bodyTimeout: 300000,
});

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  fetch: (input: any, init: any) => undiciFetch(input, { ...init, dispatcher: ollamaAgent })
});

async function test() {
  const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  console.log(`Sending query to Ollama at host: ${host}`);
  try {
    const response = await ollama.chat({
      model: 'gemma3:1b',
      messages: [{ role: 'user', content: 'hi' }]
    });
    console.log("Ollama Response:", response);
  } catch (error) {
    console.error("Test Failed:", error);
  }
}

test();
