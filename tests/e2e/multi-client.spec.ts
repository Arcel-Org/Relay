import { test, expect, type Page } from '@playwright/test';
import { newIsolatedContext, signupNewIdentity, getOwnRelayId } from './helpers';

/**
 * Real two-client crypto coverage: two separate identities, two separate
 * browser contexts, talking over the actual relay-node WebSocket server
 * (playwright.config.ts's webServer array starts it) with real key exchange
 * and real ratchet encryption — not mocked sessions like the unit tests
 * under lib/__tests__/. auth-flow.spec.ts and app-flows.spec.ts deliberately
 * stop short of this (see app-flows.spec.ts's own header comment); this
 * file is what covers the gap.
 */

const PIN = '741852';

/**
 * Add a contact by Relay ID — instant, no approval step (AddContactModal.tsx
 * has no pending/accept state; key exchange happens automatically once both
 * sides send/receive). Tries the empty-contacts-list trigger first (every
 * identity in this file starts with zero contacts), falling back to the
 * regular "start a new conversation" trigger for a second addition.
 */
async function addContact(page: Page, relayId: string) {
  const trigger = page
    .locator('text=Add First Contact')
    .or(page.locator('[title="Start new conversation"]'))
    .or(page.locator('[title="New conversation"]'))
    .first();
  await trigger.click();

  await page.fill('#add-contact-input', relayId);
  // Lookup is async/debounced — wait for the "Add Contact" button to become
  // enabled (disabled until a lookup result resolves, per AddContactModal.tsx).
  const confirmButton = page.getByRole('button', { name: 'Add Contact', exact: true });
  await expect(confirmButton).toBeEnabled({ timeout: 10_000 });
  await confirmButton.click();
}

/**
 * Opens the 1:1 conversation thread with a contact identified by its Relay
 * ID (its display name, since neither test identity here ever claims a
 * username — see AddContactModal.tsx's `profile.displayName || value`
 * fallback). Matched by role/name, not a bare `text=` locator — the same
 * Relay ID string can also appear in a "Contact added" toast or elsewhere
 * on the page, and the sidebar row's accessible name is a composite
 * ("avatar Offline <id>"), not the bare ID, so this is a substring match,
 * not `exact: true`.
 */
async function openConversation(page: Page, contactRelayId: string) {
  await page.getByRole('button', { name: contactRelayId }).click();
}

async function sendMessage(page: Page, text: string) {
  await page.fill('textarea[placeholder="Message..."]', text);
  await page.click('[aria-label="Send message"]');
}

test('1:1 messaging: a message sent by one identity is received and rendered by the other, over the real relay', async ({ browser }) => {
  const contextA = await newIsolatedContext(browser, 'A');
  const contextB = await newIsolatedContext(browser, 'B');
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await signupNewIdentity(pageA, PIN);
  await signupNewIdentity(pageB, PIN);

  const relayIdA = await getOwnRelayId(pageA);
  const relayIdB = await getOwnRelayId(pageB);

  await addContact(pageA, relayIdB);
  await addContact(pageB, relayIdA);

  const messageText = `hello from A, e2e ${test.info().testId}`;
  await openConversation(pageA, relayIdB);
  await sendMessage(pageA, messageText);

  await openConversation(pageB, relayIdA);
  // Real key exchange + ratchet encryption + relay round-trip, not instant —
  // give it real room rather than a flat sleep; toBeVisible auto-retries.
  await expect(pageB.locator(`text=${messageText}`)).toBeVisible({ timeout: 20_000 });

  await contextA.close();
  await contextB.close();
});

