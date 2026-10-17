import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.js';
import { Store } from '../lib/store.js';
import { crawl, createFetcher, extract, normalizeUrl, resolveAddress, toCsv, validateConfig } from '../lib/crawler.js';

const fixtureHtml = '<html><head><title>테스트 상점</title><meta name="description" content="품질 검사"></head><body><nav>메뉴</nav><main><h1>상품 목록</h1><article class="product"><h2>노트</h2><span class="price">3,000원</span><a href="/second#section">상세</a></article><article class="product"><h2>펜</h2><span class="price">1,000원</span><a href="/second">상세</a></article><a href="https://example.org/outside">외부</a><a href="mailto:test@example.org">메일</a></main><script>secretScript()</script></body></html>';
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
async function until(predicate) { for (let i = 0; i < 150; i++) { if (await predicate()) return; await delay(30); } throw new Error('Timed out waiting for job'); }
const config = overrides => validateConfig({ urls: ['https://example.com/'], maxPages: 3, delayMs: 500, ...overrides });

test('input validation rejects invalid protocols, limits, duplicate fields and selectors', () => {
  assert.throws(() => config({ urls: 'file:///etc/passwd' }));
  assert.throws(() => config({ urls: 'https://user:pass@example.com' }));
  assert.throws(() => config({ maxPages: 101 }));
  assert.throws(() => config({ maxPages: 1.5 }));
  assert.throws(() => config({ delayMs: 0 }));
  assert.throws(() => config({ actor: 'custom', rowSelector: '[', fields: [{ name: 'title', selector: 'h2' }] }));
  assert.throws(() => config({ actor: 'custom', rowSelector: 'article', fields: [{ name: '__proto__' }] }));
  assert.throws(() => config({ actor: 'custom', rowSelector: 'article', fields: [{ name: 'url' }] }));
  assert.deepEqual(config({ urls: ['https://example.com/#one', 'https://example.com/#two'] }).urls, ['https://example.com/']);
  assert.equal(normalizeUrl('/about#part', 'https://example.com'), 'https://example.com/about');
});

test('text, deduplicated links and scoped CSS fields produce usable records', () => {
  const url = 'https://example.com/';
  const text = extract(fixtureHtml, url, config());
  assert.equal(text.rows[0].title, '테스트 상점');
  assert.equal(text.rows[0].description, '품질 검사');
  assert.ok(text.rows[0].text.includes('3,000원'));
  assert.ok(!text.rows[0].text.includes('secretScript'));
  assert.ok(!text.rows[0].text.includes('메뉴'));
  const links = extract(fixtureHtml, url, config({ actor: 'links' }));
  assert.equal(links.rows.length, 2);
  assert.equal(links.rows[0].href, 'https://example.com/second');
  const custom = extract(fixtureHtml, url, config({ actor: 'custom', rowSelector: '.product', fields: [{ name: 'name', selector: 'h2' }, { name: 'price', selector: '.price' }, { name: 'link', selector: 'a', attr: 'href' }] }));
  assert.equal(custom.rows.length, 2);
  assert.equal(custom.rows[0].name, '노트');
  assert.equal(custom.rows[1].price, '1,000원');
  assert.equal(custom.rows[0].link, 'https://example.com/second');
});

test('CSV preserves Korean, commas, quotes and newlines and neutralizes spreadsheet formulas', () => {
  const csv = toCsv([{ name: '한글,"인용"\n두 줄', value: '=1+1', other: ' @SUM(A1)' }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"한글,""인용""\n두 줄"'));
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"\' @SUM(A1)"'));
});

test('network boundary blocks loopback, private and mapped loopback addresses', async () => {
  for (const url of ['http://127.0.0.1', 'http://10.0.0.1', 'http://192.168.1.1', 'http://169.254.169.254', 'http://[::1]', 'http://[::ffff:127.0.0.1]']) {
    await assert.rejects(resolveAddress(url), /사설 네트워크/);
  }
});

test('crawler honors robots, traverses same origin, caps pages and exposes partial failure', async () => {
  const requests = [];
  const fixture = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /blocked');
    if (req.url === '/second') return res.end('<html><title>두 번째</title><body><a href="/">홈</a><a href="/blocked">금지</a></body></html>');
    res.end(fixtureHtml);
  });
  const base = await listen(fixture);
  try {
    const pages = [], logs = [];
    const status = await crawl(config({ urls: [base], followLinks: true, maxPages: 5 }), {
      signal: new AbortController().signal, fetchPage: createFetcher({ allowPrivate: true }),
      onPage: page => pages.push(page), onLog: (...entry) => logs.push(entry),
    });
    assert.equal(status, 'partial');
    assert.equal(pages.at(-1).successes, 2);
    assert.equal(pages.at(-1).failures, 1);
    assert.equal(requests.filter(url => url === '/robots.txt').length, 1);
    assert.ok(!requests.includes('/blocked'));
    assert.ok(!requests.includes('/outside'));
    assert.ok(logs.some(entry => entry[1].includes('robots.txt')));
  } finally { await close(fixture); }
});

