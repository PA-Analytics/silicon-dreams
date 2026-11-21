import { parseReply, type SceneAction } from './chat-actions.ts';
import './chat.css';

export function createChat(execute: (action: SceneAction) => Promise<void>) {
  let conversationId: string = crypto.randomUUID();
  try {
    const stored = sessionStorage.getItem('dream-conversation');
    if (stored && /^[a-zA-Z0-9_-]{16,80}$/.test(stored)) conversationId = stored;
    sessionStorage.setItem('dream-conversation', conversationId);
  } catch { /* Private browsing may disable storage. */ }
  const windowEl = document.createElement('section');
  windowEl.className = 'win-window entity-window';
  windowEl.id = 'entity-window';
  windowEl.hidden = true;
  windowEl.setAttribute('aria-label', 'entidad.exe');
  windowEl.innerHTML = `<div class="win-titlebar"><span>entidad.exe — OpenClaw / Kimi</span><button type="button" class="win-btn entity-close" aria-label="Cerrar entidad.exe">×</button></div>
    <div class="entity-log" role="log" aria-live="polite" aria-label="Mensajes"></div>
    <form class="entity-form"><label for="entity-input">Transmitir al otro lado</label><div><input id="entity-input" maxlength="500" autocomplete="off" required placeholder="¿Hay alguien ahí?"><button class="win-btn" type="submit">Enviar</button></div></form>
    <p class="entity-status" role="status">Frecuencia abierta.</p>`;
  const button = document.createElement('button');
  button.className = 'win-btn entity-toggle';
  button.textContent = 'entidad.exe';
  button.setAttribute('aria-controls', windowEl.id);
  button.setAttribute('aria-expanded', 'false');
  document.querySelector('.taskbar')!.prepend(button);
  document.querySelector('.hud')!.append(windowEl);
  const input = windowEl.querySelector('input')!;
  const send = windowEl.querySelector<HTMLButtonElement>('[type=submit]')!;
  const status = windowEl.querySelector<HTMLElement>('.entity-status')!;
  const log = windowEl.querySelector('.entity-log')!;
  const line = (speaker: string, text: string) => {
    const p = document.createElement('p');
    p.textContent = `${speaker}: ${text}`;
    log.append(p);
    while (log.children.length > 80) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  };
  const show = (open: boolean) => {
    windowEl.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    (open ? input : button).focus();
  };
  button.onclick = () => show(windowEl.hidden);
  windowEl.querySelector<HTMLButtonElement>('.entity-close')!.onclick = () => show(false);
  windowEl.onkeydown = (event) => { if (event.key === 'Escape') show(false); };
  let sending = false;
  windowEl.querySelector('form')!.onsubmit = async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message || sending) return;
    sending = true;
    send.disabled = true;
    input.disabled = true;
    input.value = '';
    line('Tú', message);
    status.textContent = 'Buscando señal…';
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, conversationId }), signal: AbortSignal.timeout(35_000),
      });
      if (!response.ok) throw new Error('Signal lost');
      const data = await response.json();
      if (typeof data.reply !== 'string') throw new Error('Invalid signal');
      const { text, actions } = parseReply(data.reply);
      if (text) line('Entidad', text);
      for (const action of actions) await execute(action);
      status.textContent = 'Frecuencia abierta.';
    } catch {
      line('Sistema', 'Señal perdida. El otro lado no responde. Inténtalo de nuevo.');
      status.textContent = 'Sin conexión.';
    } finally {
      sending = false;
      send.disabled = false;
      input.disabled = false;
      if (!windowEl.hidden) input.focus();
    }
  };
  return { dispose() { windowEl.remove(); button.remove(); } };
}
