import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const sessionFiles = dataDir => ({
  directory: path.join(dataDir, 'instagram-session'),
  state: path.join(dataDir, 'instagram-session', 'state.json'),
  status: path.join(dataDir, 'instagram-session', 'status.json'),
  lock: path.join(dataDir, 'instagram-session', 'login.lock'),
});
export function writePrivateJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}
export function sessionStatus(dataDir) {
  const files = sessionFiles(dataDir);
  let status = {};
  try { status = JSON.parse(readFileSync(files.status, 'utf8')); } catch {}
  if (status.status === 'waiting_login' && status.pid) {
    try { process.kill(status.pid, 0); } catch { status.status = 'closed'; }
  }
  return { status: status.status || 'not_connected', sessionSaved: existsSync(files.state), updatedAt: status.updatedAt || null, message: status.message || null,
    note: 'sessionSaved는 로컬 세션 저장 여부입니다. 실제 접근 권한과 세션 유효성은 수집할 때 확인합니다. 쿠키나 비밀번호는 MCP 응답에 포함하지 않습니다.' };
}
export async function startInstagramLogin(dataDir) {
  if (sessionStatus(dataDir).status === 'waiting_login') return { ...sessionStatus(dataDir), nextStep: '이미 열린 전용 브라우저에서 로그인을 마쳐 주세요.' };
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'instagram-login.mjs'), path.resolve(dataDir)], { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return { status: 'opening_browser', nextStep: '새로 열리는 전용 브라우저에서 사용자가 직접 Instagram에 로그인하세요. 비밀번호·인증코드를 채팅에 보내지 마세요. 로그인 후 창이 자동으로 닫히면 instagram-session(action=status)로 저장을 확인하세요.', timeoutMinutes: 5 };
}
export function clearInstagramSession(dataDir) {
  if (sessionStatus(dataDir).status === 'waiting_login') throw new Error('열려 있는 Instagram 로그인 창을 먼저 닫아 주세요.');
  const files = sessionFiles(dataDir);
  if (existsSync(files.state)) unlinkSync(files.state);
  writePrivateJson(files.status, { status: 'cleared', updatedAt: new Date().toISOString() });
  return sessionStatus(dataDir);
}
