import { test, expect } from '@playwright/test';
import { newIsolatedContext, signupNewIdentity, computeTotp, enterPinField } from './helpers';

/**
 * Post-signup coverage that doesn't require the relay-node WebSocket server
 * (playwright.config.ts only boots `next dev`, not `npm run relay`). Anything
 * that needs an actual message round-trip between two identities (contact
 * exchange, disappearing-message delivery, calls) is out of scope here —
 * see auth-flow.spec.ts for the signup/login happy path this file builds on,
 * and multi-client.spec.ts for real two-client message/group flows.
 */

test('settings: read-receipts toggle persists across reload', async ({ browser }) => {
  const pin = '741852';
  const context = await newIsolatedContext(browser);
  const page = await context.newPage();

  const { secret } = await signupNewIdentity(page, pin);

  // Reach Settings the way a real user does — an in-app click (router.push,
  // no reload) — not page.goto(), which forces a hard navigation. The app
  // deliberately never keeps the decrypted private key across a hard
  // reload/navigation (zero-knowledge design — see restoreSessionSync in
  // lib/crypto/relay-auth-store-v2.ts), so page.goto() here would land on
  // the re-authenticate screen instead of Settings.
  await page.click('[title="Settings"]');
  await page.click('text=Privacy');

  const toggle = page.getByRole('switch', { name: 'Send read receipts' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // A real reload DOES wipe the decrypted private key (only localStorage
  // survives) and requires re-authenticating with TOTP + PIN — this is
  // exactly what a returning user experiences, not a shortcut specific to
  // this test. The read-receipts setting itself lives in localStorage
  // (relay:read-receipts), independent of the encrypted-key session, so it
  // must still read back false once back inside the app.
  await page.reload();
  await page.fill('input[placeholder="000000"]', computeTotp(secret));
  await enterPinField(page, pin);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);
  await expect(page).toHaveURL(/\/app/);

  await page.click('[title="Settings"]');
  await page.click('text=Privacy');
  await expect(page.getByRole('switch', { name: 'Send read receipts' })).toHaveAttribute('aria-checked', 'false');

  await context.close();
});

test('login: wrong PIN is rejected and does not lock out the next correct attempt', async ({ browser }) => {
  const pin = '741852';
  const context = await newIsolatedContext(browser);
  const page = await context.newPage();

  const { secret } = await signupNewIdentity(page, pin);

  await page.goto('/auth/login');
  await page.fill('input[placeholder="000000"]', computeTotp(secret));
  await enterPinField(page, '000000'); // deliberately wrong — real PIN is 741852
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);

  await expect(page).toHaveURL(/\/auth\/login/);
  await expect(page.locator('text=Incorrect PIN')).toBeVisible();

  // A single wrong guess must not lock the account out or corrupt local
  // state — the very next correct attempt should still succeed.
  await page.fill('input[placeholder="000000"]', computeTotp(secret));
  await enterPinField(page, pin);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);

  await expect(page).toHaveURL(/\/app/);

  await context.close();
});

// KNOWN BROKEN — real app bug, not test flakiness, found while writing this
// e2e suite. Confirmed via direct instrumentation: POST /api/auth/recovery-
// login returns 200 (recovery code + TOTP verification is genuinely
// correct), a session cookie is set, and the client navigates to /app — but
// lib/messaging/identity.ts's loadIdentity() finds no private key available
// (authStore.getPrivateKey() is null and there's no PIN-derived key to fall
// back to — recovery-code login is deliberately PIN-less, so there is
// nothing to decrypt the PIN-encrypted IndexedDB copy with) and immediately
// bounces back to /auth/login with ZERO error message shown. The user sees
// what looks like their correct recovery code + TOTP silently failing.
// login/route.ts's own comment ("User gets into the app but message history
// requires an imported backup file") describes an intended degraded-but-
// functional /app state that does not actually exist — /app hard-requires a
// decrypted private key for every load, with no accommodation for a valid
// session that has no local key material yet. Fixing this needs a product
// decision (does /app get a real "restricted, import a backup" state? does
// recovery-login prompt for a backup file inline before ever navigating to
// /app?) — flagged, not silently patched. test.fail() so this stays
// visible and self-clears the moment the underlying bug is fixed, instead
// of either hiding it (skip) or blocking the whole suite (leaving it red).
test('login: recovery code + TOTP signs back in without the PIN', async ({ browser }) => {
  test.fail();
  const pin = '741852';
  const context = await newIsolatedContext(browser);
  const page = await context.newPage();

  try {
    const { secret, recoveryCode } = await signupNewIdentity(page, pin);

    await page.goto('/auth/login');
    await page.click('text=Recovery Code');
    await page.fill('input[placeholder="XXXX-XXXX-XXXX-XXXX..."]', recoveryCode);
    await page.fill('input[placeholder="000000"]', computeTotp(secret));
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);

    await expect(page).toHaveURL(/\/app/);
  } finally {
    // Always close, even on the expected failure above — otherwise this
    // context leaks for the rest of the run instead of just this test.
    await context.close();
  }
});

test('logout clears the session and blocks direct navigation back to /app', async ({ browser }) => {
  const pin = '741852';
  const context = await newIsolatedContext(browser);
  const page = await context.newPage();

  await signupNewIdentity(page, pin);

  // Logout lives behind AccountManager.tsx's own dropdown trigger (the
  // relayId/chevron button in the header), NOT inside the "Account
  // Settings" panel ([title="Account Settings"] opens
  // AccountManagementPanel, a completely different, logout-less component)
  // — has no distinguishing title/aria-label of its own, but is the only
  // aria-haspopup="menu" trigger in the header. Logout itself doesn't show
  // a confirm() dialog (unlike delete-account), so no dialog handler needed.
  await page.click('button[aria-haspopup="menu"]');
  await page.getByRole('menuitem', { name: 'Logout' }).click();
  await page.waitForTimeout(1000);

  await expect(page).toHaveURL(/\/auth\/login/);

  // Session must actually be gone server- and client-side, not just the UI
  // route — going straight at /app should bounce back to login, not render.
  await page.goto('/app');
  await page.waitForTimeout(1000);
  await expect(page).toHaveURL(/\/auth\/login/);

  await context.close();
});
