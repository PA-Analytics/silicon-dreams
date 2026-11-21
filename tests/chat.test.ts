import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReply } from '../src/chat-actions.ts';
import { chat } from '../server/chat-core.ts';
import { handleChat } from '../api/chat.ts';
import { createConversationId, initializeChat } from '../src/chat-session.ts';

test('conversation IDs work without secure-context randomUUID', () => {
  const random = { getRandomValues: crypto.getRandomValues.bind(crypto) };
  const id = createConversationId(random);
  assert.match(id, /^[a-zA-Z0-9_-]{16,80}$/);
  assert.notEqual(id, createConversationId(random));
});

test('chat setup failures are contained and successful cleanup is retained', (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  assert.equal(initializeChat(() => { throw new Error('DOM or crypto unavailable'); }), undefined);
  assert.equal(errors.mock.callCount(), 1);
  let disposed = false;
  initializeChat(() => ({ dispose() { disposed = true; } }))?.dispose();
  assert.equal(disposed, true);
});

const body = { message: 'Hola', conversationId: '12345678-1234-1234-1234-123456789abc' };
const env = { OPENCLAW_GATEWAY_URL: 'http://localhost:18789/', OPENCLAW_GATEWAY_TOKEN: 'test-token' };

test('parser strips tags and preserves ordered allowlisted actions', () => {
  assert.deepEqual(parseReply('Ven. [[mode:night]] [[exec:bad]] [[mode:day]]'), {
    text: 'Ven.', actions: [{ type: 'mode', mode: 'night' }, { type: 'mode', mode: 'day' }],
  });
  assert.deepEqual(parseReply(''), { text: '', actions: [] });
  assert.deepEqual(parseReply('Hola'), { text: 'Hola', actions: [] });
  assert.deepEqual(parseReply('[[mode:evil]]'), { text: '', actions: [] });
});

test('chat forwards through OpenClaw and returns only reply', async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, 'http://localhost:18789/v1/chat/completions');
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(init!.body as string), {
      model: 'openclaw', user: `silicon-dreams:${body.conversationId}`,
      messages: [{ role: 'user', content: 'Hola' }], stream: false,
    });
    assert.ok(init!.signal);
    return Response.json({ choices: [{ message: { content: 'Ven. [[mode:night]]' } }] });
  };
  assert.deepEqual(await chat(body, env, fetcher), { status: 200, body: { reply: 'Ven. [[mode:night]]' } });
});

test('missing environment returns 503 without fetching', async () => {
  assert.equal((await chat(body, {}, async () => { throw new Error('Must not call'); })).status, 503);
});

test('invalid and empty inputs return 400', async () => {
  for (const input of [null, {}, { ...body, message: '' }, { ...body, message: ' ' },
    { ...body, message: 'a'.repeat(501) }, { ...body, conversationId: '../oops' },
    { ...body, conversationId: 12 }, { ...body, message: 12 }]) {
    assert.equal((await chat(input, env)).status, 400);
  }
});

test('upstream errors, timeout, empty and malformed responses become generic 502', async () => {
  for (const fetcher of [
    async () => new Response('private upstream detail', { status: 401 }),
    async () => { throw new DOMException('private detail', 'TimeoutError'); },
    async () => Response.json({}),
    async () => Response.json({ choices: [{ message: { content: '' } }] }),
    async () => new Response('not json'),
  ]) {
    assert.deepEqual(await chat(body, env, fetcher), { status: 502, body: { error: 'Signal lost' } });
  }
});

test('HTTP adapter rejects methods and invalid JSON; handles missing env', async () => {
  for (const [method, input, expected] of [['GET', undefined, 405], ['POST', '{', 400], ['POST', body, 503]] as const) {
    let output = '';
    const res = { statusCode: 0, setHeader() {}, end(value = '') { output = value; } };
    const req = { method, body: input, async *[Symbol.asyncIterator]() {} };
    await handleChat(req, res, {});
    assert.equal(res.statusCode, expected);
    assert.ok(JSON.parse(output).error);
  }
});
