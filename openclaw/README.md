# OpenClaw + Cerebras / Kimi

This is a separate persistent OpenClaw process, not a direct Cerebras browser
integration. No credentials are bundled. Without gateway URL/token the app API
returns 503 and entidad.exe reports a lost signal; no synthetic answers.

## Install, configure, start

Use Node 24.22.1+ or 26.12.1+. With npm <=11.15:

```sh
npm install -g openclaw@latest
# npm >=11.16 / 12: add --allow-scripts=openclaw
openclaw onboard
```

Use a **dedicated OpenClaw instance/account**, not your personal agent. After
onboarding, copy this template to that instance's ~/.openclaw/openclaw.json
(JSON5 is accepted). Do not overwrite an unrelated existing instance.

```sh
cp openclaw/openclaw.json5 ~/.openclaw/openclaw.json
export SILICON_DREAMS_WORKSPACE="$PWD/openclaw/workspace"
export CEREBRAS_API_KEY='your-cerebras-key'
export OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
openclaw gateway run
```

Keep the token securely for the app backend. If using a managed gateway service,
provide these variables to its service environment too. The workspace is an
absolute path. AGENTS.md bootstraps the persona even with every tool denied;
SKILL.md documents the matching skill. Prompt instructions are not a security
boundary: `tools: { profile: "minimal", deny: ["*"] }` removes executable tools.
Do not attach personal files, channels, plugins, or privileged agents.

**Kimi availability:** Cerebras documents architecture ID `kimi-k3.1-pro` as
Dedicated Inference. Your account may need enterprise allocation. Replace the
model ID and BOTH `cerebras/kimi-k3.1-pro` references with your assigned endpoint
ID. A normal shared API key alone may not grant Kimi access. Do not substitute
another model for the hackathon. Kimi reasons by default; verify a real turn and
action before presenting the entry. No live-key validation has been performed.

## Local app

Copy `.env.example` to `.env.local`, fill gateway URL/token (no VITE_ prefix), then
run `npm run dev`. Vite loads server-only env at startup; restart after changes.
The Vite middleware and Vercel function share the same handler. `vite preview`
only previews static assets and does not serve the API.

```sh
curl http://127.0.0.1:5186/api/chat -H 'Content-Type: application/json' \
  -d '{"message":"Llévame a la noche","conversationId":"demo-conversation-1234"}'
```

Expected: `{"reply":"... [[mode:night]]"}` (model wording/action may vary).
The app uses textContent, strips unknown action tags, and accepts only day/night.
Conversation IDs persist per browser tab in sessionStorage (new tab/session gets
a new random ID); they are routing identifiers, not authentication credentials.

## Vercel connection

Deploy the repo normally: `vercel.json` builds static `dist/`, while root
`api/chat.ts` is discovered separately as a Node function (40s max duration;
upstream timeout 30s). There are no catch-all rewrites swallowing `/api/chat`.
Vercel localhost is not your gateway host.

**Do not expose the raw operator gateway with a public Funnel/quick tunnel.**
OpenClaw's bearer token grants operator access, even when tools are denied.
Use a private authenticated ingress/reverse proxy that permits only
`POST /v1/chat/completions`, rejects other routes, and rate-limits requests.
For example, connect a named Cloudflare Tunnel to that restricted local proxy
(`cloudflared tunnel run silicon-dreams` after configuring its hostname/origin),
with an ingress policy requiring the gateway bearer credential. Do not point the
tunnel directly at unrestricted port 18789. An allowlisted private network route
from your hosting environment is preferable. Set on Vercel, server-only:

```text
OPENCLAW_GATEWAY_URL=https://your-restricted-ingress.example
OPENCLAW_GATEWAY_TOKEN=<same dedicated gateway token>
OPENCLAW_AGENT=openclaw
```

Redeploy after changing env. CEREBRAS_API_KEY belongs only on the gateway host.
Test the deployed app with the same curl above against its HTTPS `/api/chat`.
For a public demo, configure Vercel Firewall rate limiting/bot protection on
`/api/chat`, spending limits, and visitor access controls before opening access.
The handler validates payloads but does not implement distributed rate limiting
or visitor authentication. Do not allow clients to choose agent/model or session
headers. Missing keys and upstream errors return generic errors without secrets.

## References

- https://docs.openclaw.ai/install
- https://docs.openclaw.ai/gateway/openai-http-api
- https://docs.openclaw.ai/gateway/config-tools/tool-policy
- https://docs.openclaw.ai/gateway/config-tools/custom-providers
- https://docs.openclaw.ai/tools/skills
- https://inference-docs.cerebras.ai/capabilities/reasoning
- https://inference-docs.cerebras.ai/dedicated/overview
