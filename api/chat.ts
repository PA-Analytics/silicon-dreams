import { chat, type ChatEnvironment } from '../server/chat-core.ts';

interface ChatRequest extends AsyncIterable<Uint8Array | string> {
  method?: string;
  body?: unknown;
}
interface ChatResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

export const config = { maxDuration: 40 };

export async function handleChat(req: ChatRequest, res: ChatResponse, env: ChatEnvironment) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  try {
    let body = req.body;
    if (body === undefined) {
      let raw = '';
      const decoder = new TextDecoder();
      for await (const chunk of req) {
        raw += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        if (raw.length > 4096) throw new Error('Body too large');
      }
      raw += decoder.decode();
      body = JSON.parse(raw);
    } else if (typeof body === 'string') {
      body = JSON.parse(body);
    }
    const result = await chat(body, env);
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Invalid request' }));
  }
}

export default function handler(req: ChatRequest, res: ChatResponse) {
  return handleChat(req, res, process.env);
}
