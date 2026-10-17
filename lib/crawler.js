import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import ipaddr from 'ipaddr.js';
import { load, loadBuffer } from 'cheerio';
import robotsParser from 'robots-parser';
import { chromium } from 'playwright';

const AGENT = 'PocketCrawler/0.1';
const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 5000;
export const ACTORS = [
  { id: 'text', name: '웹페이지 본문', description: '제목, 설명, 본문을 깔끔하게 모아요.', icon: 'file', tag: '리서치 · AI 자료' },
  { id: 'links', name: '링크 수집', description: '페이지의 링크와 텍스트를 목록으로 만들어요.', icon: 'link', tag: '사이트 탐색' },
  { id: 'custom', name: '맞춤 데이터', description: 'CSS 선택자로 필요한 항목만 추출해요.', icon: 'grid', tag: '상품 · 목록' },
];

export function normalizeUrl(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('http 또는 https 주소만 사용할 수 있습니다.');
  if (url.username || url.password) throw new Error('로그인 정보가 포함된 주소는 사용할 수 없습니다.');
  url.hash = '';
  return url.href;
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('입력값이 필요합니다.');
  const actor = input.actor ?? 'text';
  if (!ACTORS.some(a => a.id === actor)) throw new Error('수집기를 선택해 주세요.');
  const values = Array.isArray(input.urls) ? input.urls : String(input.urls ?? '').split(/\r?\n/);
  const urls = [...new Set(values.map(v => String(v).trim()).filter(Boolean).map(v => normalizeUrl(v)))];
  if (!urls.length || urls.length > 20) throw new Error('시작 URL은 1~20개를 입력해 주세요.');
  const maxPages = Number(input.maxPages ?? 10);
  if (!Number.isInteger(maxPages) || maxPages < urls.length || maxPages > 100) throw new Error('최대 페이지 수는 시작 URL 개수 이상, 100 이하로 설정해 주세요.');
  const delayMs = Number(input.delayMs ?? 1000);
  if (!Number.isInteger(delayMs) || delayMs < 500 || delayMs > 10000) throw new Error('요청 간격은 500~10000ms여야 합니다.');
  const engine = input.engine ?? 'http';
  if (!['http', 'browser'].includes(engine)) throw new Error('지원하지 않는 실행 방식입니다.');
  let fields = [];
  const rowSelector = String(input.rowSelector ?? '').trim();
  if (actor === 'custom') {
    if (!rowSelector || rowSelector.length > 300) throw new Error('반복되는 항목의 CSS 선택자를 입력해 주세요.');
    if (!Array.isArray(input.fields) || !input.fields.length || input.fields.length > 12) throw new Error('추출할 필드를 1~12개 지정해 주세요.');
    fields = input.fields.map(f => ({ name: String(f.name ?? '').trim(), selector: String(f.selector ?? '').trim(), attr: String(f.attr ?? '').trim() }));
    const names = new Set(['url', 'collectedAt']);
    const $ = load('<main><div></div></main>');
    try {
      $(rowSelector);
      for (const field of fields) {
        if (!/^[a-zA-Z가-힣_][a-zA-Z0-9가-힣_ -]{0,39}$/.test(field.name) || names.has(field.name) || ['__proto__', 'constructor', 'prototype'].includes(field.name)) throw new Error('필드명은 중복 없이 지정해 주세요. url, collectedAt은 예약된 이름입니다.');
        if (field.selector.length > 300 || field.attr.length > 50) throw new Error('선택자 또는 속성 이름이 너무 깁니다.');
        if (field.selector) $(field.selector);
        names.add(field.name);
      }
    } catch (error) { throw new Error(`맞춤 추출 설정을 확인해 주세요: ${error.message}`); }
  }
  return {
    name: String(input.name || ACTORS.find(a => a.id === actor).name).trim().slice(0, 80),
    actor, urls, maxPages, delayMs, engine,
    followLinks: input.followLinks === true,
    respectRobots: input.respectRobots !== false,
    rowSelector, fields,
  };
}

function publicAddress(address) {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === 'unicast';
  } catch { return false; }
}

