/* 弹窗栈管理（共用一个遮罩，支持 Esc 关闭） */
const stack = [];

function scrim() { return document.getElementById('scrim'); }
function panel(id) { return document.getElementById(id); }

function sync() {
  const s = scrim();
  if (s) s.classList.toggle('is-open', stack.length > 0);
}

export function openModal(id) {
  const node = panel(id);
  if (!node) return;
  if (!stack.includes(id)) stack.push(id);
  node.classList.add('is-open');
  sync();
}

export function closeModal(id) {
  const node = panel(id);
  if (node) node.classList.remove('is-open');
  const i = stack.indexOf(id);
  if (i >= 0) stack.splice(i, 1);
  sync();
}

export function closeTop() {
  if (!stack.length) return;
  closeModal(stack[stack.length - 1]);
}

export function isModalOpen() { return stack.length > 0; }

export function initOverlay() {
  const s = scrim();
  if (s) s.addEventListener('click', closeTop);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTop();
  });
  document.querySelectorAll('[data-close-modal]').forEach((b) => {
    b.addEventListener('click', () => closeModal(b.dataset.closeModal));
  });
}
