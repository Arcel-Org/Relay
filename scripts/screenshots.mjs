// Produces product screenshots by driving the REAL app end-to-end against a
// running stack: two real identities sign up through the UI, add each other
// as contacts, and exchange actual end-to-end-encrypted messages over the
// relay — then capture the messenger, account settings, and the marketing
// landing/login pages. Reuses the selectors proven in tests/e2e/.
//
// Usage (stack must be up; NEXT_PUBLIC_RELAY_URL must reach the relay):
//   APP_URL=http://127.0.0.1:23100 node scripts/screenshots.mjs <outdir>
const { chromium } = await import('@playwright/test');
import { TOTP, Secret } from 'otpauth';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:23100';
const OUT = process.argv[2] || 'screenshots';
const PIN = '741852';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function testIp(label) {
  const h = createHash('sha256').update(`screenshot:${label}`).digest();
  return `10.${h[0]}.${h[1]}.${h[2]}`;
}
function computeTotp(base32) {
  return new TOTP({ secret: Secret.fromBase32(base32.replace(/\s/g, '')), digits: 6, period: 30 }).generate();
}

// Robust click: the app shows transient "Connection failed" toasts during WS
// reconnection that overlap target elements and make Playwright's
// actionability check abort. Retry a few times, giving a toast a moment to
// clear between attempts.
async function click(page, locator) {
  for (let i = 0; i < 6; i++) {
    try {
      await locator.waitFor({ state: 'visible', timeout: 15000 });
      await locator.click({ timeout: 5000 });
      return;
    } catch (e) {
      await sleep(600);
    }
  }
  await locator.click({ timeout: 10000 }); // surface the final error
}

async function fill(page, sel, value) {
  for (let i = 0; i < 6; i++) {
    try {
      await page.locator(sel).waitFor({ state: 'visible', timeout: 15000 });
      await page.locator(sel).fill(value, { timeout: 5000 });
      return;
    } catch (e) {
      await sleep(600);
    }
  }
  await page.locator(sel).fill(value, { timeout: 10000 });
}

async function enterPinKeypad(page, pin) {
  for (const digit of pin.split('')) {
    await click(page, page.getByRole('button', { name: `Digit ${digit}`, exact: true }));
    await sleep(100);
  }
}

async function signup(page) {
  await page.goto(`${APP_URL}/auth/landing`);
  await click(page, page.getByText('Create new identity'));
  await sleep(800);
  await click(page, page.getByText('Authenticator App'));
  await sleep(800);
  await click(page, page.getByText("Can't scan? Enter manually")).catch(() => {});

  const secret = (await page.textContent('body'))?.match(/[A-Z2-7]{16,64}/)?.[0];
  if (!secret) throw new Error('no TOTP secret');
  await fill(page, 'input[placeholder="000000"]', computeTotp(secret));
  await click(page, page.getByText('Verify & Continue'));
  await sleep(1000);

  await enterPinKeypad(page, PIN);
  await click(page, page.locator('button:has-text("✓")'));
  await sleep(500);
  await enterPinKeypad(page, PIN);
  await click(page, page.locator('button:has-text("✓")'));
  await sleep(1500);

  await click(page, page.getByText('I have saved my recovery code in a secure location'));
  await click(page, page.getByText('Continue to App'));
  await sleep(2000);

  // Dismiss first-run onboarding wizard.
  await click(page, page.getByText('Get started'));
  await click(page, page.getByText('Next'));
  await click(page, page.getByText('Open Messenger'));
  await sleep(800);
}

async function getOwnRelayId(page) {
  await click(page, page.locator('[title="Account Settings"]'));
  const body = await page.textContent('body');
  const m = body?.match(/[0-9a-f]{4}(?:-[0-9a-f]{4}){7}/);
  if (!m) throw new Error('no own relay id');
  await click(page, page.locator('[title="Close"]'));
  return m[0];
}

async function addContact(page, relayId) {
  const trigger = page.locator('text=Add First Contact')
    .or(page.locator('[title="Start new conversation"]'))
    .or(page.locator('[title="New conversation"]'))
    .first();
  await click(page, trigger);
  await fill(page, '#add-contact-input', relayId);
  const confirm = page.getByRole('button', { name: 'Add Contact', exact: true });
  for (let i = 0; i < 20; i++) { if (await confirm.isEnabled().catch(() => false)) break; await sleep(500); }
  await click(page, confirm);
  await sleep(700);
}

async function openConversation(page, relayId) {
  await click(page, page.getByRole('button', { name: relayId }));
  await sleep(600);
}

async function send(page, text) {
  await fill(page, 'textarea[placeholder="Message..."]', text);
  await click(page, page.locator('[aria-label="Send message"]'));
  await sleep(500);
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
console.log('opened browser');

try {
  // ── Easy marketing shots first (no signup needed) ────────────────────
  const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const mpage = await mctx.newPage();
  await mpage.goto(`${APP_URL}/auth/landing`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  await mpage.screenshot({ path: path.join(OUT, '01-landing.png') });
  await mpage.goto(`${APP_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  await mpage.screenshot({ path: path.join(OUT, '02-login.png') });
  await mctx.close();
  console.log('marketing shots done');

  // ── Two real users messaging ─────────────────────────────────────────
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Real-IP': testIp('A') } });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Real-IP': testIp('B') } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  console.log('signing up A...');
  await signup(pageA);
  console.log('signing up B...');
  await signup(pageB);

  const idA = await getOwnRelayId(pageA);
  const idB = await getOwnRelayId(pageB);
  console.log('users:', idA.slice(0, 8) + '…', idB.slice(0, 8) + '…');

  console.log('A adds B...');
  await addContact(pageA, idB);
  console.log('B adds A...');
  await addContact(pageB, idA);

  console.log('messaging A->B...');
  await openConversation(pageA, idB);
  await send(pageA, "heyyyy 👋");
  await send(pageA, "welcome to relay");
  await openConversation(pageB, idA);
  await pageB.getByText('welcome to relay').first().waitFor({ state: 'visible', timeout: 20000 });
  await send(pageB, "setup took one command");
  await send(pageB, "and nothin reads this, not even the relay");
  await sleep(1000);

  // Back on A, confirm B's replies arrived, then hero shot.
  await openConversation(pageA, idB);
  await pageA.getByText('not even the relay').first().waitFor({ state: 'visible', timeout: 20000 });
  await sleep(800);
  await pageA.screenshot({ path: path.join(OUT, '03-messenger.png') });

  // Account settings panel (still on the open conversation — no reload
  // needed, so no re-auth/key-recovery dance).
  await click(pageA, pageA.locator('[title="Account Settings"]'));
  await sleep(800);
  await pageA.screenshot({ path: path.join(OUT, '05-account.png') });
  await click(pageA, pageA.locator('[title="Close"]'));

  // A fresh load of the messenger (chat list + re-connected state).
  await pageA.goto(`${APP_URL}/app`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await pageA.screenshot({ path: path.join(OUT, '04-inbox.png') });

  await ctxA.close();
  await ctxB.close();
  console.log('done → ' + OUT);
} finally {
  await browser.close();
}
