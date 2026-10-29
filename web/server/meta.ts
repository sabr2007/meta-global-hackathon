// Meta Model API (https://api.meta.ai/v1), called only from the server: the key never reaches a browser.

import {
  buildObjectPrompt,
  decodeMaskToRaster,
  parseImageStream,
  recordsOfKind,
  type ResponsesEvent,
} from '@meta-sam/parser';
import { encodeRle, type Rle } from '../src/ayna/rle.js';

export const SPARK_MODEL = 'muse-spark-1.3';
export const SAM_MODEL = 'sam-3.1';
export const IMAGE_MODEL = 'muse-image-1.0';
export const VOICE_MODEL = 'muse-voice-transcribe-1.0';

const DEFAULT_BASE_URL = 'https://api.meta.ai/v1';
const SPARK_TIMEOUT_MS = 90_000;
const IMAGE_TIMEOUT_MS = 60_000;
const SAM_TIMEOUT_MS = 45_000;
const VOICE_TIMEOUT_MS = 30_000;

// USD list prices (dev.meta.ai, October 2026): Spark per token, Image per picture, SAM per frame.
const SPARK_INPUT_USD = 1.25e-6;
const SPARK_OUTPUT_USD = 4.25e-6;
const IMAGE_USD = 0.01;
const SAM_USD = 0.0002;
const VOICE_USD_PER_MS = 0.18 / 3_600_000;

export type Effort = 'low' | 'medium' | 'high';

/** What one model call took: shown in the UI next to the model's name. */
export interface Usage {
  model: string;
  ms: number;
  costUsd: number;
}

export class MetaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type InputContent = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string };

export interface SamMask {
  objectId: string;
  confidence: number | null;
  box: [number, number, number, number]; // left, top, right, bottom in image pixels
  area: number;
  rle: Rle;
}

function settings(): { key: string; base: string } {
  const key = process.env.META_API_KEY?.trim();
  if (!key) throw new MetaError('META_API_KEY is not configured on the server', 500);
  return { key, base: (process.env.META_API_BASE?.trim() || DEFAULT_BASE_URL).replace(/\/$/, '') };
}

async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const { key, base } = settings();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new MetaError(timedOut ? `Meta API timed out after ${timeoutMs / 1000} s (${path})` : `Meta API unreachable (${path})`, 504);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    const status = response.status === 429 ? 429 : 502;
    throw new MetaError(`Meta API ${response.status} on ${path}: ${detail}`, status);
  }
  return response;
}

function outputText(body: { output?: { type: string; content?: { type: string; text?: string }[] }[] }): string {
  for (const item of body.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && part.text) return part.text;
    }
  }
  throw new MetaError('Muse Spark returned no text', 502);
}

/** Muse Spark with schema-constrained output (Responses API `text.format` json_schema). */
export async function sparkJson<T>(
  name: string,
  schema: object,
  content: InputContent[],
  effort: Effort = 'low',
): Promise<{ value: T; usage: Usage }> {
  const started = Date.now();
  const response = await call(
    '/responses',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SPARK_MODEL,
        input: [{ type: 'message', role: 'user', content }],
        text: { format: { type: 'json_schema', name, schema, strict: true } },
        reasoning: { effort },
      }),
    },
    SPARK_TIMEOUT_MS,
  );
  const body = await response.json();
  let value: T;
  try {
    value = JSON.parse(outputText(body)) as T;
  } catch (error) {
    if (error instanceof MetaError) throw error;
    throw new MetaError('Muse Spark returned malformed JSON', 502);
  }
  const tokens = body.usage ?? {};
  const costUsd = (tokens.input_tokens ?? 0) * SPARK_INPUT_USD + (tokens.output_tokens ?? 0) * SPARK_OUTPUT_USD;
  return { value, usage: { model: SPARK_MODEL, ms: Date.now() - started, costUsd } };
}

