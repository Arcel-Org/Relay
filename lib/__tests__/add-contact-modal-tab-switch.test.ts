/**
 * Regression coverage for AddContactModal's tab-switch stale-result bug.
 * The footer Add button isn't gated on `tab` — it stays enabled as long as
 * `result` is set. Switching tabs used to leave a resolved manual-search
 * result sitting there untouched, so a user could resolve a contact on the
 * Search tab, switch to Scan QR (or back), and still have an enabled Add
 * button for the stale result from the tab they just left. Fix: switching
 * tabs now clears result/isDuplicate/suggestions.
 *
 * No .tsx test files exist elsewhere in this repo (vitest.config.ts only
 * includes *.test.ts), so this uses React.createElement instead of JSX to
 * stay a plain .ts file rather than widening the shared test glob.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/messaging/username-lookup', () => ({
  resolveUserInput: vi.fn(),
}));
vi.mock('@/lib/messaging/contact-deduplication', () => ({
  findContactByIdentifier: () => null,
}));
vi.mock('@/lib/messaging/contact-qr', () => ({
  parseContactQRData: () => null,
}));
vi.mock('@/lib/crypto/relay-id', () => ({
  isValidRelayId: () => false,
}));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));

import { resolveUserInput } from '@/lib/messaging/username-lookup';
import { AddContactModal } from '../../components/AddContactModal';

beforeEach(() => {
  vi.mocked(resolveUserInput).mockReset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }));
  (window as any).BarcodeDetector = class {
    detect() { return Promise.resolve([]); }
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
});

describe('AddContactModal — switching tabs clears a resolved result', () => {
  it('THE REGRESSION: the Add button is disabled again after switching to Scan and back to Search', async () => {
    vi.mocked(resolveUserInput).mockResolvedValue({
      relayId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      profile: { displayName: 'Alice', username: 'alice' } as any,
    });

    render(createElement(AddContactModal, { isOpen: true, onClose: vi.fn(), onAdd: vi.fn(), existingContacts: [] }));

    fireEvent.change(screen.getByPlaceholderText(/@alice or xoep-4910/i), { target: { value: 'alice' } });
    const addButton = await screen.findByRole('button', { name: /^Add Contact$/i }) as HTMLButtonElement;
    await waitFor(() => expect(addButton.disabled).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: /Scan QR/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Search$/i }));

    // Same button instance (footer isn't tab-gated) — must be disabled again,
    // not still holding the stale result from before the tab switch.
    expect(addButton.disabled).toBe(true);
  });
});
