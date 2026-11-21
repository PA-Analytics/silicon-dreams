export type SceneAction = { type: 'mode'; mode: 'day' | 'night' };

export function parseReply(reply: string): { text: string; actions: SceneAction[] } {
  const actions: SceneAction[] = [];
  const text = reply.replace(/\[\[([^\]]*)\]\]/g, (_tag, value: string) => {
    if (value === 'mode:day' || value === 'mode:night') {
      actions.push({ type: 'mode', mode: value === 'mode:day' ? 'day' : 'night' });
    }
    return '';
  }).trim();
  return { text, actions };
}