export async function resolveAddress(url, allowPrivate = false) {
  const hostname = new URL(normalizeUrl(url)).hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || (!allowPrivate && addresses.some(a => !publicAddress(a.address)))) {
    throw new Error('로컬 주소 또는 사설 네트워크 주소는 수집할 수 없습니다.');
  }
  return addresses[0];
}

// Resolve and pin the address on each request, including redirects.
export function createFetcher({ allowPrivate = false, timeoutMs = 25000 } = {}) {
  return async function fetchPage(inputUrl, signal, redirects = 0) {
    signal?.throwIfAborted();
    const url = normalizeUrl(inputUrl);
    const address = await resolveAddress(url, allowPrivate);
    signal?.throwIfAborted();
    const response = await new Promise((resolve, reject) => {
      const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, {
        signal,
        headers: { 'User-Agent': AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'Accept-Encoding': 'identity' },
        lookup: (_host, options, cb) => options.all ? cb(null, [address]) : cb(null, address.address, address.family),
      }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_BYTES) { req.destroy(new Error('페이지 크기가 5MB 제한을 초과했습니다.')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url }));
        res.on('error', reject);
      });
      const timer = setTimeout(() => req.destroy(new Error('페이지 응답 시간 초과 (25초)')), timeoutMs);
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject);
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      if (redirects >= 5) throw new Error('리다이렉트가 너무 많습니다.');
      return fetchPage(normalizeUrl(response.headers.location, url), signal, redirects + 1);
    }
    return response;
  };
}

const compact = text => text.replace(/\s+/g, ' ').trim();
export function extract(html, url, config, charset) {
  const $ = Buffer.isBuffer(html) ? loadBuffer(html, { encoding: { transportLayerEncodingLabel: charset, defaultEncoding: 'utf-8' } }) : load(html);
  const collectedAt = new Date().toISOString();
  const links = [];
  const seen = new Set();
  $('a[href]').each((_index, el) => {
    try {
      const target = normalizeUrl($(el).attr('href'), url);
      if (!seen.has(target) && links.length < MAX_ROWS) {
        seen.add(target);
        links.push({ url, text: compact($(el).text()), href: target, collectedAt });
      }
    } catch { /* mailto, anchors with unsupported schemes, invalid URLs */ }
  });
  let rows;
  if (config.actor === 'links') rows = links;
  else if (config.actor === 'custom') {
    rows = $(config.rowSelector).slice(0, MAX_ROWS).toArray().map(el => {
      const row = { url };
      for (const field of config.fields) {
        const node = field.selector ? $(el).find(field.selector).first() : $(el);
        let value = field.attr ? node.attr(field.attr) ?? '' : compact(node.text());
        if (value && ['href', 'src'].includes(field.attr)) { try { value = normalizeUrl(value, url); } catch { /* Preserve non-web values */ } }
        row[field.name] = String(value).slice(0, 100000);
      }
      row.collectedAt = collectedAt;
      return row;
    });
  } else {
    const title = compact($('title').first().text());
    const description = $('meta[name="description"]').attr('content') || '';
    const headings = $('h1,h2').slice(0, 30).toArray().map(el => compact($(el).text())).filter(Boolean).join(' | ');
    $('script,style,noscript,svg,nav,footer,header').remove();
    const main = $('main,article').first();
    rows = [{ url, title, description, headings, text: compact((main.length ? main : $('body')).text()).slice(0, 100000), collectedAt }];
  }
  return { rows, links: links.map(link => link.href) };
}

