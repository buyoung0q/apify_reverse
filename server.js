import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './lib/store.js';
import { ACTORS, browserOptions, toCsv, validateConfig } from './lib/crawler.js';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), store = new Store(dataDir) } = {}) {
  const app = express();
  const token = randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    let host;
    try { host = new URL(`http://${req.headers.host}`).hostname; } catch { /* Reject malformed Host below. */ }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return res.status(403).json({ error: '이 앱은 로컬에서만 사용할 수 있습니다.' });
    const origin = req.get('origin');
    if (origin && origin !== `http://${req.headers.host}`) return res.status(403).json({ error: '허용되지 않은 요청 출처입니다.' });
    if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: '다른 사이트의 요청은 허용되지 않습니다.' });
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'Cache-Control': 'no-store',
    });
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD'].includes(req.method)) return next();
    const supplied = Buffer.from(req.get('x-app-token') ?? '');
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.status(403).json({ error: '화면을 새로고침한 후 다시 시도해 주세요.' });
    next();
  });
  app.get('/api/state', (_req, res) => res.json({
    token, actors: ACTORS, runs: store.list(), schedules: [...store.schedules.values()],
    browserAvailable: Boolean(browserOptions()), version: '0.1.0',
  }));
  app.post('/api/runs', (req, res) => {
    const config = validateConfig(req.body);
    if (config.engine === 'browser' && !browserOptions()) throw new Error('브라우저 설치가 필요합니다. npm run install:browser를 실행해 주세요.');
    res.status(201).json(store.create(config));
  });
  app.get('/api/runs/:id', (req, res) => {
    const job = store.jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: '실행 기록이 없습니다.' });
    const offset = Math.max(0, Math.min(Number(req.query.offset) || 0, 5000));
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 100));
    res.json({ ...store.summary(job), logs: job.logs, columns: [...new Set(job.rows.flatMap(row => Object.keys(row)))], rows: job.rows.slice(offset, offset + limit), offset });
  });
  app.post('/api/runs/:id/cancel', (req, res) => res.json(store.cancel(req.params.id)));
  app.post('/api/runs/:id/retry', (req, res) => {
    const job = store.jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: '실행 기록이 없습니다.' });
    res.status(201).json(store.create(job.config));
  });
  app.delete('/api/runs/:id', (req, res) => { store.remove(req.params.id); res.json({ ok: true }); });
  app.get('/api/runs/:id/export', (req, res) => {
    const job = store.jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: '실행 기록이 없습니다.' });
    const format = req.query.format === 'json' ? 'json' : 'csv';
    res.set('Content-Disposition', `attachment; filename="pocket-${job.id.slice(0, 8)}.${format}"`);
    res.type(format === 'json' ? 'application/json' : 'text/csv');
    res.send(format === 'json' ? JSON.stringify(job.rows, null, 2) : toCsv(job.rows));
  });
  app.post('/api/schedules', (req, res) => {
    const config = validateConfig(req.body.config);
    const interval = Number(req.body.intervalHours);
    if (!Number.isFinite(interval) || interval < 1 || interval > 720) throw new Error('예약 간격은 1~720시간으로 설정해 주세요.');
    res.status(201).json(store.addSchedule(config, interval));
  });
  app.patch('/api/schedules/:id', (req, res) => {
    if (typeof req.body.enabled !== 'boolean') throw new Error('예약 상태가 올바르지 않습니다.');
    res.json(store.updateSchedule(req.params.id, req.body.enabled));
  });
  app.delete('/api/schedules/:id', (req, res) => { store.removeSchedule(req.params.id); res.json({ ok: true }); });
  app.use(express.static(path.join(root, 'public')));
  app.use('/api', (_req, res) => res.status(404).json({ error: '요청한 API가 없습니다.' }));
  app.use((error, _req, res, _next) => res.status(error.status || 400).json({ error: error.message || '요청을 처리하지 못했습니다.' }));
  return { app, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { app, store } = createApp();
  const port = Number(process.env.PORT || 4310);
  const server = app.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`\n  Pocket Crawler is ready\n  Local: http://localhost:${port}\n  Press Ctrl+C to stop.\n`);
  });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `포트 ${port}이 이미 사용 중입니다. 기존 창을 확인하거나 PORT를 변경해 주세요.` : error.message); process.exit(1); });
  const shutdown = async () => { server.close(); await store.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
