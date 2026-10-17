import test from 'node:test';
import assert from 'node:assert/strict';
import { InstagramEvidence, instagramTarget, validateInstagram, parseInstagramHtml, normalizeMedia, analyzeInstagram } from '../lib/instagram-data.js';
import { crawlInstagram } from '../lib/instagram.js';

const profile = { username: 'sample', posts: 100, followers: 1000, biography: '테스트 계정' };
const media = (i, extra = {}) => normalizeMedia({ code: `Post_${i}`, user: { username: 'sample' }, taken_at: 1700000000 + i * 86400, caption: { text: `주제 ${i} #일상 #일상 #사진` }, media_type: 1, like_count: i, comment_count: 2, ...extra });
const link = i => instagramTarget(`https://www.instagram.com/sample/p/Post_${i}/`);
const fixture = ({ failAt, failReason = 'rate_limited', posts = 100 } = {}) => {
  let scroll = 0, closed = false; const opened = [];
  // Old pinned posts first, then newest posts. Repeated links across scrolls.
  const ordered = [1, 2, 3, ...Array.from({ length: 30 }, (_, i) => 100 - i)];
  const snap = n => ({ profile: { ...profile, posts }, links: ordered.slice(0, n).map(link) });
  return {
    opened, get closed() { return closed; },
    async open(url) {
      opened.push(url);
      const t = instagramTarget(url);
      if (t.kind === 'profile') return snap(Math.min(12, posts));
      const i = Number(t.code.replace('Post_', ''));
      if (i === failAt) throw Object.assign(new Error('blocked fixture'), { reason: failReason });
      return { post: media(i), links: [] };
    },
    async scroll() { scroll++; return snap(Math.min(12 + scroll * 12, posts)); },
    async close() { closed = true; },
  };
};
async function run(adapter, config = {}, controller = new AbortController()) {
  const snapshots = [], logs = [];
  const status = await crawlInstagram(validateInstagram({ url: 'https://www.instagram.com/p/Post_0/', ...config }), {
    signal: controller.signal, onPage: value => snapshots.push(structuredClone(value)), onLog: (level, message) => logs.push({ level, message }), createBrowser: async () => adapter, paceMs: 0,
  });
  return { status, snapshots, logs, final: snapshots.at(-1) };
}

test('Instagram URLs normalize tracking and owner-prefixed posts but reject foreign hosts and unsupported paths', () => {
  assert.equal(instagramTarget('https://www.instagram.com/p/ABC_123/?utm_source=x').url, 'https://www.instagram.com/p/ABC_123/');
  assert.deepEqual(instagramTarget('https://instagram.com/Sample/reel/ABC_123/'), { kind: 'post', code: 'ABC_123', ownerHint: 'sample', url: 'https://www.instagram.com/reel/ABC_123/' });
  assert.equal(instagramTarget('https://www.instagram.com/Sample/').username, 'sample');
  for (const url of ['https://instagram.com.evil.test/p/ABC/', 'http://instagram.com/sample/', 'https://instagram.com:8443/sample/', 'https://user@instagram.com/sample/', 'https://instagram.com/p/ABC/c/123/', 'https://instagram.com/accounts/', 'https://instagram.com/stories/sample/123/']) assert.throws(() => instagramTarget(url));
  assert.throws(() => validateInstagram({ url: 'https://instagram.com/sample/', maxPosts: 31 }));
});

test('HTML parser extracts nested Instagram JSON, canonical owner and prefixed grid links without executing scripts', () => {
  const evidence = new InstagramEvidence();
  const html = `<meta property="og:url" content="https://www.instagram.com/sample/p/ABC123/">
    <meta property="og:title" content='다른 표시이름 on Instagram: "공개 캡션"'>
    <script type="application/json">${JSON.stringify({ require: [['x', { data: { media: { code: 'ABC123', media_type: 8, user: { username: 'sample' }, taken_at: 1700000000, caption: { text: 'JSON 캡션' }, like_count: 0, carousel_media: [{ accessibility_caption: '사진 설명' }], coauthor_producers: [{ username: 'partner' }] } } }]] })}</script>
    <main><a href="/sample/reel/DEF123/">reel</a><a href="/sample/reel/DEF123/">duplicate</a><a href="/p/ABC123/c/22/">comment</a></main>`;
  const parsed = parseInstagramHtml(html, 'https://instagram.com/p/ABC123/', evidence);
  assert.equal(parsed.post.username, 'sample'); assert.equal(parsed.post.caption, 'JSON 캡션');
  assert.equal(parsed.post.likes, 0); assert.equal(parsed.post.comments, null);
  assert.equal(parsed.post.mediaType, 'carousel'); assert.equal(parsed.post.carouselCount, 1);
  assert.deepEqual(parsed.post.collaborators, ['partner']); assert.equal(parsed.links.length, 1);
  assert.equal(parsed.links[0].code, 'DEF123');
  const fallback = parseInstagramHtml('<meta property="og:url" content="https://instagram.com/sample/p/ABC123/"><meta property="og:title" content="표시명 on Instagram: &quot;캡션&quot;">', 'https://instagram.com/p/ABC123/');
  assert.equal(fallback.post.username, 'sample');
  const empty = parseInstagramHtml('<main></main>', 'https://instagram.com/sample/');
  assert.equal(empty.profile.followers, null);
});

