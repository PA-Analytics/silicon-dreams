import type { SceneMode } from './types.ts';
import './mode-transition.css';

/** Cover asset upload and shader compilation inside a Win95/weirdcore system dialog. */
export function createModeTransition() {
  const overlay = document.createElement('div');
  overlay.id = 'mode-transition';
  overlay.className = 'dream-transition';
  overlay.hidden = true;
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.innerHTML = '<div class="dream-win"><div class="dream-titlebar"><span>System Message — signal.exe</span><span class="dream-win-x" aria-hidden="true">×</span></div><div class="dream-win-body"><div class="dream-horizon" aria-hidden="true"><div class="dream-sky"><div class="dream-rainbow"></div><div class="dream-hill"></div></div><div class="dream-door"><span>?</span></div></div><p class="dream-title"></p><span class="dream-status"></span><div class="dream-track" aria-hidden="true"><i></i></div></div></div>';
  document.body.appendChild(overlay);
  const title = overlay.querySelector<HTMLElement>('.dream-title')!;
  const status = overlay.querySelector<HTMLElement>('.dream-status')!;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  let busy = false;
  return {
    get busy() { return busy; },
    async run(mode: SceneMode, switchScene: () => Promise<void>, minDurationMs = 950): Promise<void> {
      if (busy) return;
      busy = true;
      const focus = document.activeElement as HTMLElement | null;
      const hud = document.querySelector<HTMLElement>('.hud');
      overlay.dataset.destination = mode;
      title.textContent = mode === 'night' ? 'El día se quedó del otro lado.' : 'Creo que ya estuvimos aquí.';
      status.textContent = mode === 'night' ? 'Sintonizando la noche…' : 'Buscando la luz…';
      overlay.hidden = false;
      hud?.setAttribute('inert', '');
      document.getElementById('app')?.setAttribute('aria-busy', 'true');
      const start = performance.now();
      try {
        void overlay.offsetWidth;
        overlay.classList.add('visible');
        await wait(reducedMotion.matches ? 0 : 190);
        await switchScene();
        status.textContent = 'Señal encontrada.';
        await wait(Math.max(0, (reducedMotion.matches ? 180 : minDurationMs) - (performance.now() - start)));
      } catch (error) {
        status.textContent = 'No llegó la señal. Puedes intentarlo de nuevo.';
        console.error('Mode transition failed:', error);
        await wait(2200);
      } finally {
        overlay.classList.remove('visible');
        await wait(reducedMotion.matches ? 0 : 260);
        overlay.hidden = true;
        hud?.removeAttribute('inert');
        document.getElementById('app')?.removeAttribute('aria-busy');
        busy = false;
        if (focus?.isConnected) focus.focus({ preventScroll: true });
      }
    },
    dispose() { overlay.remove(); },
  };
}
