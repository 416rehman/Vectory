import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'dashboard/package.json'));
const { chromium, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const base = process.env.VECTORY_UI_URL || 'http://127.0.0.1:8080';
const browser = await chromium.launch();
const checks = [], errors = [];
try {
  const context = await browser.newContext({ storageState: path.join(root, '.local/preview/browser-auth.json'), viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  async function accessible(label) {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map(v => ({ id: v.id, impact: v.impact, elements: v.nodes.length }))).toEqual([]);
    checks.push(label);
  }
  await page.goto(base + '/#/users');
  await expect(page.getByRole('heading', { name: 'Workspace access', exact: true })).toBeVisible();
  const session = await page.request.get(base + '/api/v1/session').then(r => r.json());
  await page.getByRole('textbox', { name: 'Find a person' }).fill(session.user.email);
  await accessible('Desktop account management: no Axe violations');
  await page.screenshot({ path: path.join(root, 'docs/screenshots/account-access.png'), fullPage: true });
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await accessible('Password dialog: no Axe violations');
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  checks.push('Password dialog keyboard focus remains inside the open dialog');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: `Edit access for ${session.user.name}`, exact: true }).click();
  await accessible('Edit-access dialog: no Axe violations');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await accessible('375px account page: no horizontal document overflow or Axe violations');
  await expect(page.getByRole('button', { name: `Edit access for ${session.user.name}`, exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, 'docs/screenshots/account-access-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await accessible('375px password dialog: no Axe violations');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => localStorage.setItem('vectory-theme', 'dark'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Workspace access', exact: true })).toBeVisible();
  await accessible('Dark account page: no Axe violations');
  await context.close();

  const publicContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const publicPage = await publicContext.newPage();
  publicPage.on('pageerror', error => errors.push(error.message));
  await publicPage.goto(base);
  await publicPage.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(publicPage.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  expect((await new AxeBuilder({ page: publicPage }).analyze()).violations).toEqual([]);
  expect(await publicPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  checks.push('Public reset form at375px: no Axe violations or horizontal document overflow');
  await publicPage.screenshot({ path: path.join(root, 'docs/screenshots/password-reset-mobile.png'), fullPage: true });
  await publicPage.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(publicPage.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  checks.push('Public reset can return to sign in without submitting credentials');
  expect(errors).toEqual([]);
  const report = { recorded_at: new Date().toISOString(), base, result: 'pass', checks, page_errors: errors, scope: 'Read-only account UI, real local preview; no passwords or reset codes generated, submitted or captured.' };
  await fs.writeFile(path.join(root, 'docs/evidence/account-ux.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`PASS ${checks.length} account UI checks against ${base}.`);
} finally { await browser.close(); }