export function browserOptions() {
  if (existsSync(chromium.executablePath())) return { headless: true };
  if (process.platform === 'win32') {
    if (existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe') || existsSync('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')) return { headless: true, channel: 'msedge' };
    if (existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')) return { headless: true, channel: 'chrome' };
  }
  return null;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function crawl(config, { signal, onLog, onPage, fetchPage = createFetcher(), allowPrivate = false }) {
  const queue = [...config.urls];
  const queued = new Set(queue);
  const origins = new Set(config.urls.map(url => new URL(url).origin));
  const robots = new Map();
  let browser;
  let context;
  let processed = 0;
  let rowsCount = 0;
  let failures = 0;
  let successes = 0;
  const abortBrowser = () => { browser?.close().catch(() => {}); };
  try {
    if (config.engine === 'browser') {
      const options = browserOptions();
      if (!options) throw new Error('브라우저가 없습니다. 터미널에서 npm run install:browser를 실행해 주세요.');
      browser = await chromium.launch(options);
      signal.throwIfAborted();
      signal.addEventListener('abort', abortBrowser, { once: true });
      context = await browser.newContext({ userAgent: AGENT, serviceWorkers: 'block', acceptDownloads: false });
      await context.route('**/*', async route => {
        try {
          if (['image', 'media', 'font'].includes(route.request().resourceType())) return await route.abort();
          await resolveAddress(route.request().url(), allowPrivate);
          await route.continue();
        } catch { await route.abort().catch(() => {}); }
      });
      await context.routeWebSocket('**/*', socket => socket.close());
      onLog('info', '브라우저를 준비했습니다. JavaScript 렌더링 후 수집합니다.');
    }
    while (queue.length && processed < config.maxPages && rowsCount < MAX_ROWS) {
      signal.throwIfAborted();
      const url = queue.shift();
      processed++;
      let result;
      try {
        if (config.respectRobots) {
          const origin = new URL(url).origin;
          if (!robots.has(origin)) {
            const response = await fetchPage(`${origin}/robots.txt`, signal);
            if ([401, 403, 429].includes(response.status) || response.status >= 500) throw new Error(`robots.txt 접근 제한 (HTTP ${response.status})`);
            robots.set(origin, robotsParser(`${origin}/robots.txt`, response.status === 200 ? response.body.toString('utf8') : ''));
          }
          if (robots.get(origin).isAllowed(url, AGENT) === false) throw new Error('robots.txt에서 수집을 허용하지 않는 주소입니다.');
        }
        onLog('info', `수집 중 · ${url}`);
        let content;
        let finalUrl;
        let charset;
        if (context) {
          const page = await context.newPage();
          try {
            const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
            if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
            await page.waitForTimeout(1000);
            content = await page.content();
            finalUrl = normalizeUrl(page.url());
            if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('페이지 크기가 5MB 제한을 초과했습니다.');
          } finally { await page.close().catch(() => {}); }
        } else {
          let response;
          for (let attempt = 0; attempt < 2; attempt++) {
            response = await fetchPage(url, signal);
            if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 1) break;
            onLog('warn', `HTTP ${response.status} · 2초 후 한 번 재시도합니다.`);
            await sleep(2000, signal);
          }
          if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
          if (!/text\/html|application\/xhtml\+xml/i.test(response.headers['content-type'] || '')) throw new Error('HTML 페이지가 아닙니다.');
          content = response.body;
          finalUrl = response.url;
          charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.headers['content-type'] || '')?.[1];
        }
        result = extract(content, finalUrl, config, charset);
        result.rows = result.rows.slice(0, MAX_ROWS - rowsCount);
        rowsCount += result.rows.length;
        successes++;
        if (config.followLinks) {
          for (const link of result.links) {
            if (!origins.has(new URL(link).origin) || queued.has(link) || queued.size >= config.maxPages) continue;
            if (/\.(pdf|zip|jpg|jpeg|png|gif|webp|mp4|mp3|css|js)(\?|$)/i.test(link)) continue;
            queued.add(link);
            queue.push(link);
          }
        }
        onLog('success', `${result.rows.length}개 결과 저장 · ${finalUrl}`);
      } catch (error) {
        if (signal.aborted) throw error;
        failures++;
        onLog('error', `${url} · ${error.message}`);
      }
      onPage({ rows: result?.rows ?? [], processed, failures, successes, pending: queue.length });
      if (queue.length && processed < config.maxPages && rowsCount < MAX_ROWS) await sleep(config.delayMs, signal);
    }
    if (rowsCount >= MAX_ROWS) onLog('warn', '실행당 결과 제한 5,000개에 도달해 수집을 마쳤습니다.');
    return failures ? (successes ? 'partial' : 'failed') : 'succeeded';
  } finally {
    signal.removeEventListener('abort', abortBrowser);
    await browser?.close().catch(() => {});
  }
}

export function toCsv(rows) {
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [keys.map(cell).join(','), ...rows.map(row => keys.map(key => cell(row[key])).join(','))].join('\r\n');
}
