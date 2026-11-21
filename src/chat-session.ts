export function createConversationId(random: Pick<Crypto, 'getRandomValues'> = crypto): string {
  return Array.from(random.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function initializeChat(setup: () => { dispose(): void }): { dispose(): void } | undefined {
  try {
    return setup();
  } catch (error) {
    console.error('Chat unavailable:', error);
    return undefined;
  }
}
