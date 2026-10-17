const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 12h8M8 16h6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  activity: '<path d="M2 12h4l3-8 5 16 3-8h5"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
$$('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = value => Number(value).toLocaleString('ko-KR');
const date = value => value ? new Date(value).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const labels = { queued: '대기 중', running: '실행 중', succeeded: '완료', partial: '일부 완료', failed: '실패', cancelled: '중지됨', interrupted: '앱 종료로 중단' };
const active = job => ['queued', 'running'].includes(job.status);
const badge = status => `<span class="badge ${esc(status)}">${labels[status] || esc(status)}</span>`;
let state = { actors: [], runs: [], schedules: [] };
let token;
let currentView = 'home';
let selectedActor = 'text';
let selectedId;
let detailTab = 'results';
let offset = 0;
let toastTimer;
let refreshing = false;
let detailRequest = 0;
let detailSignature;
let historySignature;
let schedulesSignature;

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'X-App-Token': token || '', ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '요청을 처리하지 못했습니다.');
  return result;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200);
}
function empty(title, description, button = true, type = 'layers') {
  return `<div class="empty"><div class="empty-icon">${icon(type)}</div><h3>${title}</h3><p>${description}</p>${button ? '<button class="secondary" data-new="text">+ 첫 수집 시작하기</button>' : ''}</div>`;
}
function renderRuns(runs, filtered = false) {
  if (!runs.length) return filtered ? empty('일치하는 기록이 없어요', '검색어나 상태 필터를 바꿔보세요.', false, 'search') : empty('아직 수집한 기록이 없어요', '수집기를 선택하고 첫 번째 데이터를 모아보세요.');
  return `<div class="table-scroll"><table class="run-table"><thead><tr><th>수집 이름</th><th>상태</th><th>결과</th><th>시작 시간</th><th></th></tr></thead><tbody>${runs.map(job => `<tr><td><button class="run-title" data-detail="${job.id}">${esc(job.config.name)}</button><span class="run-url">${esc(job.config.urls[0])}</span></td><td>${badge(job.status)}</td><td class="row-count">${number(job.rowCount)} <span class="muted">개</span></td><td class="muted">${date(job.createdAt)}</td><td><button class="arrow-button" data-detail="${job.id}" aria-label="${esc(job.config.name)} 상세 보기">↗</button></td></tr>`).join('')}</tbody></table></div>`;
}
function renderHistory() {
  const search = $('#run-search').value.trim().toLowerCase();
  const filter = $('#run-filter').value;
  const runs = state.runs.filter(job => (!search || `${job.config.name} ${job.config.urls.join(' ')}`.toLowerCase().includes(search)) && (filter === 'all' || (filter === 'running' ? active(job) : job.status === filter)));
  $('#all-runs').innerHTML = renderRuns(runs, Boolean(search || filter !== 'all'));
}
function render() {
  $('#stat-total').textContent = number(state.runs.length);
  $('#stat-rows').innerHTML = `${number(state.runs.reduce((sum, job) => sum + job.rowCount, 0))}<span>개</span>`;
  $('#stat-running').textContent = number(state.runs.filter(job => job.status === 'running').length);
  const waiting = state.runs.filter(job => job.status === 'queued').length;
  $('#stat-running-note').textContent = waiting ? `${waiting}개 작업이 차례를 기다리고 있어요` : state.runs.some(active) ? '데이터를 차근차근 모으고 있어요' : '새로운 수집을 시작해 보세요';
  $('#stat-schedules').textContent = number(state.schedules.filter(s => s.enabled).length);
  $('#run-count').textContent = state.runs.length;
  const nextHistory = JSON.stringify(state.runs);
  if (historySignature !== nextHistory) {
    historySignature = nextHistory;
    $('#recent-runs').innerHTML = renderRuns(state.runs.slice(0, 5));
    renderHistory();
  }
  const nextSchedules = JSON.stringify(state.schedules);
  if (schedulesSignature !== nextSchedules) {
    schedulesSignature = nextSchedules;
    $('#schedules-list').innerHTML = state.schedules.length ? state.schedules.map(s => `<div class="schedule-card"><div><h3>${esc(s.config.name)}</h3><p>${number(s.intervalHours)}시간마다 · ${s.enabled ? `다음 실행 ${date(s.nextRunAt)}` : '일시 정지됨'}</p><p>${esc(s.config.urls[0])}</p>${s.lastError ? `<p class="danger">${esc(s.lastError)}</p>` : ''}${s.lastRunId ? `<button class="text-button" data-detail="${s.lastRunId}">최근 실행 보기 →</button>` : ''}</div><div class="schedule-actions"><span class="badge ${s.enabled ? 'succeeded' : 'cancelled'}">${s.enabled ? '예약 활성' : '일시 정지'}</span><button class="secondary" data-toggle-schedule="${s.id}">${s.enabled ? '일시 정지' : '다시 켜기'}</button><button class="text-button danger" data-delete-schedule="${s.id}">삭제</button></div></div>`).join('') : `<div class="panel">${empty('아직 예약된 수집이 없어요', '수집 설정에서 반복 실행을 켜두면, 원하는 간격으로 자동 수집해요.', false, 'clock')}<div class="empty-small"><button class="secondary" id="empty-schedule">+ 예약 만들기</button></div></div>`;
  }
}
function setView(view) {
  currentView = view;
  $$('.view').forEach(el => { el.hidden = el.id !== `view-${view}`; });
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  $('#breadcrumb-current').textContent = { home: '수집 공간', runs: '실행 기록', schedules: '예약 실행' }[view];
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function setActor(actor) {
  selectedActor = actor;
  $$('#form-actors button').forEach(el => el.classList.toggle('selected', el.dataset.actor === actor));
  $('#custom-fields').hidden = actor !== 'custom';
}
function addField(name = '', selector = '', attr = '') {
  if ($$('.field-row').length >= 12) return toast('필드는 최대 12개입니다.');
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `<input placeholder="필드명 (name)" aria-label="필드명" maxlength="40" data-field="name" value="${esc(name)}"><input placeholder="선택자 (h2)" aria-label="필드 CSS 선택자" maxlength="300" data-field="selector" value="${esc(selector)}"><input placeholder="속성 (href)" aria-label="추출 속성, 비우면 텍스트" maxlength="50" data-field="attr" value="${esc(attr)}"><button type="button" class="icon-button" data-remove-field aria-label="필드 삭제">×</button>`;
  $('#field-rows').append(row);
}
function updateScheduleForm() {
  const schedule = $('#schedule-check').checked;
  $('#interval-wrap').hidden = !schedule;
  $('#form-title').textContent = schedule ? '반복 수집 예약' : '새 수집 시작';
  $('#submit-run').innerHTML = `${icon(schedule ? 'clock' : 'play')}${schedule ? '예약 저장' : '수집 시작'}`;
}
function openCreate(actor = 'text', schedule = false, example = false) {
  const form = $('#create-form');
  form.reset();
  $('#field-rows').innerHTML = '';
  addField('title', 'h2');
  addField('link', 'a', 'href');
  setActor(actor);
  $('#form-error').hidden = true;
  $('#schedule-check').checked = schedule;
  if (example) {
    form.elements.name.value = '첫 수집 · Example Domain';
    form.elements.urls.value = 'https://example.com';
    form.elements.maxPages.value = '1';
  }
  $('#browser-hint').textContent = state.browserAvailable ? '브라우저가 준비되어 있어요. 별도의 로그인 세션 없이 실행합니다.' : '브라우저 수집을 쓰려면 npm run install:browser로 Chromium을 설치하세요.';
  updateScheduleForm();
  $('#create-dialog').showModal();
}
function readConfig() {
  const form = $('#create-form');
  return {
    actor: selectedActor, name: form.elements.name.value, urls: form.elements.urls.value,
    maxPages: Number(form.elements.maxPages.value), delayMs: Number(form.elements.delayMs.value),
    engine: form.elements.engine.value, followLinks: form.elements.followLinks.checked, respectRobots: form.elements.respectRobots.checked,
    rowSelector: form.elements.rowSelector.value,
    fields: $$('.field-row').map(row => Object.fromEntries([...row.querySelectorAll('input')].map(el => [el.dataset.field, el.value]))),
  };
}
async function openDetail(id) {
  selectedId = id;
  offset = 0;
  detailTab = 'results';
  detailSignature = null;
  $('#detail-name').textContent = '실행 상세';
  $('#detail-content').innerHTML = '<div class="empty-small">불러오는 중…</div>';
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
  await refreshDetail();
}
async function refreshDetail() {
  if (!selectedId || !$('#detail-dialog').open) return;
  const id = selectedId;
  const serial = ++detailRequest;
  const job = await api(`/api/runs/${id}?offset=${offset}`);
  if (serial !== detailRequest || id !== selectedId || !$('#detail-dialog').open) return;
  const signature = JSON.stringify([job, detailTab]);
  if (signature === detailSignature) return;
  detailSignature = signature;
  const scroll = $('#detail-dialog').scrollTop;
  const tableScroll = $('.detail-dialog .table-scroll')?.scrollLeft || 0;
  $('#detail-name').textContent = job.config.name;
  const fields = job.columns;
  const table = job.rows.length ? `<div class="table-scroll"><table class="results-table"><thead><tr><th>#</th>${fields.map(key => `<th>${esc(key)}</th>`).join('')}</tr></thead><tbody>${job.rows.map((row, index) => `<tr><td>${offset + index + 1}</td>${fields.map(key => `<td><div class="cell-content">${esc(row[key])}</div></td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="pagination"><span>${offset + 1}–${Math.min(offset + 50, job.rowCount)} / ${number(job.rowCount)}</span><button data-page="prev" ${offset === 0 ? 'disabled' : ''}>← 이전</button><button data-page="next" ${offset + 50 >= job.rowCount ? 'disabled' : ''}>다음 →</button></div>` : `<div class="empty-small">${active(job) ? '데이터를 수집하고 있어요. 잠시 기다려 주세요.' : job.status === 'succeeded' ? '조건에 맞는 결과가 없어요. 선택자 또는 실행 방식을 확인해 주세요.' : '저장된 결과가 없어요. 실행 로그를 확인해 주세요.'}</div>`;
  const logs = `<div class="logs">${job.logs.map(log => `<div class="log-line ${esc(log.level)}"><span class="log-time">${new Date(log.at).toLocaleTimeString('ko-KR', { hour12: false })}</span>${esc(log.message)}</div>`).join('') || '대기 중…'}</div>`;
  $('#detail-content').innerHTML = `<div class="detail-body"><div class="detail-meta">${badge(job.status)}<span>${date(job.createdAt)}</span><span>${job.config.engine === 'browser' ? '브라우저' : 'HTML'} 수집</span><span>${esc(state.actors.find(a => a.id === job.config.actor)?.name || '')}</span></div><div class="detail-metrics"><div>수집한 데이터<strong>${number(job.rowCount)} <small>개</small></strong></div><div>처리한 페이지<strong>${job.processed} <small>/ ${job.config.maxPages}</small></strong></div><div>실패한 페이지<strong>${job.failures}</strong></div></div><div class="detail-actions"><a class="secondary" href="/api/runs/${job.id}/export?format=csv" download>↓ CSV 다운로드</a><a class="secondary" href="/api/runs/${job.id}/export?format=json" download>↓ JSON</a>${active(job) ? `<button class="secondary" data-cancel="${job.id}">■ 실행 중지</button>` : `<button class="secondary" data-retry="${job.id}">↻ 다시 실행</button><button class="text-button danger" data-delete-run="${job.id}">기록 삭제</button>`}</div><div class="detail-tabs"><button data-tab="results" class="${detailTab === 'results' ? 'selected' : ''}">결과 데이터 ${number(job.rowCount)}</button><button data-tab="logs" class="${detailTab === 'logs' ? 'selected' : ''}">실행 로그</button></div>${detailTab === 'logs' ? logs : table}</div>`;
  $('#detail-dialog').scrollTop = scroll;
  if ($('.detail-dialog .table-scroll')) $('.detail-dialog .table-scroll').scrollLeft = tableScroll;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api('/api/state'); token = state.token;
    $('#connection-text').textContent = '로컬 연결됨';
    $('.connection').classList.remove('offline');
    render();
    if (selectedId) await refreshDetail();
  } catch (error) {
    $('#connection-text').textContent = '연결 끊김 · 앱 실행 확인';
    $('.connection').classList.add('offline');
  } finally { refreshing = false; }
}

document.addEventListener('click', async event => {
  const target = event.target.closest('button,a');
  if (!target) return;
  try {
    if (target.dataset.view) setView(target.dataset.view);
    if (target.classList.contains('brand')) { event.preventDefault(); setView('home'); }
    if (target.dataset.new) openCreate(target.dataset.new);
    if (target.dataset.close) $(`#${target.dataset.close}`).close();
    if (target.dataset.actor) setActor(target.dataset.actor);
    if (target.hasAttribute('data-remove-field')) target.closest('.field-row').remove();
    if (target.dataset.detail) await openDetail(target.dataset.detail);
    if (target.id === 'new-schedule' || target.id === 'empty-schedule') openCreate('text', true);
    if (target.id === 'demo') openCreate('text', false, true);
    if (target.id === 'help-open') $('#help-dialog').showModal();
    if (target.id === 'add-field') addField();
    if (target.dataset.tab) { detailTab = target.dataset.tab; await refreshDetail(); }
    if (target.dataset.page) { offset += target.dataset.page === 'next' ? 50 : -50; await refreshDetail(); }
    if (target.dataset.cancel) { await api(`/api/runs/${target.dataset.cancel}/cancel`, { method: 'POST' }); toast('중지 요청을 보냈습니다.'); await refresh(); }
    if (target.dataset.retry) {
      target.disabled = true;
      const job = await api(`/api/runs/${target.dataset.retry}/retry`, { method: 'POST' });
      await openDetail(job.id); await refresh(); toast('새 실행을 시작했습니다.');
    }
    if (target.dataset.deleteRun && confirm('이 실행의 결과와 로그를 삭제할까요? 다운로드한 파일은 유지됩니다.')) {
      await api(`/api/runs/${target.dataset.deleteRun}`, { method: 'DELETE' }); $('#detail-dialog').close(); await refresh(); toast('실행 기록을 삭제했습니다.');
    }
    if (target.dataset.toggleSchedule) {
      const schedule = state.schedules.find(s => s.id === target.dataset.toggleSchedule);
      await api(`/api/schedules/${schedule.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !schedule.enabled }) }); await refresh();
    }
    if (target.dataset.deleteSchedule && confirm('이 예약을 삭제할까요? 기존 실행 기록은 유지됩니다.')) {
      await api(`/api/schedules/${target.dataset.deleteSchedule}`, { method: 'DELETE' }); await refresh(); toast('예약을 삭제했습니다.');
    }
  } catch (error) { toast(error.message, true); }
  finally { target.disabled = false; }
});
$('#create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('#submit-run'); submit.disabled = true;
  $('#form-error').hidden = true;
  try {
    const config = readConfig();
    if ($('#schedule-check').checked) {
      await api('/api/schedules', { method: 'POST', body: JSON.stringify({ config, intervalHours: Number($('#create-form').elements.intervalHours.value) }) });
      $('#create-dialog').close(); setView('schedules'); toast('반복 수집을 예약했습니다.');
    } else {
      const job = await api('/api/runs', { method: 'POST', body: JSON.stringify(config) });
      $('#create-dialog').close(); await openDetail(job.id); toast('수집을 시작했습니다.');
    }
    await refresh();
  } catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; $('#form-error').scrollIntoView({ block: 'nearest' }); }
  finally { submit.disabled = false; }
});
$('#schedule-check').addEventListener('change', updateScheduleForm);
$('#run-search').addEventListener('input', renderHistory);
$('#run-filter').addEventListener('change', renderHistory);
$('#detail-dialog').addEventListener('close', () => { selectedId = null; ++detailRequest; });
await refresh();
const actors = state.actors.length ? state.actors : [
  { id: 'text', name: '웹페이지 본문', description: '제목, 설명, 본문을 깔끔하게 모아요.', icon: 'file', tag: '리서치 · AI 자료' },
  { id: 'links', name: '링크 수집', description: '페이지의 링크와 텍스트를 목록으로 만들어요.', icon: 'link', tag: '사이트 탐색' },
  { id: 'custom', name: '맞춤 데이터', description: 'CSS 선택자로 필요한 항목만 추출해요.', icon: 'grid', tag: '상품 · 목록' },
];
$('#actors').innerHTML = actors.map((actor, index) => `<article class="actor-card"><div class="actor-top"><div class="actor-icon">${icon(actor.icon)}</div><span class="actor-label">COLLECTOR 0${index + 1}</span></div><h3>${actor.name}</h3><p>${actor.description}</p><div class="actor-bottom"><span class="actor-tag">${actor.tag}</span><button data-new="${actor.id}">사용하기 <span>→</span></button></div></article>`).join('');
$('#form-actors').innerHTML = actors.map(actor => `<button type="button" data-actor="${actor.id}">${actor.name}</button>`).join('');
setInterval(() => { if (!document.hidden) refresh(); }, 1800);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
