import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { browserOptions, resolveAddress } from './crawler.js';
import { InstagramEvidence, instagramTarget, parseInstagramHtml, mergeKnown, selectRecent } from './instagram-data.js';
import { sessionFiles } from './instagram-session.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const explanations = {
  login_required: 'Instagram 로그인이 필요합니다. instagram-session(action=login)으로 전용 로그인 창을 열고 직접 로그인한 뒤 다시 실행하세요.',
  private_account: '비공개 계정은 이 수집기에서 수집하지 않습니다.',
  challenge_required: 'Instagram이 본인 확인을 요청했습니다. 수집을 중단했습니다. 전용 로그인 창에서 사용자가 직접 확인해야 합니다.',
  rate_limited: 'Instagram의 요청 제한을 감지해 중단했습니다. 반복 요청하지 말고 시간이 지난 뒤 다시 시도하세요.',
  unavailable: '게시물 또는 계정을 볼 수 없습니다. 삭제·접근 제한 여부를 확인하세요.',
  network_error: 'Instagram 페이지가 제한 시간 안에 열리지 않았습니다. 네트워크 또는 Instagram 접근 상태를 확인하세요.',
};
function blockedError(reason) { return Object.assign(new Error(explanations[reason] || reason), { reason }); }

export async function instagramBrowser({ signal, dataDir, useSession = true }) {
  const options = browserOptions();
  if (!options) throw new Error('브라우저가 없습니다. npm run install:browser를 실행하세요.');
  const browser = await chromium.launch(options);
  const abort = () => browser.close().catch(() => {});
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const state = sessionFiles(dataDir).state;
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', acceptDownloads: false, ...(useSession && existsSync(state) ? { storageState: state } : {}) });
    await context.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (['data:', 'blob:'].includes(url.protocol)) return await route.continue();
        const domains = ['instagram.com', 'cdninstagram.com', 'fbcdn.net', 'facebook.com', 'fbsbx.com'];
        if (!domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return await route.abort();
        await resolveAddress(url.href);
        if (['media', 'font'].includes(route.request().resourceType())) return await route.abort();
        await route.continue();
      } catch { await route.abort().catch(() => {}); }
    });
    const page = await context.newPage();
    const evidence = new InstagramEvidence();
    const pending = new Set();
    let restricted = null;
    page.on('response', response => {
      const origin = new URL(response.url()).hostname;
      if (!['www.instagram.com', 'instagram.com', 'i.instagram.com'].includes(origin)) return;
      if (response.status() === 429) restricted = 'rate_limited';
      if (response.status() !== 200 || !/json/.test(response.headers()['content-type'] || '') || Number(response.headers()['content-length'] || 0) > 6000000 || pending.size > 12) return;
      const task = (async () => { try { const body = await response.body(); if (body.length <= 6000000) evidence.ingest(JSON.parse(body.toString('utf8'))); } catch {} })();
      pending.add(task); task.finally(() => pending.delete(task));
    });
    const snapshot = async expected => {
      await Promise.race([Promise.allSettled([...pending]), delay(1000, undefined, { signal })]);
      const url = page.url();
      if (restricted) throw blockedError(restricted);
      if (/\/challenge\/|\/checkpoint\//.test(url)) throw blockedError('challenge_required');
      if (/\/accounts\/login/.test(url)) throw blockedError('login_required');
      try { instagramTarget(url); } catch { throw blockedError('unavailable'); }
      const html = await page.content();
      if (html.length > 12000000) throw new Error('Instagram 페이지가 크기 제한을 초과했습니다.');
      const result = parseInstagramHtml(html, expected || url, evidence);
      if (result.blocked) throw blockedError(result.blocked);
      return result;
    };
    return {
      evidence,
      async open(url) {
        signal.throwIfAborted();
        restricted = null;
        let response;
        try { response = await page.goto(instagramTarget(url).url, { waitUntil: 'commit', timeout: 30000 }); }
        catch (error) { if (signal.aborted) throw error; throw blockedError('network_error'); }
        if (response?.status() === 429) throw blockedError('rate_limited');
        if (response?.status() >= 400) throw blockedError('unavailable');
        await page.waitForSelector('main, article, input[name="username"]', { timeout: 10000 }).catch(() => {});
        await delay(3000, undefined, { signal });
        return snapshot(url);
      },
      async scroll() {
        signal.throwIfAborted();
        await page.evaluate(() => window.scrollBy(0, Math.max(innerHeight * 2, 1200)));
        await delay(1800, undefined, { signal });
        return snapshot();
      },
      async close() { signal.removeEventListener('abort', abort); await browser.close(); },
    };
  } catch (error) { signal.removeEventListener('abort', abort); await browser.close().catch(() => {}); throw error; }
}