/** Muse Image edits one photo; returns the edited picture as a data URL. */
export async function editImage(imageDataUrl: string, prompt: string): Promise<{ dataUrl: string; usage: Usage }> {
  const started = Date.now();
  const response = await call(
    '/images/edits',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, images: [{ image_url: imageDataUrl }] }),
    },
    IMAGE_TIMEOUT_MS,
  );
  const body = await response.json();
  const b64: string | undefined = body.data?.[0]?.b64_json;
  if (!b64) throw new MetaError('Muse Image returned no picture', 502);
  const format = typeof body.output_format === 'string' ? body.output_format : 'png';
  return {
    dataUrl: `data:image/${format};base64,${b64}`,
    usage: { model: IMAGE_MODEL, ms: Date.now() - started, costUsd: IMAGE_USD },
  };
}

/** Muse Voice Transcribe, push-to-talk mode, on a 16/24 kHz mono PCM WAV clip. */
export async function transcribe(wav: Uint8Array): Promise<{ text: string; usage: Usage }> {
  const started = Date.now();
  const form = new FormData();
  // keywords / languageBias are left out on purpose: they made the model repeat words.
  form.append('request', new Blob([JSON.stringify({ model: VOICE_MODEL, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' })], { type: 'application/json' }));
  form.append('audio', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'request.wav');
  const response = await call('/asr/transcribe', { method: 'POST', body: form }, VOICE_TIMEOUT_MS);
  const body = await response.json();
  const text = typeof body.transcript === 'string' ? body.transcript.trim() : '';
  const audioMs = typeof body.audioDurationMs === 'number' ? body.audioDurationMs : 0;
  return { text, usage: { model: VOICE_MODEL, ms: Date.now() - started, costUsd: audioMs * VOICE_USD_PER_MS } };
}

/** Server-sent events of a streamed Responses API call, as parsed JSON events. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<ResponsesEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data) as ResponsesEvent;
      end = buffer.indexOf('\n\n');
    }
  }
}

async function sam(imageDataUrl: string, prompt: string): Promise<{ masks: SamMask[]; usage: Usage }> {
  const started = Date.now();
  const response = await call(
    '/responses',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SAM_MODEL,
        stream: true,
        metadata: { include_confidence: 'true' },
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'input_image', image_url: imageDataUrl },
            ],
          },
        ],
      }),
    },
    SAM_TIMEOUT_MS,
  );
  if (!response.body) throw new MetaError('SAM 3.1 returned an empty stream', 502);
  const parsed = parseImageStream(sseEvents(response.body));
  for await (const snapshot of parsed) void snapshot; // drain; the final result has every record
  const result = await parsed.finalResult;
  if (result.outcome.status !== 'completed') throw new MetaError(`SAM 3.1 did not complete (${result.outcome.reason})`, 502);
  const masks = recordsOfKind(result.records, 'mask').map((record): SamMask => {
    const { left, top, right, bottom } = record.bounds;
    const raster = decodeMaskToRaster(record.mask);
    const rle = encodeRle(raster, left, top, record.mask.width, record.mask.height);
    let area = 0;
    for (const value of raster) area += value;
    return { objectId: record.objectId, confidence: record.confidence ?? null, box: [left, top, right, bottom], area, rle };
  });
  return { masks, usage: { model: SAM_MODEL, ms: Date.now() - started, costUsd: SAM_USD } };
}

/** SAM 3.1 concept prompt: every instance of a short noun phrase. */
export function segmentConcept(imageDataUrl: string, phrase: string): Promise<{ masks: SamMask[]; usage: Usage }> {
  return sam(imageDataUrl, phrase);
}

/** SAM 3.1 object prompt: the one object inside a box (image pixels, half-open). */
export function segmentBox(
  imageDataUrl: string,
  size: { width: number; height: number },
  box: { left: number; top: number; right: number; bottom: number },
): Promise<{ masks: SamMask[]; usage: Usage }> {
  return sam(imageDataUrl, buildObjectPrompt({ size, objects: [{ id: 1, prompts: [{ frame: 0, box }] }] }));
}
