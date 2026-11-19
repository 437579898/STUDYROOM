/* ===========================================================
   shots.js —— 对话里的「识图」
   学生要发的是作业照片、教辅截图、手写草稿：
     1. 先在浏览器里压到最长边 1600（文字题够用，体积降到 1/10）；
     2. 服务端模式下把压缩后的 blob 传给 /api/upload，state 里只存 url；
     3. 发给模型前再把 url 取回来转成 data URL —— 模型服务商在公网，
        取不到我们局域网的 api/uploads/xxx，只有 data URL 才一定能读到；
     4. 点缩略图可以放大看（自带灯箱，Esc 关闭）。
   =========================================================== */
import { api } from './api.js';
import { isStandalone } from './runtime.js';

export const MAX_EDGE = 1600;
export const MAX_SHOTS = 10;         // 一条消息最多十张（作业一整页/多选题一次拍完；再多请求体太大，很多服务商会直接拒）
const HARD_EDGE = 1280;              // 压完还是太大时再降一档
const JPEG_Q = 0.86;

function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file).catch(() => loadViaImg(file));
  }
  return loadViaImg(file);
}

function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图读不出来，换一张试试。')); };
    img.src = url;
  });
}

function drawTo(bitmap, maxEdge) {
  const w0 = bitmap.width || bitmap.naturalWidth || 0;
  const h0 = bitmap.height || bitmap.naturalHeight || 0;
  if (!w0 || !h0) throw new Error('这张图的尺寸是 0，可能是坏文件。');
  const scale = Math.min(1, maxEdge / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';            // 透明 PNG 转 JPEG 会变黑，先铺白底
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { canvas, w, h };
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (canvas.toBlob) canvas.toBlob((b) => resolve(b), type, quality);
    else resolve(null);
  });
}

/** 压缩：返回 { blob, w, h, bytes }，blob 可能是 null（环境不支持 canvas 时） */
export async function compressImage(file, maxEdge = MAX_EDGE) {
  const bitmap = await loadBitmap(file);
  let { canvas, w, h } = drawTo(bitmap, maxEdge);
  let blob = await toBlob(canvas, 'image/jpeg', JPEG_Q);
  if (blob && blob.size > 900 * 1024 && maxEdge > HARD_EDGE) {
    ({ canvas, w, h } = drawTo(bitmap, HARD_EDGE));
    blob = (await toBlob(canvas, 'image/jpeg', 0.82)) || blob;
  }
  if (bitmap.close) { try { bitmap.close(); } catch { /* ignore */ } }
  return { blob, w, h, bytes: blob ? blob.size : 0 };
}

/** 拍一张 → 压缩 → 上传（或纯网页模式直接转 data URL）。返回可以放进消息的 shot 对象 */
export async function prepareShot(file) {
  if (!file) throw new Error('没有拿到文件');
  if (!/^image\//.test(file.type || '')) throw new Error('只能选图片（JPG / PNG / WebP / GIF）。');
  if (file.size > 20 * 1024 * 1024) throw new Error('这张图超过 20MB，先在相册里裁一下。');
  // 纯网页模式下图片要跟着 state 一起进 IndexedDB（有配额上限），压得更狠一点
  const { blob, w, h, bytes } = await compressImage(file, isStandalone() ? 1200 : MAX_EDGE);
  const name = String(file.name || '图片').slice(0, 60);
  if (!blob) {
    const up = await api.uploadImage(file, name);
    return { url: up.url, w: 0, h: 0, bytes: file.size, name };
  }
  const up = await api.uploadImage(blob, name);
  return { url: up.url, w, h, bytes, name };
}

/** 发给模型前把 url 变成 data URL（服务商在公网，读不到局域网图片） */
export async function toDataUrl(url) {
  const s = String(url || '');
  if (!s) return '';
  if (s.startsWith('data:')) return s;
  try {
    const res = await fetch(s);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('读取失败'));
      fr.readAsDataURL(blob);
    });
  } catch {
    return '';
  }
}

/* ----------------------------- 灯箱 ----------------------------- */
let viewer = null;

function ensureViewer() {
  if (viewer) return viewer;
  const box = document.createElement('div');
  box.className = 'shot-viewer';
  box.hidden = true;
  box.innerHTML = '<img alt="图片"><div class="shot-viewer__hint">点任意处或按 Esc 关闭</div>';
  box.addEventListener('click', () => closeViewer());
  document.body.append(box);
  viewer = box;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeViewer(); });
  return box;
}

export function openViewer(url) {
  if (!url) return;
  const box = ensureViewer();
  box.querySelector('img').src = url;
  box.hidden = false;
  box.classList.add('is-open');
}

export function closeViewer() {
  if (!viewer) return;
  viewer.classList.remove('is-open');
  viewer.hidden = true;
}

/** 消息气泡里的缩略图行 */
export function shotsNode(shots) {
  const list = (shots || []).filter((s) => s && s.url);
  if (!list.length) return null;
  const row = document.createElement('div');
  row.className = 'msg__shots';
  for (const s of list) {
    const b = document.createElement('button');
    b.className = 'msg__shot';
    b.type = 'button';
    b.title = s.name || '点开看大图';
    const img = document.createElement('img');
    img.src = s.url;
    img.alt = s.name || '图片';
    img.loading = 'lazy';
    b.append(img);
    b.addEventListener('click', () => openViewer(s.url));
    row.append(b);
  }
  return row;
}
