// DOM helpers shared by the UI modules: element builder, icons, motion, number inputs and dialogs.
(function (root) {
  'use strict';

  const doc = root.document;
  const FULL_WIDTH_NUMBER_RE = /[０-９．－]/g;

  const reduceMotion = () => root.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Element builder. 'text' sets textContent; never use it with innerHTML for user text.
  function h(tag, props = {}, children = []) {
    const node = doc.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    });
    [].concat(children).forEach((child) => {
      if (child !== null && child !== undefined && child !== false) node.append(child);
    });
    return node;
  }

  const icon = (name) => h('i', { 'data-lucide': name });

  // Replace <i data-lucide> placeholders inside scope with inline SVG.
  function icons(scope) {
    root.lucide.createIcons({ icons: root.lucide.icons, root: scope || doc });
  }

  // Short UI animation; skipped with reduced motion so it never holds anything up.
  function animate(el, params) {
    if (reduceMotion() || !root.anime) return Promise.resolve();
    return new Promise((resolve) => {
      root.anime.animate(el, { ...params, onComplete: () => resolve() });
    });
  }

  const fadeIn = (el) => animate(el, { opacity: [0, 1], duration: 200, ease: 'out(2)' });
  const fadeOut = (el) => animate(el, { opacity: [1, 0], duration: 180, ease: 'out(2)' });

  // Text box -> number. Blank gives undefined, anything that is not a plain number gives NaN.
  // Full-width digits typed with a Chinese IME are accepted.
  function readNumber(text) {
    const s = String(text == null ? '' : text)
      .replace(FULL_WIDTH_NUMBER_RE, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .trim();
    if (s === '') return undefined;
    return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
  }

  // Red border plus the reason under the input; '' clears it.
  function setFieldError(input, message) {
    input.classList.toggle('is-invalid', Boolean(message));
    input.setAttribute('aria-invalid', String(Boolean(message)));
    const field = input.closest('.field');
    let note = field.querySelector('.field-error');
    if (!note) {
      note = h('span', { class: 'field-error', role: 'alert' });
      field.append(note);
    }
    note.textContent = message;
    note.hidden = !message;
  }

  const cssVar = (name) => root.getComputedStyle(doc.documentElement).getPropertyValue(name).trim();
  const swalTheme = () => doc.documentElement.dataset.theme || 'auto';

  // titleText / text are rendered as plain text by SweetAlert2, so user text is safe in them.
  function confirmDialog({ title, text, confirmText, danger = false }) {
    return root.Swal.fire({
      titleText: title,
      text,
      icon: 'warning',
      theme: swalTheme(),
      showCancelButton: true,
      confirmButtonText: confirmText,
      cancelButtonText: '取消',
      confirmButtonColor: cssVar(danger ? '--danger' : '--accent'),
      reverseButtons: true,
      focusCancel: true,
    }).then((result) => result.isConfirmed);
  }

  // Modal with a list of lines (validation errors, notices). Lines are inserted as text.
  function listDialog({ title, intro, lines, icon: kind = 'error', max = 12 }) {
    const shown = lines.slice(0, max);
    const body = h('div', { class: 'swal-list' }, [
      intro ? h('p', { text: intro }) : null,
      h('ul', {}, shown.map((line) => h('li', { text: line }))),
      lines.length > max ? h('p', { text: `還有 ${lines.length - max} 項沒有列出。` }) : null,
    ]);
    return root.Swal.fire({
      titleText: title,
      html: body,
      icon: kind,
      theme: swalTheme(),
      confirmButtonText: '知道了',
      confirmButtonColor: cssVar('--accent'),
    });
  }

  function toast(text, kind = 'success') {
    return root.Swal.fire({
      toast: true,
      position: 'bottom',
      icon: kind,
      titleText: text,
      timer: kind === 'success' ? 2200 : 5000,
      timerProgressBar: kind !== 'success',
      showConfirmButton: false,
      theme: swalTheme(),
    });
  }

  const api = {
    reduceMotion, h, icon, icons, animate, fadeIn, fadeOut, readNumber, setFieldError,
    confirmDialog, listDialog, toast,
  };
  root.ListenUpQuiz = root.ListenUpQuiz || {};
  root.ListenUpQuiz.ui = api;
})(window);
