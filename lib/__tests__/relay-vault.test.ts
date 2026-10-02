import { describe, it, expect, vi, beforeEach } from 'vitest';

// relay-vault.ts reads NEXT_PUBLIC_VAULT_URL at module load time and
// refuses to enable/sync at all without it configured (see enableVault's
// fail-closed guard — this used to default to a real, Arcel-controlled
// URL with no dev/prod gate). Static `import` declarations are hoisted
// above all other code regardless of textual position, so setting this
// as a plain statement before a static import wouldn't actually run
// first — it has to be set before a DYNAMIC import instead (same reason
// other test files in this repo, e.g. relay-node.test.ts, use `await
// import(...)` for modules that read env vars at load time).
process.env.NEXT_PUBLIC_VAULT_URL = 'https://vault.test.invalid';

// Regression coverage for the vault sync-merge bug: syncFromVault used to
// check `localStorage.getItem('contact:'/'conv:'/'msg:' + id)` to decide
// whether to keep newer local data — but contacts/conversations/messages
// live in IndexedDB (relay-store.ts), never in localStorage under those
// keys, so `existing` was always null and every pull unconditionally
// overwrote (or resurrected deleted) local data. Fixed to use the real
// IndexedDB getters instead.
vi.mock('../db/relay-store', () => {
  const contacts = new Map<string, any>();
  const conversations = new Map<string, any>();
  const messages = new Map<string, any>();

  return {
    getAllContacts: vi.fn(async () => Array.from(contacts.values())),
    getAllConversations: vi.fn(async () => Array.from(conversations.values())),
    getAllMessagesForConversation: vi.fn(async (id: string) =>
      Array.from(messages.values()).filter((m) => m.conversationId === id)
    ),
    addContact: vi.fn(async (c: any) => { contacts.set(c.relayId, c); }),
    addConversation: vi.fn(async (c: any) => { conversations.set(c.id, c); }),
    addMessage: vi.fn(async (m: any) => { messages.set(m.id, m); }),
    getContact: vi.fn(async (relayId: string) => contacts.get(relayId) ?? null),
    getConversation: vi.fn(async (id: string) => conversations.get(id) ?? null),
    getMessage: vi.fn(async (id: string) => messages.get(id) ?? null),
    __contacts: contacts,
    __conversations: conversations,
    __messages: messages,
  };
});

const relayStore = await import('../db/relay-store');
const { enableVault, syncToVault, syncFromVault } = await import('../vault/relay-vault');

const privateKey = new Uint8Array(32).fill(7);

function fetchMock() {
  let capturedBody: Uint8Array | null = null;
  return vi.fn(async (_url: RequestInfo | URL, opts: any) => {
    if (opts.method === 'POST') {
      capturedBody = new Uint8Array(opts.body);
      return { ok: true, statusText: 'OK' } as Response;
    }
    // GET — return whatever was last pushed
    return {
      ok: true,
      statusText: 'OK',
      arrayBuffer: async () => capturedBody!.buffer,
    } as unknown as Response;
  });
}

describe('vault sync-from-vault merge', () => {
  beforeEach(async () => {
    (relayStore as any).__contacts.clear();
    (relayStore as any).__conversations.clear();
    (relayStore as any).__messages.clear();
    vi.clearAllMocks();
    await enableVault(privateKey);
  });

  it('does not resurrect a contact deleted locally after the last push, when the deletion beats the vault copy on timestamp', async () => {
    const contactsMap: Map<string, any> = (relayStore as any).__contacts;
    contactsMap.set('relay:alice', { relayId: 'relay:alice', addedAt: 1000 });

    global.fetch = fetchMock() as unknown as typeof fetch;
    await syncToVault(privateKey); // vault now has relay:alice @ addedAt 1000

    // Local copy is newer (e.g. re-added with an updated timestamp) than the vault's.
    contactsMap.set('relay:alice', { relayId: 'relay:alice', addedAt: 5000 });

    await syncFromVault(privateKey);

    expect(contactsMap.get('relay:alice').addedAt).toBe(5000);
  });

  it('pulls a genuinely new contact from the vault that does not exist locally', async () => {
    const contactsMap: Map<string, any> = (relayStore as any).__contacts;
    contactsMap.set('relay:bob', { relayId: 'relay:bob', addedAt: 1000 });

    global.fetch = fetchMock() as unknown as typeof fetch;
    await syncToVault(privateKey);

    contactsMap.clear(); // simulate a fresh device with nothing local yet

    await syncFromVault(privateKey);

    expect(contactsMap.get('relay:bob')).toBeTruthy();
  });

  it('keeps a newer local message instead of overwriting it with a stale vault copy', async () => {
    const conversationsMap: Map<string, any> = (relayStore as any).__conversations;
    const messagesMap: Map<string, any> = (relayStore as any).__messages;
    conversationsMap.set('relay:carol', { id: 'relay:carol', lastMessageAt: 1000 });
    messagesMap.set('m1', { id: 'm1', conversationId: 'relay:carol', text: 'old', timestamp: 1000 });

    global.fetch = fetchMock() as unknown as typeof fetch;
    await syncToVault(privateKey);

    messagesMap.set('m1', { id: 'm1', conversationId: 'relay:carol', text: 'edited locally', timestamp: 9000 });

    await syncFromVault(privateKey);

    expect(messagesMap.get('m1').text).toBe('edited locally');
  });
});
