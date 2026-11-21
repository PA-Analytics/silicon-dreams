export interface ChatEnvironment {
  OPENCLAW_GATEWAY_URL?: string;
  OPENCLAW_GATEWAY_TOKEN?: string;
  OPENCLAW_AGENT?: string;
}

export async function chat(body: unknown, env: ChatEnvironment, fetcher: typeof fetch = fetch) {
  const input = body as { message?: unknown; conversationId?: unknown } | null;
  if (!input || typeof input.message !== 'string' || !input.message.trim()
    || input.message.length > 500 || typeof input.conversationId !== 'string'
    || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.conversationId)) {
    return { status: 400, body: { error: 'Invalid message or conversationId' } };
  }
  if (!env.OPENCLAW_GATEWAY_URL || !env.OPENCLAW_GATEWAY_TOKEN) {
    return { status: 503, body: { error: 'Signal unavailable' } };
  }
  try {
    const upstream = await fetcher(`${env.OPENCLAW_GATEWAY_URL.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.OPENCLAW_AGENT || 'openclaw',
        user: `silicon-dreams:${input.conversationId}`,
        messages: [{ role: 'user', content: input.message.trim() }],
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok) throw new Error('Upstream failed');
    const data = await upstream.json();
    const reply: unknown = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim() || reply.length > 20_000) throw new Error('Invalid reply');
    return { status: 200, body: { reply } };
  } catch {
    return { status: 502, body: { error: 'Signal lost' } };
  }
}
