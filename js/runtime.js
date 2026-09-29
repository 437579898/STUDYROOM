/* ===========================================================
   runtime.js —— 运行环境探测
   同一个 public/ 目录既能被本地服务端托管，也能直接扔到静态托管上。
   开机时探一下有没有本地服务端，决定走哪条路。
   =========================================================== */

export const SERVER = 'server';
export const STANDALONE = 'standalone';

let mode = SERVER;

export function getMode() { return mode; }
export function isStandalone() { return mode === STANDALONE; }
export function isServer() { return mode === SERVER; }

/**
 * 探测顺序：
 *   1. 网址带 ?standalone=1  -> 强制纯网页模式（调试用）
 *   2. GET api/health 能拿到 name === 'study-room' -> 有服务端
 *   3. 其它情况（404 / 网络错误 / 静态托管）-> 纯网页模式
 *
 * 注意用相对路径 'api/health' 而不是 '/api/health'，
 * 因为 GitHub Pages 的项目站是挂在 /<仓库名>/ 子路径下的。
 */
export async function detectMode() {
  try {
    const forced = new URLSearchParams(location.search).get('standalone');
    if (forced === '1') { mode = STANDALONE; return mode; }
  } catch { /* ignore */ }

  try {
    const res = await fetch('api/health', { cache: 'no-store' });
    if (res.ok) {
      const j = await res.json();
      if (j && j.name === 'study-room') { mode = SERVER; return mode; }
    }
  } catch { /* 没有服务端，正常 */ }

  mode = STANDALONE;
  return mode;
}

export const modeLabel = () => (mode === SERVER ? '本机服务端' : '纯网页模式');
