/* ===========================================================
   stage.js —— 固定版面比例
   整个网站画在一块 1200×760 的画布上，等比缩放到窗口。
   这样窗口大小、浏览器缩放、换设备，版面比例都不变。
   =========================================================== */
import { store } from './store.js';

export const STAGE_W = 1200;
export const STAGE_H = 760;

const MIN_W = 640;   // 比这还窄就自动退回自适应，免得缩成一片蚂蚁
const MIN_H = 460;

export function isFluid() {
  return document.body.classList.contains('fluid');
}

export function layoutMode() {
  return (store.state.prefs && store.state.prefs.layout) || 'fixed';
}

export function applyStage() {
  const app = document.getElementById('app');
  if (!app) return null;

  const tooSmall = window.innerWidth < MIN_W || window.innerHeight < MIN_H;
  const fluid = layoutMode() === 'fluid' || tooSmall;

  document.body.classList.toggle('fluid', fluid);

  if (fluid) {
    app.style.removeProperty('--stage-scale');
    return { fluid: true, scale: 1, forced: tooSmall && layoutMode() !== 'fluid' };
  }

  const scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  app.style.setProperty('--stage-scale', String(Math.round(scale * 1000) / 1000));
  return { fluid: false, scale, forced: false };
}

export function initStage() {
  applyStage();
  const kick = () => applyStage();
  window.addEventListener('resize', kick);
  window.addEventListener('orientationchange', () => setTimeout(kick, 150));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', kick);
    window.visualViewport.addEventListener('scroll', kick);
  }
}
