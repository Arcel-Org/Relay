import { test, expect } from '@playwright/test';
import { newIsolatedContext, computeTotp, enterPinKeypad, enterPinField } from './helpers';

/**
 * Regression coverage for the signup completion race: completeSignupStep3
 * clears signupIdentity while router.push('/auth/signup/step3') is in flight,
 * which used to re-trigger startSignup() and wipe the recovery-code screen
 * (fixed in app/auth/signup/page.tsx — see signupStep guard). This test fails
 * if that race reappears.
 */
test('signup: authenticator method reaches the recovery-code screen and completes', async ({ browser }) => {
  const pin = '741852';
  const context = await newIsolatedContext(browser);
  const page = await context.newPage();

  await page.goto('/auth/landing');
  await page.click('text=Create new identity');
  await page.waitForTimeout(800);
  await page.click('text=Authenticator App');
  await page.waitForTimeout(800);
  await page.click("text=Can't scan? Enter manually").catch(() => {});

  const bodyText = await page.textContent('body');
  const secretMatch = bodyText?.match(/[A-Z2-7]{16,64}/);
  expect(secretMatch, 'TOTP secret should be visible on the manual-entry screen').toBeTruthy();
  const secret = secretMatch![0];

  await page.fill('input[placeholder="000000"]', computeTotp(secret));
  await page.click('text=Verify & Continue');
  await page.waitForTimeout(1000);

  await enterPinKeypad(page, pin);
  await page.click('button:has-text("✓")');
  await page.waitForTimeout(500);
  await enterPinKeypad(page, pin);
  await page.click('button:has-text("✓")');
  await page.waitForTimeout(1500);

  await expect(page).toHaveURL(/\/auth\/signup\/step3/);
  await expect(page.locator('text=/save.*recovery code/i').first()).toBeVisible();

  // A body-wide regex here previously grabbed one extra trailing character
  // from the adjacent "Copy Code" button's text (page.textContent has no
  // separator between elements) — reading the recovery-code element's own
  // text directly avoids that. See helpers.ts's signupNewIdentity for the
  // full explanation (this test only checks presence, not login, so the
  // corruption never surfaced here).
  const recoveryCode = await page.textContent('[data-testid="recovery-code"]');
  expect(recoveryCode?.trim(), 'recovery code should be displayed').toBeTruthy();

  await page.click('text=I have saved my recovery code in a secure location');
  await page.click('text=Continue to App');
  await page.waitForTimeout(2000);

  await expect(page).toHaveURL(/\/app/);
  await context.close();
});

test('login: existing identity signs back in with TOTP + PIN in a fresh context', async ({ browser }) => {
  const pin = '741852';
  const context = await newIsolatedContext(browser);
  const page = await context.newPage();

  // Create the identity in this same persistent context first — a brand-new
  // browser profile has no local IndexedDB copy of the PIN-encrypted private
  // key (by design: zero-knowledge, no server-side recovery), so login must
  // be tested against an identity created in the same context, not a global fixture.
  await page.goto('/auth/landing');
  await page.click('text=Create new identity');
  await page.waitForTimeout(800);
  await page.click('text=Authenticator App');
  await page.waitForTimeout(800);
  await page.click("text=Can't scan? Enter manually").catch(() => {});
  const secretMatch = (await page.textContent('body'))?.match(/[A-Z2-7]{16,64}/);
  const secret = secretMatch![0];
  await page.fill('input[placeholder="000000"]', computeTotp(secret));
  await page.click('text=Verify & Continue');
  await page.waitForTimeout(1000);
  await enterPinKeypad(page, pin);
  await page.click('button:has-text("✓")');
  await page.waitForTimeout(500);
  await enterPinKeypad(page, pin);
  await page.click('button:has-text("✓")');
  await page.waitForTimeout(1500);
  await page.click('text=I have saved my recovery code in a secure location');
  await page.click('text=Continue to App');
  await page.waitForTimeout(2000);
  await expect(page).toHaveURL(/\/app/);

  // Now log out and sign back in with the same identity, same context.
  await page.goto('/auth/login');
  await page.fill('input[placeholder="000000"]', computeTotp(secret));
  await enterPinField(page, pin);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);

  await expect(page).toHaveURL(/\/app/);

  await context.close();
});
