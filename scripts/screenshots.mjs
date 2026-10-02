// Produces product screenshots by driving the REAL app end-to-end against a
// running HTTPS/WSS stack. Three real identities sign up through the UI,
// get display names + a claimed username, add each other as contacts, and
// exchange actual end-to-end-encrypted messages over the relay — producing
// a rich messenger with MULTIPLE chats and named contacts, plus theme
// variants and the marketing pages.
//
// Usage (stack must be up over https://localhost:3020):
//   node scripts/screenshots.mjs <outdir>
const { chromium } = await import('@playwright/test');
import { TOTP, Secret } from 'otpauth';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const APP_URL = process.env.APP_URL || 'https://localhost:3020';
const OUT = process.argv[2] || 'screenshots';
const PIN = '741852';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function testIp(label) { const h = createHash('sha256').update(`shot2:${label}`).digest(); return `10.${h[0]}.${h[1]}.${h[2]}`; }
function computeTotp(b32) { return new TOTP({ secret: Secret.fromBase32(b32.replace(/\s/g, '')), digits: 6, period: 30 }).generate(); }
const rand4 = () => Array.from({ length: 4 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');

async function click(page, locator) {
  for (let i = 0; i < 8; i++) {
    try { await locator.waitFor({ state: 'visible', timeout: 15000 }); await locator.click({ timeout: 5000 }); return; }
    catch (e) { await sleep(700); }
  }
  await locator.click({ timeout: 10000 });
}
async function fill(page, sel, value) {
  for (let i = 0; i < 8; i++) {
    try { await page.locator(sel).waitFor({ state: 'visible', timeout: 15000 }); await page.locator(sel).fill(value, { timeout: 5000 }); return; }
    catch (e) { await sleep(700); }
  }
  await page.locator(sel).fill(value, { timeout: 10000 });
}

async function enterPinKeypad(page, pin) { for (const d of pin.split('')) { await click(page, page.getByRole('button', { name: `Digit ${d}`, exact: true })); await sleep(100); } }

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
  await click(page, page.getByText('Get started'));
  await click(page, page.getByText('Next')).catch(() => {});
  await click(page, page.getByText('Open Messenger')).catch(() => {});
  await sleep(800);
}

async function getOwnRelayId(page) {
  await click(page, page.locator('[title="Account Settings"]'));
  const m = (await page.textContent('body'))?.match(/[0-9a-f]{4}(?:-[0-9a-f]{4}){7}/);
  if (!m) throw new Error('no own relay id');
  await click(page, page.locator('[title="Close"]'));
  await sleep(300);
  return m[0];
}

// Set display name + claim username via the profile API from inside the
// page (same-origin fetch carries the session cookie). No UI navigation,
// no reload — the user stays on their live messenger, which is the only
// state guaranteed to render in headless.
async function setProfileAPI(page, relayId, displayName, username) {
  const out = await page.evaluate(async ({ relayId, displayName, username }) => {
    try {
      const body = { relayId, displayName: displayName || undefined, username: username || undefined };
      const r = await fetch('/api/profile/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return r.status + ' ' + (await r.text()).slice(0, 100);
    } catch (e) { return 'EXC ' + e.message; }
  }, { relayId, displayName, username });
  await sleep(1200);
  console.log(`  profile ${displayName || '(none)'} @${username || '(none)'} → ${out}`);
}

async function addContact(page, relayId) {
  async function openComposer() {
    const triggers = [
      'text=Add First Contact',
      '[title="Start new conversation"]',
      '[title="New conversation"]',
      'button:has-text("New Message")',
    ];
    for (const sel of triggers) {
      const loc = page.locator(sel).first();
      if (await loc.count().catch(() => 0)) { await click(page, loc).catch(() => {}); await sleep(900); }
      if (await page.locator('#add-contact-input').count().catch(() => 0)) return true;
    }
    return await page.locator('#add-contact-input').count().catch(() => 0) > 0;
  }
  await page.waitForSelector('textarea[placeholder="Message..."]', { timeout: 15000 }).catch(() => {});
  let open = await openComposer();
  if (!open) { // maybe a stale view — reload the messenger and re-try once
    await page.goto(`${APP_URL}/app`, { waitUntil: 'domcontentloaded' });
    await sleep(2200);
    open = await openComposer();
  }
  if (!open) throw new Error('could not open Add Contact modal');
  await fill(page, '#add-contact-input', relayId);
  const confirm = page.getByRole('button', { name: 'Add Contact', exact: true });
  for (let i = 0; i < 20; i++) { if (await confirm.isEnabled().catch(() => false)) break; await sleep(500); }
  await click(page, confirm);
  await sleep(700);
}
// Open a conversation by matching the sidebar row against any of the given
// names (display name first — once a contact has a display name, their row
// is labelled by that, not by the raw Relay ID).
async function openConversation(page, ...names) {
  let last;
  for (const n of names) {
    const loc = page.getByRole('button').filter({ hasText: n }).first();
    if (await loc.count()) { try { await click(page, loc); last = loc; break; } catch { /* try next */ } }
  }
  if (!last) await click(page, page.getByRole('button').filter({ hasText: names[0] }).first());
  await sleep(700);
}
async function send(page, text) {
  await fill(page, 'textarea[placeholder="Message..."]', text);
  await click(page, page.locator('[aria-label="Send message"]'));
  await sleep(500);
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
console.log('opened browser');

// ── Marketing shots ──────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const p = await ctx.newPage();
  await p.goto(`${APP_URL}/auth/landing`, { waitUntil: 'domcontentloaded' }); await sleep(1400);
  await p.screenshot({ path: path.join(OUT, '01-landing.png') });
  await p.goto(`${APP_URL}/auth/login`, { waitUntil: 'domcontentloaded' }); await sleep(1400);
  await p.screenshot({ path: path.join(OUT, '02-login.png') });
  await ctx.close();
  console.log('marketing shots done');
}

// ── Three real users ─────────────────────────────────────────────────────
const ctA = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Real-IP': testIp('A') } });
const ctB = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Real-IP': testIp('B') } });
const ctC = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Real-IP': testIp('C') } });
const pA = await ctA.newPage(), pB = await ctB.newPage(), pC = await ctC.newPage();

console.log('signing up A/B/C...');
await signup(pA); await signup(pB); await signup(pC);

const [idA, idB, idC] = [await getOwnRelayId(pA), await getOwnRelayId(pB), await getOwnRelayId(pC)];
console.log('users:', idA.slice(0, 8), idB.slice(0, 8), idC.slice(0, 8));

// Set display names + usernames via the profile API (no navigation, no
// reload — every user stays on their live messenger). A's add-contact
// profile lookups then return the friendly names.
console.log('setting profiles via API...');
await setProfileAPI(pB, idB, 'Maya', 'maya' + rand4());
await setProfileAPI(pC, idC, 'Zane', null);
await setProfileAPI(pA, idA, 'Ava', 'ava' + rand4());

// Contacts
console.log('adding contacts...');
await addContact(pA, idB);
await addContact(pA, idC);
await addContact(pB, idA);
await addContact(pC, idA);

// Messaging: A↔B rich conversation; C sends A a message too (unread in sidebar)
console.log('messaging...');
await openConversation(pA, 'Maya', idB);
await send(pA, "Maya! Welcome to the team 🎉");
await send(pA, "Everything here is end-to-end encrypted.");
await openConversation(pB, 'Ava', idA);
await pB.getByText('Everything here is end-to-end encrypted.').first().waitFor({ state: 'visible', timeout: 20000 });
await send(pB, "for real? even the relay can't read it?");
await openConversation(pA, 'Maya', idB);
await pA.getByText("even the relay can't read it?").first().waitFor({ state: 'visible', timeout: 20000 });
await send(pA, "nope. it only sees ciphertext 🔐");
await sleep(1200);

// C sends A a message (lands as unread in A's sidebar)
await openConversation(pC, 'Ava', idA);
await send(pC, "hey Ava, can you ping the group later?");
await sleep(1500);

// A stays on its live messenger, open on the Maya conversation.
await openConversation(pA, 'Maya', idB).catch(() => {});
await sleep(800);

// Wedge the composer so the open Maya conversation is clearly in view, wait
// for it, then capture the messenger on the LIVE page (no reload — reload
// of /app renders blank in this production/headless build, so all shots are
// taken on the live page.
async function messengerReady(page) {
  await page.locator('textarea[placeholder="Message..."]').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  await sleep(1200);
}

await openConversation(pA, 'Maya', idB).catch(() => {});
await messengerReady(pA);
await pA.screenshot({ path: path.join(OUT, '03-messenger.png') });
console.log('03-messenger done');

// Theme variants — apply a theme to the LIVE page (data-theme attribute +
// dark class; the CSS vars react instantly, no reload needed).
async function themeApply(theme, file) {
  try {
    await pA.evaluate((t) => {
      try { localStorage.setItem('relay:theme', t); } catch {}
      document.documentElement.setAttribute('data-theme', t);
      if (t === 'arctic') document.documentElement.classList.remove('dark');
      else document.documentElement.classList.add('dark');
    }, theme);
    await sleep(900);
    if (file) { await pA.screenshot({ path: path.join(OUT, file) }); console.log(file + ' done'); }
    else console.log(theme + ' applied (no screenshot)');
  } catch (e) { console.log((file || theme) + ' failed: ' + e.message.split('\n')[0]); }
}
await themeApply('ocean', '04-messenger-ocean.png');
await themeApply('arctic', '05-messenger-arctic.png');
await themeApply('violet', '06-messenger-violet.png');
await themeApply('forest', '07-messenger-forest.png');
await themeApply('crimson', null); // restore default before the account shot

// Account settings — an in-app panel on the live page, not a navigation.
try {
  await click(pA, pA.locator('[title="Account Settings"]'));
  await sleep(1000);
  await pA.screenshot({ path: path.join(OUT, '08-account.png') });
  console.log('08-account done');
} catch (e) { console.log('08-account failed: ' + e.message.split('\n')[0]); }

await ctA.close(); await ctB.close(); await ctC.close();
await browser.close();
console.log('done → ' + OUT);