test('groups: creating a group, messaging it, and removing a member', async ({ browser }) => {
  // Three identities, not two: use-group-messaging.ts's removeGroupMember
  // refuses to remove a member if it would drop the group below 2 members
  // ("Group must keep at least 2 members") — a 2-person group can never
  // have anyone removed from it, by design. A (owner), B (removed), C
  // (stays) is the minimum shape that actually exercises removal.
  const contextA = await newIsolatedContext(browser, 'grpA');
  const contextB = await newIsolatedContext(browser, 'grpB');
  const contextC = await newIsolatedContext(browser, 'grpC');
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const pageC = await contextC.newPage();

  await signupNewIdentity(pageA, PIN);
  await signupNewIdentity(pageB, PIN);
  await signupNewIdentity(pageC, PIN);

  const relayIdA = await getOwnRelayId(pageA);
  const relayIdB = await getOwnRelayId(pageB);
  const relayIdC = await getOwnRelayId(pageC);

  // A group's member picker only offers existing contacts, so A must know
  // both invitees; B and C add A back so their own pairwise sessions (used
  // for the group's pairwise-fanned-out control/content envelopes) exist.
  await addContact(pageA, relayIdB);
  await addContact(pageA, relayIdC);
  await addContact(pageB, relayIdA);
  await addContact(pageC, relayIdA);

  const groupName = `E2E Group ${test.info().testId}`.slice(0, 40);

  await pageA.click('[title="New group"]');
  await pageA.fill('input[placeholder="e.g. Security team"]', groupName);
  await pageA.getByRole('button', { name: 'Next', exact: true }).click();
  // Member picker is a checkbox list of matching contacts inside the modal —
  // scoped to the dialog role, since the same Relay ID text also appears in
  // the sidebar contact row and in the "Contact added" toast underneath.
  await pageA.fill('input[placeholder="Search contacts…"]', relayIdB);
  await pageA.getByRole('dialog').getByText(relayIdB).click();
  await pageA.fill('input[placeholder="Search contacts…"]', relayIdC);
  await pageA.getByRole('dialog').getByText(relayIdC).click();
  // Not /^Create/ alone — the sidebar's "Create folder" button also matches.
  await pageA.getByRole('button', { name: /^Create \(/ }).click();

  // Group appears in both invitees' sidebars once their clients process the
  // bootstrap group_event.
  await expect(pageB.locator(`text=${groupName}`)).toBeVisible({ timeout: 20_000 });
  await expect(pageC.locator(`text=${groupName}`)).toBeVisible({ timeout: 20_000 });

  await pageA.getByRole('button', { name: groupName }).click();
  const groupMessageText = `group hello ${test.info().testId}`;
  await sendMessage(pageA, groupMessageText);

  await pageB.getByRole('button', { name: groupName }).click();
  await expect(pageB.locator(`text=${groupMessageText}`)).toBeVisible({ timeout: 20_000 });
  await pageC.getByRole('button', { name: groupName }).click();
  await expect(pageC.locator(`text=${groupMessageText}`)).toBeVisible({ timeout: 20_000 });

  // Remove B from the group (A is the owner/creator) and confirm both the
  // member-list update and the system message land — the actual epoch-key
  // rekey this triggers (lib/hooks/use-group-messaging.ts) isn't observable
  // from the UI alone; lib/__tests__/use-group-messaging-governance.test.ts
  // covers that the removed member's held key can't decrypt post-removal
  // traffic. This test covers the user-visible contract only.
  await pageA.getByRole('button', { name: groupName }).click();
  await pageA.click('[title*="Manage"]');
  await pageA.click('text=Members');
  await pageA.click('[aria-label="Member actions"]');
  pageA.once('dialog', (dialog) => dialog.accept());
  await pageA.click('text=Remove from group');

  // GroupManageModal does NOT close itself after a successful removal — the
  // group conversation underneath is still selected, but the modal's
  // backdrop keeps intercepting clicks until explicitly dismissed.
  await pageA.click('[aria-label="Close"]');
  // exact: true — the sidebar's own conversation-preview text is "System:
  // Member removed from group" (a substring match), distinct from the
  // actual system-message bubble in the thread this is meant to check.
  await expect(pageA.getByText('Member removed from group', { exact: true })).toBeVisible({ timeout: 20_000 });

  await contextA.close();
  await contextB.close();
  await contextC.close();
});
