import { franc } from "franc";
import translate from "translate";

export function extractVideoId(url: string): string | null {
  const regExp = /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|live\/)|(?:(?:watch)?\?v(?:i)?=|\&v(?:i)?=))([^#\&\?]*).*/;
  const match = url.match(regExp);
  console.log("mached id", match);
  return (match && match[1].length === 11) ? match[1] : null;
}


export function normaliseDate(date: string): string {
  const d = new Date(date);
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  })
}

export function generateChannelId(url?: string): string {
  if (!url) return "";
  const regExp = /^.*(?:https?:\/\/)?(?:www\.)?youtube\.com\/@([a-zA-Z0-9_-]+).*/;
  const match = url.match(regExp);
  return match ? match[1] : "";
}

export const detectLanguage = (text: string) => {
  try {
    const iso3Code = franc(text);
    const mapping: Record<string, string> = {
      eng: 'en',
      spa: 'es',
      fra: 'fr',
      ger:'de',
      nld:'nl',
      por:'pt',
      rus:'ru',
      ita:'it',
      swe:'sv',
      kor:'ko',
      jpn:'ja',
      ara:'ar',
      tur:'tr',
      ell:'el',

      // Indian Language Mappings
      hin: 'hi', // Hindi
      ben: 'bn', // Bengali
      tel: 'te', // Telugu
      mar: 'mr', // Marathi
      tam: 'ta', // Tamil
      urd: 'ur', // Urdu
      guj: 'gu', // Gujarati
      kan: 'kn', // Kannada
      mal: 'ml', // Malayalam
      ory: 'or', // Odia
      pan: 'pa', // Panjabi
      asm: 'as'  // Assamese

    }

    const language = mapping[iso3Code] || 'en';
    return {
      language,
      iso3Format:iso3Code
    }
  } catch (error) {
    return {
      language: 'en',
      iso3Format:'eng'
    }
  }
}

export const translateText = async(text:string,targetLanguage:string)=>{
  try {
    const chunks = text.match(/[\s\S]{1,2500}/g) || [text];
    let translatedChunks:string[] = [];

    for(const chunk of chunks){
      const translatedChunk:any = await translate(chunk,{to:targetLanguage});
      translatedChunks.push(translatedChunk);
    }

    return translatedChunks.join('');
    
  } catch (error:any) {
    console.error("error during translation",error);
    throw new Error(`The public translation node rejected the batch: ${error.message}`);
  }
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}