test('login, private account and restriction states remain explicit', () => {
  for (const [html, reason] of [['<input name="username"><input name="password">', 'login_required'], ['<main>This account is private</main>', 'private_account'], ['<main>Please wait a few minutes</main>', 'rate_limited']]) {
    assert.equal(parseInstagramHtml(html, 'https://instagram.com/sample/').blocked, reason);
  }
});

test('collector follows seed author, scrolls, deduplicates, replaces snapshots and excludes old pins from latest 30', async () => {
  const adapter = fixture(); const result = await run(adapter);
  assert.equal(result.status, 'succeeded'); assert.equal(result.final.rows.length, 30);
  assert.equal(result.final.rows[0].shortcode, 'Post_100'); assert.equal(result.final.rows.at(-1).shortcode, 'Post_71');
  assert.equal(result.final.instagram.latestVerified, true);
  assert.equal(result.final.instagram.discoveredCandidates, 33);
  assert.ok(result.snapshots.every(s => s.replaceRows && s.rows.length <= 30));
  assert.ok(adapter.opened.includes('https://www.instagram.com/sample/')); assert.equal(adapter.closed, true);
});

test('access restriction preserves partial data, stops visiting posts and closes browser', async () => {
  const adapter = fixture({ failAt: 100 }); const result = await run(adapter);
  assert.equal(result.status, 'partial'); assert.equal(result.final.rows.length, 3);
  assert.equal(result.final.instagram.stopReason, 'rate_limited');
  assert.equal(result.final.instagram.latestVerified, false);
  assert.ok(!adapter.opened.includes(link(99).url)); assert.equal(adapter.closed, true);
});

test('smaller accounts succeed with available posts; three consecutive errors stop requests', async () => {
  const small = await run(fixture({ posts: 2 })); assert.equal(small.status, 'succeeded'); assert.equal(small.final.rows.length, 2);
  const broken = fixture(); const open = broken.open.bind(broken);
  broken.open = async url => { if (instagramTarget(url).kind === 'post' && !url.includes('Post_0/')) throw new Error('missing data'); return open(url); };
  const failed = await run(broken); assert.equal(failed.status, 'failed'); assert.equal(failed.final.processed, 3);
});

test('cancellation closes the browser and propagates abort while retaining prior published rows', async () => {
  const controller = new AbortController(); const adapter = fixture(); const snapshots = [];
  await assert.rejects(crawlInstagram(validateInstagram({ url: 'https://instagram.com/sample/' }), { signal: controller.signal, createBrowser: async () => adapter, paceMs: 0, onLog() {}, onPage(s) { snapshots.push(s); controller.abort(); } }), { name: 'AbortError' });
  assert.equal(snapshots[0].rows.length, 1); assert.equal(adapter.closed, true);
});

test('analysis excludes missing metrics, counts each hashtag once per post and reports evidence coverage', () => {
  const report = analyzeInstagram({ id: 'test', status: 'partial', config: { maxPosts: 30 }, instagram: { profile, latestVerified: false, stopReason: 'login_required' }, rows: [media(10), media(20, { like_count: null }), media(30)] });
  assert.equal(report.metrics.averageLikes, 20); assert.equal(report.metrics.interactionRateSampleSize, 2);
  assert.equal(report.metrics.followerBasedInteractionRatePercent, 2.2);
  assert.equal(report.coverage.fields.likes, 2); assert.equal(report.coverage.latestRequestedPostsVerified, false);
  assert.equal(report.topHashtags.find(t => t.tag === '#일상').posts, 3);
  assert.equal(report.posts[1].likes, null); assert.equal(report.topPosts[0].url, media(30).url);
});
