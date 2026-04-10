import OpenAI from 'openai';
import { signedSubmissionUrl } from '@/lib/storage/supabase';

export type ExtractedSubmission = {
  name: string | null;
  brand: string | null;
  category: 'food' | 'grooming' | 'supplement' | null;
  ingredients: string[];
  confidence: number; // 0-100
  notes: string[];
};

const PROMPT = `You are extracting product metadata and ingredients from two photos of a consumer product.

Photo 1 is the FRONT of the product (brand, name, category clues).
Photo 2 is the BACK of the product (ingredients panel).

Return STRICT JSON with this shape, nothing else:
{
  "name": string | null,
  "brand": string | null,
  "category": "food" | "grooming" | "supplement" | null,
  "ingredients": string[],
  "confidence": number,
  "notes": string[]
}

Rules:
1. "category" must be one of the three enum values or null. If unsure, pick the closest and lower confidence.
2. "ingredients" must be in label order. Strip "Water (60%)" → "Water". Strip "Contains: peanuts" lines.
3. Return confidence = 0 if you cannot read either photo.
4. Return confidence < 50 if the back photo is unreadable OR the front is missing branding.
5. Output raw JSON, no markdown fences, no commentary.`;

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set.');
    _client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey,
    });
  }
  return _client;
}

export async function extractSubmissionWithClaude(opts: {
  frontPath: string;
  backPath: string;
}): Promise<ExtractedSubmission> {
  const [frontUrl, backUrl] = await Promise.all([
    signedSubmissionUrl(opts.frontPath, 600),
    signedSubmissionUrl(opts.backPath, 600),
  ]);

  const response = await getClient().chat.completions.create({
    model: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-opus-4-6',
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: frontUrl } },
          { type: 'image_url', image_url: { url: backUrl } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });

  const content = response.choices[0].message.content;
  if (!content) throw new Error('unexpected_response_type');
  // Strip optional markdown fences the model sometimes adds despite instructions
  const json = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  return JSON.parse(json) as ExtractedSubmission;
}
