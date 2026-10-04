// Editor tab: exam title and section cards (textarea -> live parse preview), drag sort, overrides.
// The DOM is the editing state; collect() turns it back into an exam object.
(function (root) {
  'use strict';

  const NS = root.ListenUpQuiz;
  const { schema, parser, timeline, ui } = NS;
  const { h } = ui;

  const TYPE_UI = {
    words: { label: '單字', hint: '一行一題', placeholder: 'that\nphoto\npink', rows: 7 },
    phonics: { label: '發音字母', hint: '一行一題，用 [ ] 標出底線字母', placeholder: '[d]og\n[g]irl', rows: 7 },
    dialogue: { label: '對話', hint: '每行 A: 或 B: 開頭，空行分隔不同題', placeholder: "A: What's wrong?\nB: Ouch! My foot hurts.", rows: 11 },
    sentences: { label: '句子', hint: '一行一題', placeholder: 'Can you give me a hand?\nWhat\'s wrong?', rows: 7 },
    passage: { label: '短文', hint: '整篇貼上即可，播放時會自動切成句子', placeholder: 'Today is Saturday. It\'s sunny and hot. ...', rows: 11 },
  };
  const OVERRIDES = [
    { key: 'repeat', label: '重複次數', unit: '遍', summary: (v) => `重複 ${v} 遍` },
    { key: 'repeatGapSec', label: '同題重複間隔', unit: '秒', summary: (v) => `同題重複間隔 ${v} 秒` },
    { key: 'itemGapSec', label: '下一題間隔', unit: '秒', summary: (v) => `下一題間隔 ${v} 秒` },
  ];
  const PARSE_DELAY_MS = 150;

  const typeOptions = schema.SECTION_TYPES.map((t) => `<option value="${t}">${TYPE_UI[t].label}</option>`).join('');
  const overrideFields = OVERRIDES.map((o) => `<label class="field num-field"><span class="field-label">${o.label}</span>`
    + `<span class="input-wrap"><input class="input" inputmode="decimal" data-key="${o.key}"><span class="unit">${o.unit}</span></span></label>`).join('');

  // Static markup only; every user value is set through .value / textContent afterwards.
  const CARD_HTML = `
    <div class="section-head">
      <button type="button" class="icon-btn drag-handle" aria-label="拖曳排序" title="拖曳排序"><i data-lucide="grip-vertical"></i></button>
      <input class="input input-id" aria-label="大題代號">
      <select class="input input-type" aria-label="題型">${typeOptions}</select>
      <input class="input input-en en" aria-label="英文標題" placeholder="英文標題，例如 Listen and Choose">
      <button type="button" class="icon-btn toggle" aria-label="收合" aria-expanded="true"><i data-lucide="chevron-down"></i></button>
      <button type="button" class="icon-btn danger" aria-label="刪除大題" title="刪除大題"><i data-lucide="trash-2"></i></button>
    </div>
    <input class="input section-zh" aria-label="中文說明" placeholder="中文說明，例如：仔細聽，選出正確的回應句">
    <div class="collapsed-summary"></div>
    <div class="section-body">
      <label class="field"><span class="field-label">題目內容<small class="type-hint"></small></span>
        <textarea class="input textarea" spellcheck="false"></textarea></label>
      <div class="parse-preview">
        <div class="preview-head"><span class="preview-title"></span><span class="preview-badge"></span></div>
        <ol class="preview-list"></ol>
      </div>
    </div>
    <details class="override"><summary>本大題設定覆寫（留空＝沿用全域）</summary>
      <div class="override-grid">${overrideFields}</div>
    </details>`;

  function fields(card) {
    const q = (sel) => card.querySelector(sel);
    return {
      id: q('.input-id'), type: q('.input-type'), en: q('.input-en'), zh: q('.section-zh'),
      toggle: q('.toggle'), remove: q('.danger'), text: q('.textarea'), hint: q('.type-hint'),
      title: q('.preview-title'), badge: q('.preview-badge'), list: q('.preview-list'),
      summary: q('.collapsed-summary'), details: q('.override'),
      overrides: [...card.querySelectorAll('.override input')],
    };
  }

  // Mixed Chinese / English text is shown as language segments so the teacher sees which voice reads what.
  function langText(text) {
    const segs = timeline.splitByLang(text, 'en');
    if (!segs.some((s) => s.lang === 'zh')) return document.createTextNode(text);
    return h('span', { class: 'segs' }, segs.map((s) => h('span', { class: `seg ${s.lang}`, text: s.text })));
  }

  function speakerLine(tag, text, isB) {
    return h('span', { class: 'line' }, [h('span', { class: isB ? 'speaker b' : 'speaker', text: tag }), langText(text)]);
  }

  function itemContent(type, item) {
    if (type === 'phonics') {
      return parser.phonicsParts(item.text).map((p) => (p.underline ? h('u', { text: p.text }) : document.createTextNode(p.text)));
    }
    if (type === 'dialogue') return item.lines.map((l) => speakerLine(l.speaker, l.text, l.speaker === 'B'));
    if (type === 'passage') return timeline.splitSentences(item.text).map((s, i) => speakerLine(String(i + 1), s.text, false));
    return [langText(item.text)];
  }

  function entryRow(type, entry) {
    if (entry.kind === 'error') {
      return h('li', { class: 'is-error' }, [
        h('span', { class: 'num', text: '?' }),
        h('span', { class: 'txt' }, [h('span', { class: 'err-text', text: entry.text }), h('span', { class: 'err-reason', text: entry.message })]),
      ]);
    }
    return h('li', {}, [h('span', { class: 'num', text: String(entry.index + 1) }), h('span', { class: 'txt' }, itemContent(type, entry.item))]);
  }

  function countText(type, items) {
    if (type === 'passage' && items.length) return `1 題，切成 ${timeline.splitSentences(items[0].text).length} 句`;
    if (type === 'dialogue' && items.length) return `${items.length} 題，${items.reduce((n, it) => n + it.lines.length, 0)} 句`;
    return `${items.length} 題`;
  }

  function createEditor({ page, onChange }) {
    const titleInput = page.querySelector('.input-title');
    const statsEl = page.querySelector('.exam-stats');
    const sectionsEl = page.querySelector('#sections');
    const addBtn = page.querySelector('.add-section');
    const cardState = new WeakMap();
    let defaults = schema.defaultSettings();

    const cards = () => [...sectionsEl.querySelectorAll('.section-card')];
    const stateOf = (card) => cardState.get(card);
    const changed = () => { updateStats(); onChange(); };

    function updateStats() {
      const all = cards();
      const total = all.reduce((n, card) => n + stateOf(card).parsed.items.length, 0);
      statsEl.textContent = all.length ? `${all.length} 個大題，共 ${total} 題` : '還沒有大題，按下方「新增大題」開始輸入';
    }

    function clearAnnotations(card) {
      const st = stateOf(card);
      st.annotations.forEach((a) => a.remove());
      st.annotations = [];
    }

    // Chalk circle around lines that failed to parse; only new errors are animated.
    function annotate(card) {
      clearAnnotations(card);
      const st = stateOf(card);
      if (card.classList.contains('is-collapsed') || card.offsetParent === null) return;
      const color = root.getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
      const seen = new Set();
      st.annotations = [...card.querySelectorAll('.err-text')].map((el) => {
        const key = el.textContent;
        seen.add(key);
        const a = root.RoughNotation.annotate(el, { type: 'circle', color, padding: 6, animate: !ui.reduceMotion() && !st.errorKeys.has(key) });
        a.show();
        return a;
      });
      st.errorKeys = seen;
    }

    function updateSummary(card) {
      const f = fields(card);
      const { parsed } = stateOf(card);
      const badges = [h('span', { class: 'badge note', text: countText(f.type.value, parsed.items) })];
      if (parsed.errors.length) badges.push(h('span', { class: 'badge err', text: `${parsed.errors.length} 行有問題` }));
      const over = OVERRIDES.map((o) => {
        const v = ui.readNumber(f.overrides.find((i) => i.dataset.key === o.key).value);
        return v === undefined || schema.checkNumber(o.key, v) ? '' : o.summary(v);
      }).filter(Boolean);
      if (over.length) badges.push(h('span', { class: 'badge ok', text: `覆寫：${over.join('、')}` }));
      if (f.zh.value.trim()) badges.push(h('span', { text: f.zh.value.trim() }));
      f.summary.replaceChildren(...badges);
    }

    function renderPreview(card) {
      const f = fields(card);
      const type = f.type.value;
      const parsed = parser.parseSection(type, f.text.value);
      stateOf(card).parsed = parsed;
      f.title.textContent = type === 'phonics' ? '解析結果（念的時候去掉括號）' : '解析結果';
      const badge = parsed.errors.length
        ? h('span', { class: 'badge err' }, [ui.icon('circle-alert'), `${parsed.errors.length} 行有問題`])
        : h('span', { class: parsed.items.length ? 'badge ok' : 'badge note' }, [parsed.items.length ? ui.icon('check') : null, countText(type, parsed.items)]);
      f.badge.replaceChildren(badge);
      ui.icons(f.badge);
      f.list.replaceChildren(...parsed.entries.map((e) => entryRow(type, e)));
      annotate(card);
      updateSummary(card);
    }

    function applyType(card) {
      const f = fields(card);
      const cfg = TYPE_UI[f.type.value];
      f.hint.textContent = cfg.hint;
      f.text.placeholder = cfg.placeholder;
      f.text.rows = cfg.rows;
    }

    function applyDefaults(card) {
      fields(card).overrides.forEach((input) => { input.placeholder = `沿用 ${defaults[input.dataset.key]}`; });
    }

    function validateOverride(input) {
      const v = ui.readNumber(input.value);
      ui.setFieldError(input, v === undefined ? '' : schema.checkNumber(input.dataset.key, v));
    }

    function setCollapsed(card, collapsed) {
      card.classList.toggle('is-collapsed', collapsed);
      const { toggle } = fields(card);
      toggle.setAttribute('aria-label', collapsed ? '展開' : '收合');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      if (collapsed) clearAnnotations(card); else annotate(card);
    }

    async function removeCard(card) {
      const id = fields(card).id.value.trim();
      const count = stateOf(card).parsed.items.length;
      const ok = await ui.confirmDialog({
        title: id ? `刪除 ${id} 大題？` : '刪除這個大題？',
        text: count ? `裡面的 ${count} 題會一起刪除。` : '這個大題還沒有題目。',
        confirmText: '刪除',
        danger: true,
      });
      if (!ok) return;
      await ui.fadeOut(card);
      clearAnnotations(card);
      card.remove();
      changed();
    }

    function wire(card) {
      const f = fields(card);
      let timer = null;
      f.text.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { renderPreview(card); changed(); }, PARSE_DELAY_MS);
      });
      f.type.addEventListener('change', () => { applyType(card); renderPreview(card); changed(); });
      [f.id, f.en, f.zh].forEach((input) => input.addEventListener('input', () => { updateSummary(card); onChange(); }));
      f.overrides.forEach((input) => input.addEventListener('input', () => { validateOverride(input); updateSummary(card); onChange(); }));
      f.toggle.addEventListener('click', () => setCollapsed(card, !card.classList.contains('is-collapsed')));
      f.remove.addEventListener('click', () => removeCard(card));
    }

    function createCard(section) {
      const card = h('article', { class: 'card section-card' });
      card.innerHTML = CARD_HTML;
      cardState.set(card, { parsed: { items: [], errors: [], entries: [] }, annotations: [], errorKeys: new Set() });
      const f = fields(card);
      f.id.value = section.id;
      f.type.value = section.type;
      f.en.value = section.titleEn;
      f.zh.value = section.titleZh;
      f.text.value = parser.serializeSection(section.type, section.items);
      const override = section.override || {};
      f.overrides.forEach((input) => {
        const v = override[input.dataset.key];
        input.value = v === undefined ? '' : String(v);
      });
      if (Object.keys(override).length) f.details.open = true;
      applyType(card);
      applyDefaults(card);
      wire(card);
      return card;
    }

    function render(exam) {
      cards().forEach(clearAnnotations);
      titleInput.value = exam.title;
      const list = exam.sections.map(createCard);
      sectionsEl.replaceChildren(...list);
      ui.icons(sectionsEl);
      list.forEach(renderPreview);
      updateStats();
    }

    function nextId() {
      const used = new Set(cards().map((c) => fields(c).id.value.trim().toUpperCase()));
      const letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find((l) => !used.has(l));
      return letter || String(cards().length + 1);
    }

    function addSection() {
      const card = createCard({ id: nextId(), type: 'words', titleEn: '', titleZh: '', items: [] });
      sectionsEl.append(card);
      ui.icons(card);
      renderPreview(card);
      changed();
      card.scrollIntoView({ block: 'center', behavior: ui.reduceMotion() ? 'auto' : 'smooth' });
      fields(card).en.focus({ preventScroll: true });
      ui.fadeIn(card);
    }

    // Exam built from the DOM plus every problem that must be fixed before saving or playing.
    function collect() {
      const errors = [];
      const sections = cards().map((card, i) => {
        const f = fields(card);
        const id = f.id.value.trim();
        const label = id ? `${id} 大題` : `第 ${i + 1} 個大題`;
        if (!id) errors.push({ card, field: f.id, message: `${label}：代號不能空白，例如 A` });
        const type = f.type.value;
        const parsed = parser.parseSection(type, f.text.value);
        parsed.errors.forEach((e) => errors.push({ card, field: f.text, line: e.line, message: `${label}：${e.message}` }));
        const override = {};
        OVERRIDES.forEach((o) => {
          const input = f.overrides.find((x) => x.dataset.key === o.key);
          const v = ui.readNumber(input.value);
          if (v === undefined) return;
          const reason = schema.checkNumber(o.key, v);
          if (reason) errors.push({ card, field: input, message: `${label}的${o.label}：${reason}` });
          else override[o.key] = v;
        });
        const base = { id, type, titleEn: f.en.value.trim(), titleZh: f.zh.value.trim() };
        return Object.keys(override).length ? { ...base, override, items: parsed.items } : { ...base, items: parsed.items };
      });
      return { exam: { schemaVersion: schema.SCHEMA_VERSION, title: titleInput.value.trim(), sections }, errors };
    }

    // Expand, scroll to and focus the field of one collect() error; parse errors select the bad line.
    function reveal(error) {
      setCollapsed(error.card, false);
      const details = error.field.closest('details');
      if (details) details.open = true;
      error.field.scrollIntoView({ block: 'center', behavior: ui.reduceMotion() ? 'auto' : 'smooth' });
      error.field.focus({ preventScroll: true });
      if (error.line) {
        const lines = error.field.value.split('\n');
        const start = lines.slice(0, error.line - 1).reduce((n, l) => n + l.length + 1, 0);
        error.field.setSelectionRange(start, start + lines[error.line - 1].length);
        // Selection alone does not scroll a textarea that kept its scroll position; center the line.
        const lineHeight = parseFloat(root.getComputedStyle(error.field).lineHeight) || 20;
        error.field.scrollTop = Math.max(0, (error.line - 1) * lineHeight - error.field.clientHeight / 2);
      }
    }

    function setGlobalDefaults(settings) {
      defaults = { ...settings };
      cards().forEach(applyDefaults);
    }

    // Circles need a visible layout; call after the editor tab becomes visible again.
    const refreshAnnotations = () => cards().forEach(annotate);

    titleInput.addEventListener('input', onChange);
    addBtn.addEventListener('click', addSection);
    root.Sortable.create(sectionsEl, {
      handle: '.drag-handle',
      animation: ui.reduceMotion() ? 0 : 150,
      onEnd: (e) => { if (e.oldIndex !== e.newIndex) changed(); },
    });

    return { render, collect, reveal, setGlobalDefaults, refreshAnnotations };
  }

  NS.uiEditor = { createEditor };
})(window);
