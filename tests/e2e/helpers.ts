import { test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'crypto';
import { TOTP, Secret } from 'otpauth';

/**
 * Every test in this suite signs up a brand-new identity, and
 * app/api/auth/signup/route.ts rate-limits signup to 3/minute per client.
 * TRUST_PROXY_HEADERS=true (playwright.config.ts) makes lib/security/rate-limit.ts
 * bucket by X-Real-IP instead of lumping every direct connection into one
 * shared 'direct' bucket — so each test needs its own distinct synthetic IP
 * to behave like the independent real-world user it's simulating, instead
 * of tripping the same rate limit every other test in the run also hits.
 *
 * Derived from test.info().testId (a stable, Playwright-assigned unique
 * string), NOT a module-level counter — Playwright re-evaluates each test
 * file's module graph per test, so a plain `let counter` silently resets to
 * its initial value before every single test (confirmed empirically: every
 * test logged the exact same generated IP server-side), making every test
 * collide in the same rate-limit bucket despite looking correct in isolation.
 */
function testIp(label: string): string {
  const hash = createHash('sha256').update(`${test.info().testId}:${label}`).digest();
  return `10.${hash[0]}.${hash[1]}.${hash[2]}`;
}

/**
 * A fresh browser context with its own simulated client IP. Pass a distinct
 * `label` when a single test opens multiple contexts (e.g. two simulated
 * users messaging each other) — testId alone is the same for every context
 * within one test, so without a label they'd collide in the same bucket.
 */
export async function newIsolatedContext(browser: Browser, label = 'default'): Promise<BrowserContext> {
  return browser.newContext({ extraHTTPHeaders: { 'X-Real-IP': testIp(label) } });
}

export function computeTotp(base32Secret: string): string {
  const totp = new TOTP({ secret: Secret.fromBase32(base32Secret.replace(/\s/g, '')), digits: 6, period: 30 });
  return totp.generate();
}

/**
 * Signup's PIN screen is a numeric keypad, not a text input. Each key's
 * visible digit is `aria-hidden` (PINPadSetup.tsx) and the real accessible
 * name is `Digit <n>` via aria-label, so match on that directly rather than
 * the rendered text.
 */
export async function enterPinKeypad(page: Page, pin: string) {
  for (const digit of pin.split('')) {
    await page.getByRole('button', { name: `Digit ${digit}`, exact: true }).click();
    await page.waitForTimeout(100);
  }
}

/** Login's PIN field is a real masked text input. */
export async function enterPinField(page: Page, pin: string) {
  await page.locator('input[type="password"]').first().fill(pin);
}

/**
 * Runs the Authenticator-App signup path and lands on /app, returning the
 * TOTP secret and recovery code so callers can drive further login/recovery
 * scenarios without re-deriving them.
 */
export async function signupNewIdentity(page: Page, pin: string): Promise<{ secret: string; recoveryCode: string }> {
  await page.goto('/auth/landing');
  await page.click('text=Create new identity');
  await page.waitForTimeout(800);
  await page.click('text=Authenticator App');
  await page.waitForTimeout(800);
  await page.click("text=Can't scan? Enter manually").catch(() => {});

  const secretMatch = (await page.textContent('body'))?.match(/[A-Z2-7]{16,64}/);
  if (!secretMatch) throw new Error('TOTP secret should be visible on the manual-entry screen');
  const secret = secretMatch[0];

  await page.fill('input[placeholder="000000"]', computeTotp(secret));
  await page.click('text=Verify & Continue');
  await page.waitForTimeout(1000);

  await enterPinKeypad(page, pin);
  await page.click('button:has-text("✓")');
  await page.waitForTimeout(500);
  await enterPinKeypad(page, pin);
  await page.click('button:has-text("✓")');
  await page.waitForTimeout(1500);

  // A generic body-wide regex here previously grabbed one extra trailing
  // character from the adjacent "Copy Code" button's text — page.textContent
  // concatenates element text with NO separator between them, so
  // "...87B2" immediately followed by "Copy Code" reads as "...87B2Copy
  // Code", and a greedy [A-Z0-9]{4,} happily consumes the leading "C" too.
  // The corrupted code then deterministically failed recovery-login (real
  // app behavior working correctly — rejecting a code that doesn't match).
  // Reading the recovery-code element's own text directly avoids this.
  const recoveryCode = (await page.textContent('[data-testid="recovery-code"]'))?.trim();
  if (!recoveryCode) throw new Error('recovery code should be displayed');

  await page.click('text=I have saved my recovery code in a secure location');
  await page.click('text=Continue to App');
  await page.waitForTimeout(2000);

  // A brand-new signup always lands on the first-run OnboardingFlow overlay
  // (app/app/page.tsx shows it whenever sessionStorage's relay_new_user flag is
  // set) — a 3-step wizard ("Get started" → "Next" → "Open Messenger") that
  // covers the whole screen and blocks everything underneath (contact list,
  // Account Settings, everything) until dismissed.
  await page.click('text=Get started');
  await page.click('text=Next');
  await page.click('text=Open Messenger');
  await page.waitForTimeout(500);

  return { secret, recoveryCode };
}

/**
 * Extracts the current user's own Relay ID (the long, self-certifying,
 * always-present identifier — see lib/crypto/relay-id.ts's RELAY_ID_REGEX:
 * 8 lowercase-hex groups of 4, dash-separated) from the in-app Account
 * Settings panel, so one simulated identity can hand it to another for
 * contact exchange, exactly like a real user reading their ID off their own
 * account screen.
 */
export async function getOwnRelayId(page: Page): Promise<string> {
  await page.click('[title="Account Settings"]');
  const body = await page.textContent('body');
  const match = body?.match(/[0-9a-f]{4}(?:-[0-9a-f]{4}){7}/);
  if (!match) throw new Error('own Relay ID should be visible on the Account Settings panel');
  // AccountManagementPanel.tsx has a real close button (title="Close") —
  // it's a full in-app view, not a dropdown/modal Escape would dismiss.
  // Leaving it open blocks every other in-app control underneath it.
  await page.click('[title="Close"]');
  return match[0];
}
