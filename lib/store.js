import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { crawl } from './crawler.js';

export const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled', 'interrupted']);
const stamp = () => new Date().toISOString();
function save(file, value) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value), 'utf8');
  renameSync(`${file}.tmp`, file);
}

export class Store {
  constructor(directory, { runner = crawl } = {}) {
    this.directory = directory;
    this.runner = runner;
    this.jobs = new Map();
    this.schedules = new Map();
    this.active = null;
    this.closing = false;
    this.pending = null;
    mkdirSync(path.join(directory, 'runs'), { recursive: true });
    for (const file of readdirSync(path.join(directory, 'runs')).filter(f => f.endsWith('.json'))) {
      const job = JSON.parse(readFileSync(path.join(directory, 'runs', file), 'utf8'));
      if (!TERMINAL.has(job.status)) {
        job.status = 'interrupted';
        job.finishedAt = stamp();
        job.logs.push({ at: stamp(), level: 'warn', message: '앱이 종료되어 실행이 중단되었습니다. 다시 실행해 주세요.' });
        this.saveJob(job);
      }
      this.jobs.set(job.id, job);
    }
    try {
      for (const schedule of JSON.parse(readFileSync(path.join(directory, 'schedules.json'), 'utf8'))) this.schedules.set(schedule.id, schedule);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  saveJob(job) { save(path.join(this.directory, 'runs', `${job.id}.json`), job); }
  saveSchedules() { save(path.join(this.directory, 'schedules.json'), [...this.schedules.values()]); }
  summary(job) { const { rows, logs, ...rest } = job; return { ...rest, rowCount: rows.length }; }
  list() { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(job => this.summary(job)); }
  create(config, scheduleId = null) {
    if (this.closing) throw new Error('앱을 종료하는 중입니다.');
    if (this.jobs.size >= 200) throw new Error('실행 기록이 200개입니다. 오래된 기록을 삭제한 뒤 다시 시도해 주세요.');
    if ([...this.jobs.values()].filter(j => !TERMINAL.has(j.status)).length >= 20) throw new Error('대기 중인 작업이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    const job = { id: randomUUID(), config: structuredClone(config), scheduleId, status: 'queued', createdAt: stamp(), startedAt: null, finishedAt: null, processed: 0, failures: 0, successes: 0, rows: [], logs: [] };
    this.jobs.set(job.id, job);
    this.saveJob(job);
    queueMicrotask(() => this.pump());
    return this.summary(job);
  }
  log(job, level, message) {
    job.logs.push({ at: stamp(), level, message });
    if (job.logs.length > 400) job.logs.shift();
  }
  pump() {
    if (this.active || this.closing) return;
    const job = [...this.jobs.values()].find(j => j.status === 'queued');
    if (!job) return;
    const controller = new AbortController();
    this.active = { id: job.id, controller };
    job.status = 'running';
    job.startedAt = stamp();
    this.log(job, 'info', '작업을 시작했습니다.');
    this.saveJob(job);
    this.pending = (async () => {
      try {
        job.status = await this.runner(job.config, {
          signal: controller.signal,
          onLog: (level, message) => this.log(job, level, message),
          onPage: ({ rows, ...progress }) => { job.rows.push(...rows); Object.assign(job, progress); this.saveJob(job); },
        });
        if (controller.signal.aborted) job.status = 'cancelled';
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        this.log(job, controller.signal.aborted ? 'warn' : 'error', controller.signal.aborted ? '사용자가 실행을 중지했습니다.' : error.message);
      } finally {
        job.finishedAt = stamp();
        this.log(job, 'info', `실행 종료 · ${job.rows.length}개 결과`);
        this.saveJob(job);
        this.active = null;
        this.pending = null;
        queueMicrotask(() => this.pump());
      }
    })();
  }
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('실행 기록이 없습니다.');
    if (job.status === 'queued') {
      job.status = 'cancelled'; job.finishedAt = stamp();
      this.log(job, 'warn', '대기 중인 작업을 취소했습니다.'); this.saveJob(job);
    } else if (this.active?.id === id) this.active.controller.abort(new Error('실행 중지'));
    return this.summary(job);
  }
  remove(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('실행 기록이 없습니다.');
    if (!TERMINAL.has(job.status)) throw new Error('작업을 중지한 후 삭제해 주세요.');
    unlinkSync(path.join(this.directory, 'runs', `${id}.json`));
    this.jobs.delete(id);
  }
  addSchedule(config, intervalHours) {
    if (this.schedules.size >= 30) throw new Error('예약은 최대 30개까지 저장할 수 있습니다.');
    const schedule = { id: randomUUID(), config, intervalHours, enabled: true, createdAt: stamp(), nextRunAt: new Date(Date.now() + intervalHours * 3600000).toISOString(), lastRunId: null, lastError: null };
    this.schedules.set(schedule.id, schedule); this.saveSchedules();
    return schedule;
  }
  updateSchedule(id, enabled) {
    const schedule = this.schedules.get(id);
    if (!schedule) throw new Error('예약이 없습니다.');
    schedule.enabled = enabled;
    if (enabled) schedule.nextRunAt = new Date(Date.now() + schedule.intervalHours * 3600000).toISOString();
    this.saveSchedules(); return schedule;
  }
  removeSchedule(id) { this.schedules.delete(id); this.saveSchedules(); }
  tick(now = Date.now()) {
    if (this.closing) return;
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled || Date.parse(schedule.nextRunAt) > now) continue;
      // Coalesce missed intervals; do not duplicate a still-running scheduled job.
      if (![...this.jobs.values()].some(j => j.scheduleId === schedule.id && !TERMINAL.has(j.status))) {
        try { schedule.lastRunId = this.create(schedule.config, schedule.id).id; schedule.lastError = null; }
        catch (error) { schedule.lastError = error.message; }
      }
      schedule.nextRunAt = new Date(now + schedule.intervalHours * 3600000).toISOString();
      this.saveSchedules();
    }
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    this.active?.controller.abort(new Error('앱 종료'));
    if (this.pending) await this.pending;
  }
}