test('redirect resolution, retries and request cancellation work over actual HTTP', async () => {
  let attempts = 0;
  const fixture = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/retry' }); return res.end(); }
    if (req.url === '/retry' && ++attempts === 1) { res.statusCode = 503; return res.end('later'); }
    if (req.url === '/slow') return;
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
    res.end(fixtureHtml);
  });
  const base = await listen(fixture);
  try {
    const fetchPage = createFetcher({ allowPrivate: true });
    const pages = [];
    const status = await crawl(config({ urls: [`${base}/redirect`], respectRobots: false }), { signal: new AbortController().signal, fetchPage, onPage: p => pages.push(p), onLog: () => {} });
    assert.equal(status, 'succeeded');
    assert.equal(attempts, 2);
    assert.equal(pages[0].rows[0].url, `${base}/retry`);
    await assert.rejects(fetchPage(`${base}/loop`), /리다이렉트/);
    const controller = new AbortController();
    const pending = fetchPage(`${base}/slow`, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, /abort/i);
  } finally { await close(fixture); }
});

test('API integrates real scraping, result pagination, exports, CSRF protection, schedules and persistence', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pocket-api-'));
  const fixture = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixtureHtml); });
  const fixtureBase = await listen(fixture);
  const store = new Store(directory, { runner: (settings, callbacks) => crawl(settings, { ...callbacks, fetchPage: createFetcher({ allowPrivate: true }) }) });
  const { app } = createApp({ store });
  const server = createServer(app);
  const base = await listen(server);
  const state = await (await fetch(`${base}/api/state`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-App-Token': state.token };
  try {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/state`, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
      get(`${base}/api/state`, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(badHostStatus, 403);
    const invalid = await fetch(`${base}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ urls: 'file:///tmp/test' }) });
    assert.equal(invalid.status, 400);
    const settings = config({ urls: [fixtureBase], respectRobots: false, name: 'API 통합 테스트' });
    const created = await fetch(`${base}/api/runs`, { method: 'POST', headers, body: JSON.stringify(settings) });
    assert.equal(created.status, 201);
    const job = await created.json();
    await until(() => store.jobs.get(job.id).status === 'succeeded');
    const detail = await (await fetch(`${base}/api/runs/${job.id}?limit=1`)).json();
    assert.equal(detail.rowCount, 1);
    assert.equal(detail.rows[0].title, '테스트 상점');
    assert.ok(detail.logs.length >= 3);
    const csv = await fetch(`${base}/api/runs/${job.id}/export?format=csv`);
    assert.match(csv.headers.get('content-disposition'), /attachment/);
    assert.ok((await csv.text()).includes('테스트 상점'));
    const json = await (await fetch(`${base}/api/runs/${job.id}/export?format=json`)).json();
    assert.equal(json[0].title, '테스트 상점');
    const scheduleResponse = await fetch(`${base}/api/schedules`, { method: 'POST', headers, body: JSON.stringify({ config: settings, intervalHours: 24 }) });
    assert.equal(scheduleResponse.status, 201);
    const schedule = await scheduleResponse.json();
    const paused = await fetch(`${base}/api/schedules/${schedule.id}`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) });
    assert.equal((await paused.json()).enabled, false);
    const restored = new Store(directory);
    assert.equal(restored.jobs.get(job.id).rows[0].title, '테스트 상점');
    assert.equal(restored.schedules.get(schedule.id).enabled, false);
    await restored.close();
    const rerun = await (await fetch(`${base}/api/runs/${job.id}/retry`, { method: 'POST', headers })).json();
    assert.notEqual(rerun.id, job.id);
    await until(() => store.jobs.get(rerun.id).status === 'succeeded');
    assert.equal((await fetch(`${base}/api/runs/${job.id}`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await fetch(`${base}/api/runs/${job.id}`)).status, 404);
  } finally { await store.close(); await close(server); await close(fixture); rmSync(directory, { recursive: true, force: true }); }
});

test('serial queue cancellation and scheduler coalesce missed runs without overlap', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pocket-queue-'));
  let starts = 0;
  const runner = async (_settings, { signal }) => { starts++; await delay(5000, null, { signal }); return 'succeeded'; };
  const store = new Store(directory, { runner });
  try {
    const first = store.create(config());
    const second = store.create(config());
    await until(() => starts === 1);
    assert.equal(store.jobs.get(second.id).status, 'queued');
    store.cancel(second.id);
    assert.equal(store.jobs.get(second.id).status, 'cancelled');
    store.cancel(first.id);
    await until(() => store.jobs.get(first.id).status === 'cancelled');
    assert.equal(starts, 1);
    const schedule = store.addSchedule(config(), 1);
    const now = Date.now();
    schedule.nextRunAt = new Date(now - 10 * 3600000).toISOString();
    store.tick(now);
    const scheduled = [...store.jobs.values()].filter(j => j.scheduleId === schedule.id);
    assert.equal(scheduled.length, 1);
    store.tick(now + 3600001);
    assert.equal([...store.jobs.values()].filter(j => j.scheduleId === schedule.id).length, 1);
    store.updateSchedule(schedule.id, false);
    assert.equal(store.schedules.get(schedule.id).enabled, false);
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('unfinished records become interrupted on restart and preserve collected results', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pocket-restart-'));
  const store = new Store(directory, { runner: async () => 'succeeded' });
  try {
    const created = store.create(config());
    await until(() => store.jobs.get(created.id).status === 'succeeded');
    await store.close();
    const file = path.join(directory, 'runs', `${created.id}.json`);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    record.status = 'running'; record.rows = [{ title: '저장된 결과' }];
    writeFileSync(file, JSON.stringify(record));
    const restored = new Store(directory);
    assert.equal(restored.jobs.get(created.id).status, 'interrupted');
    assert.equal(restored.jobs.get(created.id).rows[0].title, '저장된 결과');
    await restored.close();
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
});
