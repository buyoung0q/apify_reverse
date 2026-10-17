import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { crawl } from './crawler.js';
import { crawlInstagram } from './instagram.js';
import { TERMINAL } from './store.js';

const stamp = () => new Date().toISOString();
const decode = record => record ? JSON.parse(record.payload) : null;

// Every MCP client gets its own process; SQLite coordinates all of them.
export class McpStore {
  constructor(directory, { runner = (config, options) => config.actor === 'instagram' ? crawlInstagram(config, options) : crawl(config, options) } = {}) {
    this.directory = directory;
    this.runner = runner;
    this.owner = randomUUID();
    this.closing = false;
    this.active = null;
    this.pending = null;
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'pocket-mcp.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, created TEXT NOT NULL, payload TEXT NOT NULL, owner TEXT, lease INTEGER, cancel INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actors (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_status ON runs(status, created);`);
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref();
    this.tick();
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  summary(job) {
    const { rows, logs, ...rest } = job;
    return { ...rest, rowCount: rows.length, defaultDatasetId: job.id };
  }
  getJob(id) { return decode(this.db.prepare('SELECT payload FROM runs WHERE id=?').get(id)); }
  list({ offset = 0, limit = 20 } = {}) {
    return this.db.prepare('SELECT payload FROM runs ORDER BY created DESC, rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => this.summary(decode(row)));
  }
  createRaw(config, scheduleId = null, actorId = config.actor) {
    if (this.closing) throw new Error('MCP 서버를 종료하는 중입니다.');
    if (this.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n >= 200) throw new Error('실행 기록이 200개입니다. 필요한 결과를 내보낸 뒤 오래된 기록을 삭제해 주세요.');
    if (this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')").get().n >= 20) throw new Error('대기 또는 실행 중인 작업이 20개입니다.');
    const job = { id: randomUUID(), actorId, config, scheduleId, status: 'queued', createdAt: stamp(), startedAt: null, finishedAt: null, processed: 0, failures: 0, successes: 0, rows: [], logs: [] };
    this.db.prepare('INSERT INTO runs(id,status,created,payload) VALUES(?,?,?,?)').run(job.id, job.status, job.createdAt, JSON.stringify(job));
    return this.summary(job);
  }
  create(config, scheduleId = null, actorId = config.actor) { return this.tx(() => this.createRaw(config, scheduleId, actorId)); }
  save(job) {
    // A stale process must never overwrite a job recovered by another process.
    const updated = this.db.prepare('UPDATE runs SET status=?,payload=?,lease=? WHERE id=? AND owner=?').run(job.status, JSON.stringify(job), Date.now() + 30000, job.id, this.owner);
    if (!updated.changes) throw new Error('작업 실행 소유권이 만료되었습니다.');
  }
  cancel(id) {
    return this.tx(() => {
      const job = this.getJob(id);
      if (!job) throw new Error('실행 기록이 없습니다.');
      if (job.status === 'queued') { job.status = 'cancelled'; job.finishedAt = stamp(); this.db.prepare('UPDATE runs SET status=?,payload=? WHERE id=?').run(job.status, JSON.stringify(job), id); }
      else if (job.status === 'running') this.db.prepare('UPDATE runs SET cancel=1 WHERE id=?').run(id);
      return { ...this.summary(job), cancellationRequested: job.status === 'running' };
    });
  }
  remove(id) {
    return this.tx(() => {
      const job = this.getJob(id);
      if (!job) throw new Error('실행 기록이 없습니다.');
      if (!TERMINAL.has(job.status)) throw new Error('실행을 중지하고 종료 상태를 확인한 뒤 삭제해 주세요.');
      this.db.prepare('DELETE FROM runs WHERE id=?').run(id);
    });
  }
  listSchedules() { return this.db.prepare('SELECT payload FROM schedules ORDER BY rowid DESC').all().map(decode); }
  addSchedule(config, intervalHours, actorId) {
    return this.tx(() => {
      if (this.db.prepare('SELECT COUNT(*) AS n FROM schedules').get().n >= 30) throw new Error('예약은 최대 30개입니다.');
      const schedule = { id: randomUUID(), actorId, config, intervalHours, enabled: true, createdAt: stamp(), nextRunAt: new Date(Date.now() + intervalHours * 3600000).toISOString(), lastRunId: null, lastError: null };
      this.db.prepare('INSERT INTO schedules VALUES(?,?)').run(schedule.id, JSON.stringify(schedule));
      return schedule;
    });
  }
  updateSchedule(id, enabled) {
    return this.tx(() => {
      const schedule = decode(this.db.prepare('SELECT payload FROM schedules WHERE id=?').get(id));
      if (!schedule) throw new Error('예약이 없습니다.');
      schedule.enabled = enabled;
      if (enabled) schedule.nextRunAt = new Date(Date.now() + schedule.intervalHours * 3600000).toISOString();
      this.db.prepare('UPDATE schedules SET payload=? WHERE id=?').run(JSON.stringify(schedule), id);
      return schedule;
    });
  }
  removeSchedule(id) {
    if (!this.db.prepare('DELETE FROM schedules WHERE id=?').run(id).changes) throw new Error('예약이 없습니다.');
  }
  listActors() { return this.db.prepare('SELECT payload FROM actors ORDER BY id').all().map(decode); }
  saveActor(actor, overwrite = false) {
    return this.tx(() => {
      const exists = this.db.prepare('SELECT id FROM actors WHERE id=?').get(actor.id);
      if (exists && !overwrite) throw new Error('같은 이름의 수집기가 있습니다. 갱신하려면 overwrite=true를 지정하세요.');
      if (!exists && this.db.prepare('SELECT COUNT(*) AS n FROM actors').get().n >= 100) throw new Error('맞춤 수집기는 최대 100개입니다.');
      this.db.prepare('INSERT INTO actors VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(actor.id, JSON.stringify(actor));
      return actor;
    });
  }
  tick(now = Date.now()) {
    if (this.closing) return;
    try {
      if (this.active) {
        const state = this.db.prepare('SELECT cancel,owner FROM runs WHERE id=?').get(this.active.job.id);
        if (!state || state.owner !== this.owner || state.cancel) this.active.controller.abort(new Error('실행 중지 요청'));
        else this.db.prepare('UPDATE runs SET lease=? WHERE id=? AND owner=?').run(now + 30000, this.active.job.id, this.owner);
      }
      const next = this.tx(() => {
        for (const record of this.db.prepare("SELECT payload FROM runs WHERE status='running' AND lease < ?").all(now)) {
          const stale = decode(record);
          stale.status = 'interrupted'; stale.finishedAt = stamp();
          stale.logs.push({ at: stamp(), level: 'warn', message: '실행 프로세스의 연결이 끊겨 중단되었습니다. 저장된 결과는 유지됩니다.' });
          this.db.prepare('UPDATE runs SET status=?,payload=?,owner=NULL WHERE id=?').run(stale.status, JSON.stringify(stale), stale.id);
        }
        for (const schedule of this.listSchedules()) {
          if (!schedule.enabled || Date.parse(schedule.nextRunAt) > now) continue;
          const overlap = this.db.prepare("SELECT payload FROM runs WHERE status IN ('queued','running')").all().some(record => decode(record).scheduleId === schedule.id);
          if (!overlap) {
            try { schedule.lastRunId = this.createRaw(schedule.config, schedule.id, schedule.actorId).id; schedule.lastError = null; }
            catch (error) { schedule.lastError = error.message; }
          }
          schedule.nextRunAt = new Date(now + schedule.intervalHours * 3600000).toISOString();
          this.db.prepare('UPDATE schedules SET payload=? WHERE id=?').run(JSON.stringify(schedule), schedule.id);
        }
        if (this.active || this.db.prepare("SELECT id FROM runs WHERE status='running' LIMIT 1").get()) return null;
        const job = decode(this.db.prepare("SELECT payload FROM runs WHERE status='queued' ORDER BY created,rowid LIMIT 1").get());
        if (!job) return null;
        job.status = 'running'; job.startedAt = stamp();
        this.db.prepare('UPDATE runs SET status=?,payload=?,owner=?,lease=? WHERE id=?').run(job.status, JSON.stringify(job), this.owner, now + 30000, job.id);
        return job;
      });
      if (next) this.execute(next);
    } catch (error) { console.error(`Pocket MCP worker: ${error.message}`); }
  }
  execute(job) {
    const controller = new AbortController();
    this.active = { job, controller };
    const log = (level, message) => {
      job.logs.push({ at: stamp(), level, message });
      if (job.logs.length > 400) job.logs.shift();
      this.save(job);
    };
    this.pending = (async () => {
      try {
        log('info', 'MCP 수집 작업을 시작했습니다.');
        job.status = await this.runner(job.config, {
          signal: controller.signal, onLog: log, dataDir: this.directory,
          onPage: ({ rows, replaceRows = false, ...progress }) => { if (replaceRows) job.rows = rows; else job.rows.push(...rows); Object.assign(job, progress); this.save(job); },
        });
        if (controller.signal.aborted) job.status = 'cancelled';
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.logs.push({ at: stamp(), level: 'error', message: error.message });
      } finally {
        job.finishedAt = stamp();
        try { this.save(job); } catch (error) { console.error(error.message); }
        this.active = null; this.pending = null;
      }
    })();
  }
  async close() {
    if (this.closing) return;
    this.closing = true; clearInterval(this.timer);
    this.active?.controller.abort(new Error('MCP 연결 종료'));
    if (this.pending) await this.pending;
    this.db.close();
  }
}