export async function crawlInstagram(config, { signal, onLog, onPage, dataDir = process.env.POCKET_DATA_DIR || path.join(root, 'data', 'mcp'), createBrowser = instagramBrowser, paceMs = 2000 }) {
  let adapter;
  let processed = 0;
  const collected = [];
  const info = { profile: null, requestedPosts: config.maxPosts, discoveredCandidates: 0, failedPosts: [], warnings: [], latestVerified: false, stopReason: null };
  const publish = () => onPage({ rows: selectRecent(collected, config.maxPosts), replaceRows: true, processed, successes: collected.length, failures: info.failedPosts.length, instagram: structuredClone(info) });
  try {
    adapter = await createBrowser({ signal, dataDir, useSession: config.useSession });
    const target = instagramTarget(config.url);
    let username = target.username;
    if (!username) {
      onLog('info', `시작 게시물에서 작성자를 확인합니다 · ${target.url}`);
      const start = await adapter.open(target.url);
      username = start.post?.username;
      if (!username) throw Object.assign(new Error('시작 게시물의 작성자를 확인하지 못했습니다. 로그인 후 다시 시도하거나 프로필 URL을 직접 입력하세요.'), { reason: 'author_unresolved' });
    }
    const profileUrl = instagramTarget(`https://www.instagram.com/${username}/`).url;
    onLog('info', `프로필 수집 · ${profileUrl}`);
    let snapshot = await adapter.open(profileUrl);
    info.profile = snapshot.profile;
    if (info.profile?.isPrivate) throw blockedError('private_account');
    const candidates = new Map();
    const add = snap => {
      if (snap.profile) info.profile = mergeKnown(info.profile, snap.profile);
      for (const link of snap.links) if (!candidates.has(link.code) && candidates.size < 60) candidates.set(link.code, link);
    };
    add(snapshot);
    // Three extra candidates cover Instagram's profile pin slots; later dates win.
    const desired = Math.min(config.maxPosts + 3, info.profile?.posts ?? Infinity);
    let stagnant = 0;
    for (let scroll = 0; candidates.size < desired && scroll < 16 && stagnant < 3; scroll++) {
      signal.throwIfAborted();
      const before = candidates.size;
      snapshot = await adapter.scroll(); add(snapshot);
      stagnant = candidates.size === before ? stagnant + 1 : 0;
    }
    info.discoveredCandidates = candidates.size;
    if (!candidates.size) {
      info.stopReason = info.profile?.posts === 0 ? 'empty_profile' : 'no_visible_posts';
      if (info.stopReason !== 'empty_profile') info.warnings.push('프로필에서 게시물 링크를 찾지 못했습니다. 로그인 상태 또는 Instagram 화면 변경을 확인하세요.');
      publish(); return info.stopReason === 'empty_profile' ? 'succeeded' : 'failed';
    }
    const inspect = [...candidates.values()].slice(0, config.maxPosts + 3);
    let consecutiveFailures = 0;
    onLog('info', `게시물 후보 ${inspect.length}개를 확인해 최신 ${config.maxPosts}개를 선택합니다.`);
    for (const link of inspect) {
      signal.throwIfAborted();
      try {
        const page = await adapter.open(link.url);
        const post = page.post;
        if (!post || post.shortcode !== link.code || (!post.caption && !post.postedAt)) throw new Error('게시물 본문과 게시 시각을 확인하지 못했습니다.');
        if (post.username !== username && !post.collaborators?.includes(username)) throw new Error('프로필 소유자의 게시물임을 확인하지 못했습니다.');
        collected.push(post);
        consecutiveFailures = 0;
        onLog('success', `게시물 저장 · ${link.url}`);
      } catch (error) {
        if (signal.aborted) throw error;
        info.failedPosts.push({ url: link.url, reason: error.reason || 'parse_error', message: error.message });
        consecutiveFailures++;
        onLog('warn', `${link.url} · ${error.message}`);
        if (['login_required', 'challenge_required', 'rate_limited', 'private_account'].includes(error.reason)) throw error;
        if (consecutiveFailures >= 3) throw error;
      } finally { processed++; publish(); }
      if (paceMs) await delay(paceMs, undefined, { signal });
    }
    const selected = selectRecent(collected, config.maxPosts);
    const expected = Math.min(config.maxPosts, info.profile?.posts ?? config.maxPosts);
    const allDated = collected.every(p => Boolean(p.postedAt));
    info.latestVerified = !info.failedPosts.length && allDated && selected.length >= expected && inspect.length >= desired;
    if (!info.latestVerified) info.warnings.push('접근 가능한 프로필 격자 표본입니다. 누락·게시 시각 미확인 때문에 최신 게시물 전체라는 보장은 할 수 없습니다.');
    if (collected.some(p => !p.postedAt)) info.warnings.push('게시 시각이 없는 항목은 날짜가 있는 항목 뒤에 배치했습니다.');
    info.stopReason = selected.length >= expected ? 'requested_limit' : 'fewer_visible_posts';
    publish();
    return !selected.length ? 'failed' : info.latestVerified ? 'succeeded' : 'partial';
  } catch (error) {
    if (signal.aborted) throw error;
    info.stopReason = error.reason || 'collection_error'; info.warnings.push(error.message);
    onLog('error', error.message); publish();
    return collected.length ? 'partial' : 'failed';
  } finally { await adapter?.close().catch(() => {}); }
}
