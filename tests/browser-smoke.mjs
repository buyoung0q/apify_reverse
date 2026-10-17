import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApp } from '../server.js';
import { Store } from '../lib/store.js';
import { browserOptions, crawl, createFetcher } from '../lib/crawler.js';

const directory = mkdtempSync(path.join(tmpdir(), 'pocket-browser-'));
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = createServer((req, res) => {
  if (req.url === '/robots.txt') { res.end('User-agent: *\nAllow: /'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<html><head><title>나의 테스트 문서</title></head><body><main><h1>수집 테스트</h1><article class="product"><h2>처음 쓴 노트</h2><p class="price">3,000원</p><a href="/notes">더 알아보기</a></article><script>setTimeout(() => document.querySelector("h2").textContent="브라우저로 읽은 노트", 100)</script></main></body></html>');
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const fixtureUrl = await listen(fixture);
const store = new Store(directory, { runner: (config, callbacks) => crawl(config, { ...callbacks, fetchPage: createFetcher({ allowPrivate: true }), allowPrivate: true }) });
const { app } = createApp({ store });
const server = createServer(app);
const base = await listen(server);
let browser;
try {
  const options = browserOptions();
  assert.ok(options, 'Install a browser with npm run install:browser');
  browser = await chromium.launch(options);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByText('로컬 연결됨', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'qa-home.png'), fullPage: true });
  await page.locator('[data-new="text"]').first().click();
  await page.locator('input[name="name"]').fill('나의 첫 번째 수집');
  await page.locator('textarea[name="urls"]').fill(fixtureUrl);
  await page.locator('input[name="maxPages"]').fill('1');
  await page.locator('#submit-run').click();
  await page.locator('#detail-content .badge.succeeded').waitFor({ timeout: 15000 });
  await page.getByText('나의 테스트 문서', { exact: true }).waitFor();
  const downloadEvent = page.waitForEvent('download');
  await page.getByText('↓ CSV 다운로드', { exact: true }).click();
  const download = await downloadEvent;
  assert.ok(download.suggestedFilename().endsWith('.csv'));
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.ok(Buffer.concat(chunks).toString('utf8').includes('나의 테스트 문서'));
  await page.locator('[data-tab="logs"]').click();
  await page.getByText('작업을 시작했습니다.', { exact: false }).waitFor();
  await page.locator('[data-close="detail-dialog"]').click();

  // Exercise CSS extraction and real JavaScript execution through the UI.
  await page.locator('[data-new="custom"]').click();
  await page.locator('input[name="name"]').fill('브라우저 맞춤 수집');
  await page.locator('textarea[name="urls"]').fill(fixtureUrl);
  await page.locator('input[name="rowSelector"]').fill('.product');
  await page.locator('input[name="maxPages"]').fill('1');
  await page.locator('select[name="engine"]').selectOption('browser');
  await page.locator('#submit-run').click();
  await page.locator('#detail-content .badge.succeeded').waitFor({ timeout: 30000 });
  await page.getByText('브라우저로 읽은 노트', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'qa-detail.png'), fullPage: true });
  await page.locator('[data-close="detail-dialog"]').click();

  await page.locator('.nav-item[data-view="schedules"]').click();
  await page.locator('#new-schedule').click();
  await page.locator('input[name="name"]').fill('매일 읽는 문서');
  await page.locator('textarea[name="urls"]').fill(fixtureUrl);
  await page.locator('#submit-run').click();
  await page.getByText('매일 읽는 문서', { exact: true }).waitFor();
  await page.locator('[data-toggle-schedule]').click();
  await page.getByText('다시 켜기', { exact: true }).waitFor();

  await page.locator('.nav-item[data-view="runs"]').click();
  await page.locator('#run-search').fill('없는 기록');
  await page.getByText('일치하는 기록이 없어요').waitFor();
  await page.locator('#run-search').fill('');
  await page.locator('.nav-item[data-view="home"]').click();
  await page.screenshot({ path: path.join(root, 'qa-populated.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(root, 'qa-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile document should not overflow');
  assert.deepEqual(errors, []);
  console.log('Browser QA passed: HTML collection, dynamic CSS extraction, CSV download, logs, scheduling, filtering, mobile layout; no JavaScript errors.');
} finally {
  await browser?.close();
  await store.close();
  server.closeAllConnections(); fixture.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => fixture.close(resolve))]);
  rmSync(directory, { recursive: true, force: true });
}
