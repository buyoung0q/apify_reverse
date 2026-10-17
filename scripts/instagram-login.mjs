import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { browserOptions } from '../lib/crawler.js';
import { sessionFiles, writePrivateJson } from '../lib/instagram-session.js';

const files = sessionFiles(process.argv[2]);
mkdirSync(files.directory, { recursive: true });
if (existsSync(files.lock)) {
  try { const old = JSON.parse(readFileSync(files.lock, 'utf8')); process.kill(old.pid, 0); process.exit(0); }
  catch { try { unlinkSync(files.lock); } catch {} }
}
try { writeFileSync(files.lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); } catch { process.exit(0); }
const status = (state, message) => writePrivateJson(files.status, { status: state, message, pid: process.pid, updatedAt: new Date().toISOString() });
let browser;
try {
  status('waiting_login', '사용자의 직접 로그인을 기다립니다.');
  browser = await chromium.launch({ ...(browserOptions() || {}), headless: false });
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'commit', timeout: 45000 });
  const deadline = Date.now() + 5 * 60000;
  let saved = false;
  while (Date.now() < deadline && !page.isClosed()) {
    const cookies = await context.cookies('https://www.instagram.com/');
    if (cookies.some(cookie => cookie.name === 'sessionid' && cookie.value) && !/\/challenge\/|\/checkpoint\//.test(page.url())) {
      const state = await context.storageState();
      state.cookies = state.cookies.filter(c => c.domain === 'instagram.com' || c.domain.endsWith('.instagram.com'));
      state.origins = state.origins.filter(o => { const host = new URL(o.origin).hostname; return host === 'instagram.com' || host.endsWith('.instagram.com'); });
      writePrivateJson(files.state, state);
      status('saved', '전용 Instagram 세션을 이 컴퓨터에 저장했습니다. 수집을 다시 실행할 수 있습니다.');
      saved = true; break;
    }
    await delay(1500);
  }
  if (!saved) status('closed', '로그인이 완료되지 않았습니다. 필요하면 다시 로그인 창을 여세요.');
} catch (error) { status('failed', error.message.split('\n')[0]); }
finally { await browser?.close().catch(() => {}); try { unlinkSync(files.lock); } catch {} }
