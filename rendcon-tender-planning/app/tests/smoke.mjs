// End-to-end smoke test on the mock (demo) layer. Run: node tests/smoke.mjs (from app/).
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(APP, 'tests', 'output');
const URL_ = 'http://localhost:4173/';
const TIMEOUT = 15000;

function fail(msg) { console.error('SMOKE FAILED: ' + msg); process.exitCode = 1; }
function check(cond, msg) { if (!cond) throw new Error(msg); }

async function waitForServer(url, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('preview server did not start');
}

execSync('npx vite build', { cwd: APP, stdio: 'inherit' });
fs.mkdirSync(OUT, { recursive: true });
const preview = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'] });
let browser = null;
const errors = [];

try {
  await waitForServer(URL_);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().startsWith('Failed to load resource')) return;
    errors.push('console: ' + m.text());
  });
  page.setDefaultTimeout(TIMEOUT);

  const step = async (name, fn) => {
    try { await fn(); console.log('ok  ' + name); }
    catch (e) { throw new Error(`${name}: ${e.message}`); }
  };
  const titles = () => page.$$eval('.col .col-title > span', (els) => els.map((e) => e.textContent.trim()));
  const cardCount = () => page.locator('.card').count();

  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card');

  await step('board: logo, demo banner, 4 columns, 7 cards', async () => {
    check(await page.locator('.appbar .logo').isVisible(), 'logo not visible');
    check((await page.textContent('#viewBanner')).includes('Demo mode'), 'demo banner missing');
    check((await page.locator('.col').count()) === 4, 'expected 4 columns');
    check(JSON.stringify(await titles()) === JSON.stringify(['Unassigned projects', 'Eng. Ahmed Hassan', 'Eng. Sara Mostafa', 'Eng. Omar Khaled']), 'column titles: ' + (await titles()).join(' | '));
    check((await cardCount()) === 7, 'expected 7 cards');
  });

  await step('search narrows and clears', async () => {
    await page.fill('#q', 'خزان');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
    await page.fill('#q', '');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 7);
    await page.locator('#q').blur();
  });

  await step('filters: private tender type, chip, clear, done', async () => {
    await page.click('#fBtn');
    await page.click('[data-filter="type:private"]');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);
    check((await page.locator('.qchip').count()) === 1, 'expected one filter chip');
    await page.click('#fClear');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 7);
    await page.click('#fDone');
  });

  await step('update log opens and marks the card as read', async () => {
    const btn = page.locator('.c-upd-btn.new').first();
    await btn.click();
    await page.waitForSelector('.c-log.open');
    check((await page.locator('.c-upd-btn.new').count()) < 3, 'button still marked new');
  });

  await step('drag a card to the first engineer column', async () => {
    const h3 = page.locator('.card', { hasText: 'Steel shed – Industrial Zone plot 14' }).locator('h3');
    const box = await h3.boundingBox();
    const target = await page.locator('.col').nth(1).locator('.col-list').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const tx = target.x + target.width / 2, ty = target.y + target.height / 2;
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(box.x + (tx - box.x - box.width / 2) * i / 10 + box.width / 2, box.y + (ty - box.y) * i / 10 + box.height / 2);
    }
    await page.mouse.up();
    await page.waitForSelector('.toast:has-text("assigned to")');
    await page.waitForFunction(() => {
      const col = document.querySelectorAll('.col')[1];
      return !!col && [...col.querySelectorAll('.card h3')].some((h) => h.textContent.includes('Steel shed'));
    });
  });

  await step('project page: date, sub-task, comment, close', async () => {
    await page.locator('.card', { hasText: 'إنشاء خزان مياه أرضي سعة 5000 م³' }).locator('h3').click();
    await page.waitForSelector('#page.show');
    await page.$eval('#pDue', (el) => { el.value = '2027-02-15'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => document.querySelector('.due-hist') && document.querySelector('.due-hist').textContent.includes('15 Feb 2027'));
    await page.fill('#subIn', 'Smoke sub-task');
    await page.press('#subIn', 'Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('#subs input.sub-text')].some((i) => i.value === 'Smoke sub-task'));
    await page.click('[data-tab="comments"]');
    await page.fill('#ct', 'Smoke comment');
    await page.click('#cf button');
    await page.waitForFunction(() => [...document.querySelectorAll('.comment p')].some((p) => p.textContent === 'Smoke comment'));
    await page.click('#pClose');
    await page.waitForFunction(() => !document.querySelector('#page').classList.contains('show'));
  });

  await step('team: add engineer, appears last, move up before Omar', async () => {
    await page.click('#teamBtn');
    await page.waitForSelector('#teamSheet.show');
    await page.fill('#tName', 'Eng. Test Person');
    await page.fill('#tEmail', 'test@redcon.example');
    await page.click('#tSend');
    await page.waitForFunction(() => document.querySelectorAll('.col').length === 5);
    const t = await titles();
    check(t[4] === 'Eng. Test Person', 'last column is ' + t[4]);
    await page.locator('#teamSheet .member', { hasText: 'Eng. Test Person' }).locator('[data-up]').click();
    await page.waitForFunction(() => {
      const names = [...document.querySelectorAll('.col .col-title > span')].map((e) => e.textContent.trim());
      return names.indexOf('Eng. Test Person') < names.indexOf('Eng. Omar Khaled');
    });
    await page.click('#teamSheet [data-x]');
  });

  await step('reminders: schedule one', async () => {
    const before = Number(await page.textContent('#remCount'));
    await page.click('#remBtn');
    await page.waitForSelector('#remSheet.show');
    await page.fill('#rMsg', 'Smoke reminder');
    await page.click('#rAdd');
    await page.waitForFunction((b) => Number(document.querySelector('#remCount').textContent) === b + 1, before);
    await page.click('#remSheet [data-x]');
  });

  await step('email intake: sync, review item, create project from it', async () => {
    await page.click('#syncBtn');
    await page.waitForSelector('.toast:has-text("Email sync")');
    await page.click('#mailBtn');
    await page.waitForSelector('#mailSheet .review-item');
    await page.locator('#mailSheet [data-newp]').first().click();
    await page.waitForFunction(() => {
      const col = document.querySelector('.col');
      return !!col && [...col.querySelectorAll('.card h3')].some((h) => h.textContent.includes('تطوير ميدان المحطة'));
    });
    await page.click('#mailSheet [data-x]');
  });

  await step('reload keeps the changes', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.card');
    const col = page.locator('.col').nth(1);
    await col.locator('.card h3', { hasText: 'Steel shed' }).waitFor();
    check((await titles()).includes('Eng. Test Person'), 'Eng. Test Person column missing after reload');
  });

  await page.screenshot({ path: path.join(OUT, 'board.png'), fullPage: false });
  check(errors.length === 0, 'errors on the page:\n  ' + errors.join('\n  '));
  console.log('SMOKE OK');
} catch (e) {
  fail(e.message);
  if (errors.length) console.error(errors.join('\n'));
} finally {
  if (browser) await browser.close();
  preview.kill('SIGTERM');
}
process.exit(process.exitCode || 0);
