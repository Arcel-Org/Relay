/**
 * Regression coverage for GroupManageModal's join-approval ordering race.
 * resolveJoin used to POST /api/groups/pending (which resolves/removes the
 * request server-side) BEFORE calling onAddMembers (the actual client-
 * driven membership grant). A failure in onAddMembers after the server had
 * already resolved the request left the requester silently
 * approved-but-never-added, with no way to retry — the request no longer
 * existed to re-approve. Fix: grant membership first, only resolve the
 * request server-side once that succeeds.
 *
 * No .tsx test files exist elsewhere in this repo (vitest.config.ts only
 * includes *.test.ts), so this uses React.createElement instead of JSX to
 * stay a plain .ts file rather than widening the shared test glob.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/features/chat-folders', () => ({
  isPinned: () => false,
  setPinned: vi.fn(),
  isMuted: () => false,
  setMuted: vi.fn(),
}));
vi.mock('./UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('@/lib/auth/account-manager', () => ({ getAccountProfile: () => null }));

import { GroupManageModal } from '../../components/GroupManageModal';

const GROUP = {
  id: 'group-1',
  name: 'Test Group',
  memberIds: ['owner-1', 'member-2'],
  ownerId: 'owner-1',
  adminIds: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  visibility: 'public' as const,
  joinPolicy: 'request' as const,
};

function noop() { return Promise.resolve(); }

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/groups/pending?')) {
        return Promise.resolve({ ok: true, json: async () => ({ pendingMembers: [], pendingRequests: ['requester-9'] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ pendingMembers: [], pendingRequests: [] }) });
    })
  );
});

describe('GroupManageModal — resolveJoin ordering', () => {
  it('THE REGRESSION: grants membership before resolving the request server-side', async () => {
    const callOrder: string[] = [];
    const onAddMembers = vi.fn(async () => { callOrder.push('onAddMembers'); });
    const fetchMock = vi.mocked(fetch);
    const originalImpl = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: any, init?: any) => {
      if (init?.method === 'POST' && url === '/api/groups/pending') {
        callOrder.push('resolve-POST');
      }
      return originalImpl(url, init);
    });

    render(
      createElement(GroupManageModal, {
        isOpen: true,
        group: GROUP,
        contacts: [],
        currentUserId: 'owner-1',
        onClose: vi.fn(),
        onRename: noop,
        onSetDisappearingMessages: noop,
        onAddMembers,
        onRemoveMember: noop,
        onSetAdmin: noop,
        onTransferOwnership: noop,
        onLeave: noop,
      })
    );

    fireEvent.click(screen.getByRole('button', { name: /^Members$/i }));
    const approveButton = await screen.findByRole('button', { name: /^Approve$/i });
    fireEvent.click(approveButton);

    await waitFor(() => expect(onAddMembers).toHaveBeenCalledWith('group-1', ['requester-9']));
    await waitFor(() => expect(callOrder).toContain('resolve-POST'));
    expect(callOrder).toEqual(['onAddMembers', 'resolve-POST']);
  });
});
