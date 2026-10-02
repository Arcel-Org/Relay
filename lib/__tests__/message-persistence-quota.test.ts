/**
 * checkStorageQuota() previously had zero callers — nothing ever surfaced
 * its result, so a user could sail past their device's IndexedDB quota with
 * no warning: persistMessage deliberately swallows write failures (so a
 * message stays visible for the current session), meaning everything since
 * quota was hit would simply be gone on the next reload with no prior
 * indication anything was wrong.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const storeMessage = vi.fn(async (_msg: unknown) => {});
const checkStorageQuota = vi.fn(async () => ({ ok: true, usedMB: 1, totalMB: 100, percentUsed: 1 }));
vi.mock('@/lib/db/relay-store', () => ({
  addMessage: (msg: unknown) => storeMessage(msg),
  checkStorageQuota: () => checkStorageQuota(),
}));

const toastWarning = vi.fn();
vi.mock('@/components/ToastNotification', () => ({
  toast: { warning: (...args: unknown[]) => toastWarning(...args), success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  storeMessage.mockClear();
  checkStorageQuota.mockClear();
  toastWarning.mockClear();
  storeMessage.mockResolvedValue(undefined);
  checkStorageQuota.mockResolvedValue({ ok: true, usedMB: 1, totalMB: 100, percentUsed: 1 });
  // Module-level throttle/once-per-session state resets with the module itself.
  vi.resetModules();
});

const baseParams = {
  id: 'msg-1',
  conversationId: 'contact-1',
  senderId: 'relay:me',
  text: 'hello',
  status: 'delivered' as const,
};

describe('persistMessage — storage quota awareness', () => {
  it('does not toast when storage is healthy and the write succeeds', async () => {
    const { persistMessage } = await import('../messaging/message-persistence');
    await persistMessage(baseParams);
    expect(storeMessage).toHaveBeenCalledTimes(1);
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it('warns immediately when the write itself fails (real, immediate data loss)', async () => {
    storeMessage.mockRejectedValueOnce(new Error('QuotaExceededError'));
    const { persistMessage } = await import('../messaging/message-persistence');

    await persistMessage(baseParams);

    expect(toastWarning).toHaveBeenCalledWith(
      'Message not saved',
      expect.stringContaining('may not survive a reload')
    );
  });

  it('warns once per session when checkStorageQuota reports the device is nearly full', async () => {
    checkStorageQuota.mockResolvedValue({ ok: false, usedMB: 95, totalMB: 100, percentUsed: 95 });
    const { persistMessage } = await import('../messaging/message-persistence');

    await persistMessage(baseParams);
    // Flush the fire-and-forget checkAndWarnStorageQuota() call.
    await new Promise((r) => setTimeout(r, 0));

    expect(toastWarning).toHaveBeenCalledWith(
      'Storage almost full',
      expect.stringContaining('95%')
    );
  });

  it('does not warn twice in the same session even across multiple persisted messages', async () => {
    checkStorageQuota.mockResolvedValue({ ok: false, usedMB: 95, totalMB: 100, percentUsed: 95 });
    const { persistMessage } = await import('../messaging/message-persistence');

    await persistMessage(baseParams);
    await new Promise((r) => setTimeout(r, 0));
    await persistMessage({ ...baseParams, id: 'msg-2' });
    await new Promise((r) => setTimeout(r, 0));

    const quotaWarnings = toastWarning.mock.calls.filter((c) => c[0] === 'Storage almost full');
    expect(quotaWarnings).toHaveLength(1);
  });
});
