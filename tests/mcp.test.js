import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp-server.js';
import { McpStore } from '../lib/mcp-store.js';
import { validateConfig } from '../lib/crawler.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const settings = () => validateConfig({ urls: ['https://example.com'], maxPages: 1 });
const temporary = () => mkdtempSync(path.join(tmpdir(), 'pocket-mcp-'));
async function until(check, seconds = 10) { const deadline = Date.now() + seconds * 1000; while (Date.now() < deadline) { if (await check()) return; await delay(50); } throw new Error('Timed out'); }
async function call(client, name, args = {}) { const response = await client.callTool({ name, arguments: args }); assert.ok(!response.isError, response.content?.[0]?.text); return response.structuredContent; }
const fakeRunner = async (_config, { onLog, onPage, signal }) => {
  await delay(30, undefined, { signal });
  onLog('info', '검증용 결과');
  onPage({ rows: [{ url: 'https://example.com/', title: '공유 데이터', text: '가'.repeat(5000) }], processed: 1, successes: 1, failures: 0 });
  return 'succeeded';
};

test('Instagram MCP workflow persists replacement snapshots, typed data, analysis and recipes across clients', async () => {
  const dir = temporary();
  const post = { kind: 'instagram_post', shortcode: 'ABC123', url: 'https://www.instagram.com/p/ABC123/', username: 'sample', caption: '테스트 #사진', altText: '', postedAt: '2026-10-01T00:00:00.000Z', likes: 15, comments: null, views: null, mediaType: 'image', collaborators: ['partner'] };
  const store = new McpStore(dir, { runner: async (config, { onPage, dataDir }) => {
    assert.equal(config.actor, 'instagram'); assert.equal(dataDir, dir);
    onPage({ rows: [post], replaceRows: true, instagram: { profile: { username: 'sample', followers: 100 }, latestVerified: false, stopReason: 'fewer_visible_posts' } });
    onPage({ rows: [post], replaceRows: true });
    return 'partial';
  } });
  const second = new McpStore(dir, { runner: async () => { throw new Error('Unexpected second worker'); } });
  const { server } = createMcpServer({ store });
  const client = new Client({ name: 'instagram-protocol-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  try {
    const detail = await call(client, 'fetch-actor-details', { actorId: 'instagram' }); assert.equal(detail.inputSchema.properties.maxPosts.maximum, 30);
    const job = await call(client, 'analyze-instagram', { url: 'https://instagram.com/p/ABC123/', waitSeconds: 3 });
    assert.equal(job.status, 'partial'); assert.equal(job.rowCount, 1);
    assert.equal(second.getJob(job.id).instagram.profile.username, 'sample');
    const rows = await call(client, 'get-dataset-items', { datasetId: job.id });
    assert.equal(rows.items[0].likes, 15); assert.equal(rows.items[0].comments, null); assert.deepEqual(rows.items[0].collaborators, ['partner']);
    const report = await call(client, 'get-instagram-analysis', { runId: job.id });
    assert.equal(report.collectedPosts, 1); assert.equal(report.metrics.averageLikes, 15);
    assert.equal(report.coverage.latestRequestedPostsVerified, false);
    const recipe = await call(client, 'save-actor', { name: 'sample-ig', title: '계정', description: '', baseActor: 'instagram', input: { url: 'https://instagram.com/sample/', maxPosts: 20 } });
    assert.equal(recipe.config.maxPosts, 20);
    const session = await call(client, 'instagram-session', { action: 'status' }); assert.equal(session.sessionSaved, false);
    const bad = await client.callTool({ name: 'analyze-instagram', arguments: { url: 'https://example.com/' } }); assert.equal(bad.isError, true);
  } finally { await client.close(); await server.close(); await store.close(); await second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('MCP tool discovery, actor recipes, runs, pagination, exports and schedules through the protocol', async () => {
  const dir = temporary();
  const store = new McpStore(dir, { runner: fakeRunner });
  const { server } = createMcpServer({ store });
  const client = new Client({ name: 'codex-compatible-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 19);
    assert.ok(tools.tools.some(t => t.name === 'call-actor' && t.inputSchema.properties.actorId));
    const actors = await call(client, 'search-actors'); assert.equal(actors.total, 4);
    const info = await call(client, 'fetch-actor-details', { actorId: 'custom' });
    assert.ok(info.inputSchema.required.includes('rowSelector'));
    const actor = await call(client, 'save-actor', { name: 'my-articles', title: '내 기사 수집', description: '본문을 모읍니다', baseActor: 'text', input: { urls: ['https://example.com'], maxPages: 1 } });
    assert.equal(actor.id, 'local/my-articles');
    assert.equal((await call(client, 'search-actors', { query: '기사' })).total, 1);
    const duplicate = await client.callTool({ name: 'save-actor', arguments: { name: 'my-articles', title: '중복', description: '', baseActor: 'text', input: { urls: ['https://example.com'] } } });
    assert.equal(duplicate.isError, true);
    const job = await call(client, 'call-actor', { actorId: actor.id, waitSeconds: 3 });
    assert.equal(job.status, 'succeeded'); assert.equal(job.rowCount, 1);
    const items = await call(client, 'get-dataset-items', { datasetId: job.defaultDatasetId, maxFieldChars: 100 });
    assert.equal(items.items[0].title, '공유 데이터'); assert.equal(items.items[0].text.length, 100);
    assert.equal(items.truncatedFields[0].originalChars, 5000);
    assert.equal(items.nextOffset, null);
    const file = await call(client, 'export-dataset', { datasetId: job.id, format: 'json' });
    assert.equal(JSON.parse(readFileSync(file.path, 'utf8'))[0].text.length, 5000);
    assert.ok((await call(client, 'get-run-log', { runId: job.id })).logs.length);
    const schedule = await call(client, 'create-schedule', { actorId: actor.id, intervalHours: 24 });
    assert.equal((await call(client, 'list-schedules')).schedules.length, 1);
    assert.equal((await call(client, 'update-schedule', { scheduleId: schedule.id, enabled: false })).enabled, false);
    await call(client, 'delete-schedule', { scheduleId: schedule.id });
    assert.equal((await call(client, 'list-schedules')).schedules.length, 0);
    assert.equal((await call(client, 'list-actor-runs')).runs.length, 1);
    await call(client, 'delete-actor-run', { runId: job.id });
    assert.equal((await call(client, 'list-actor-runs')).runs.length, 0);
    const unknown = await client.callTool({ name: 'call-actor', arguments: { actorId: 'apify/instagram-scraper', input: { urls: ['https://example.com'] } } });
    assert.equal(unknown.isError, true);
    const invalid = await client.callTool({ name: 'call-actor', arguments: { actorId: 'text', input: { urls: ['file:///etc/passwd'] } } });
    assert.equal(invalid.isError, true);
    const resource = await client.readResource({ uri: 'pocket://guide' }); assert.match(resource.contents[0].text, /search-actors/);
  } finally { await client.close(); await server.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('two stores share a single worker queue, cross-client cancellation, schedules and crash recovery', async () => {
  const dir = temporary(); let starts = 0;
  const runner = async (_config, { signal }) => { starts++; await delay(10000, undefined, { signal }); return 'succeeded'; };
  const first = new McpStore(dir, { runner }); const second = new McpStore(dir, { runner });
  try {
    const one = first.create(settings()); const two = second.create(settings());
    first.tick(); second.tick();
    assert.equal(starts, 1); assert.equal(second.getJob(one.id).status, 'running'); assert.equal(first.getJob(two.id).status, 'queued');
    second.cancel(one.id); first.tick(); await until(() => first.getJob(one.id).status === 'cancelled');
    second.cancel(two.id); assert.equal(first.getJob(two.id).status, 'cancelled');
    const schedule = first.addSchedule(settings(), 1, 'text');
    schedule.nextRunAt = new Date(Date.now() - 36000000).toISOString();
    first.db.prepare('UPDATE schedules SET payload=? WHERE id=?').run(JSON.stringify(schedule), schedule.id);
    first.tick(); second.tick();
    assert.equal(first.list().filter(j => j.scheduleId === schedule.id).length, 1);
    const scheduled = first.list().find(j => j.scheduleId === schedule.id);
    second.cancel(scheduled.id); first.tick(); second.tick();
    await until(() => first.getJob(scheduled.id).status === 'cancelled');
    const stale = first.create(settings());
    const payload = first.getJob(stale.id); payload.status = 'running'; payload.rows = [{ title: '중단 전 결과' }];
    first.db.prepare('UPDATE runs SET status=?,payload=?,owner=?,lease=? WHERE id=?').run('running', JSON.stringify(payload), 'dead-owner', Date.now() - 1, stale.id);
    second.tick();
    assert.equal(first.getJob(stale.id).status, 'interrupted');
    assert.equal(first.getJob(stale.id).rows[0].title, '중단 전 결과');
  } finally { await first.close(); await second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('real stdio subprocesses handshake, share saved actors, return tool errors and shut down cleanly', async () => {
  const dir = temporary();
  const entries = [];
  try {
    for (const name of ['codex-protocol-client', 'claude-protocol-client']) {
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp-server.js')], env: { ...process.env, POCKET_DATA_DIR: dir }, stderr: 'pipe' });
      const client = new Client({ name, version: '1.0.0' });
      entries.push({ client, transport });
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 19);
    }
    const [codex, claude] = entries.map(e => e.client);
    await call(codex, 'save-actor', { name: 'shared-notes', title: '같이 쓰는 수집기', description: '두 클라이언트 공유', baseActor: 'text', input: { urls: ['https://example.com'] } });
    assert.equal((await call(claude, 'search-actors', { query: 'shared-notes' })).total, 1);
    const result = await call(codex, 'call-actor', { actorId: 'text', input: { urls: ['http://127.0.0.1'], maxPages: 1 }, waitSeconds: 3 });
    assert.equal(result.status, 'failed');
    assert.equal((await call(claude, 'get-actor-run', { runId: result.id })).status, 'failed');
    const logs = await call(claude, 'get-run-log', { runId: result.id });
    assert.ok(logs.logs.some(l => l.message.includes('사설 네트워크')));
    assert.equal((await call(codex, 'get-server-info')).transport, 'stdio');
  } finally {
    for (const entry of entries) await entry.client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
