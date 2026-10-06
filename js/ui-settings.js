// Settings tab: voice pickers with preview, rhythm numbers, reading / display switches and theme.
(function (root) {
  'use strict';

  const NS = root.ListenUpQuiz;
  const { schema, speech, timeline, storage, ui } = NS;
  const { h } = ui;

  const NUM_FIELDS = [
    { key: 'rate', label: '語速', range: '（0.5～1.5）', unit: '倍' },
    { key: 'repeat', label: '每題重複次數', range: '（1～5）', unit: '遍' },
    { key: 'repeatGapSec', label: '同題重複間隔', unit: '秒' },
    { key: 'itemGapSec', label: '下一題間隔', unit: '秒' },
    { key: 'sectionGapSec', label: '大題間隔', unit: '秒' },
    { key: 'numberGapSec', label: '題號後停頓', unit: '秒' },
    { key: 'sectionTitleGapSec', label: '標題後停頓（考卷與大題）', unit: '秒' },
    { key: 'dialogueLineGapSec', label: '對話句間停頓', unit: '秒' },
    { key: 'passageSentenceGapSec', label: '短文句間停頓', unit: '秒' },
    { key: 'pictureLookSec', label: '看圖時間（看圖對話）', unit: '秒' },
    { key: 'pictureItemGapSec', label: '作答時間（看圖對話）', unit: '秒' },
  ];
  const SWITCHES = {
    announceExamTitle: '#set-announce-exam-title', announceExamDescription: '#set-announce-exam-description',
    announceNumber: '#set-announce-number', showTextWhilePlaying: '#set-show-text', animatedBackground: '#set-animated-bg',
  };
  const PREVIEW_TEXT = {
    en: 'Number 1. Can you give me a hand?',
    enB: 'Ouch! My foot hurts.',
    zh: '仔細聽，把正確的號碼寫在單字下方。',
  };
  const GROUP_OF = { en: 'en', enB: 'en', zh: 'zh' };
  const NO_VOICE = { en: '這台電腦沒有英文語音', zh: '這台電腦沒有中文語音' };
  const THEMES = ['auto', 'light', 'dark'];

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }

  function createSettings({ page, onChange, onTour }) {
    const q = (sel) => page.querySelector(sel);
    const selects = { en: q('#voice-en'), enB: q('#voice-enb'), zh: q('#voice-zh') };
    const scanText = q('#voice-scan-text');
    const notice = q('#voice-notice');
    const mixedInput = q('#mixed-text');
    const mixedSegs = q('#mixed-segs');
    const numGrid = q('#num-grid');
    const announceButtons = [...page.querySelectorAll('#seg-announce button')];
    const themeButtons = [...page.querySelectorAll('#seg-theme button')];
    const speaker = speech.createSpeaker();
    let base = schema.defaultSettings();
    let names = { ...base.voices };
    let voices = [];
    let voicesKnown = false;

    const numInputs = NUM_FIELDS.map((f) => {
      const input = h('input', { class: 'input', inputmode: 'decimal', 'data-key': f.key });
      numGrid.append(h('label', { class: 'field num-field' }, [
        h('span', { class: 'field-label', text: f.label + (f.range || '') }),
        h('span', { class: 'input-wrap' }, [input, h('span', { class: 'unit', text: f.unit })]),
      ]));
      return input;
    });

    const pressed = (buttons, attr, value) => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute(attr) === value)));

    // ---- voices ----

    function voiceOption(voice) {
      return h('option', { value: voice.name, text: speech.voiceLabel(voice) });
    }

    function fillSelect(role) {
      const select = selects[role];
      const group = GROUP_OF[role];
      const list = speech.voicesFor(voices, group);
      const first = list[0];
      let autoText = first ? `自動（目前是 ${first.name}）` : `自動（${NO_VOICE[group]}）`;
      if (role === 'enB') autoText = '與英文語音相同';
      const options = [h('option', { value: '', text: autoText })];
      const name = names[role];
      if (name && voicesKnown && !list.some((v) => v.name === name)) {
        const instead = first ? `暫時改用 ${first.name}` : NO_VOICE[group];
        options.push(h('option', { value: name, text: `${name}（這台電腦沒有，${instead}）` }));
      }
      const local = list.filter((v) => v.localService);
      const online = list.filter((v) => !v.localService);
      if (local.length) options.push(h('optgroup', { label: '本機語音（離線可用）' }, local.map(voiceOption)));
      if (online.length) options.push(h('optgroup', { label: '線上語音（需要網路）' }, online.map(voiceOption)));
      // Before the voice list arrives, keep the saved name selectable so it is not lost.
      if (name && !voicesKnown) options.push(h('option', { value: name, text: name }));
      select.replaceChildren(...options);
      select.value = name;
    }

    function updateScan() {
      const s = speech.voiceStats(voices);
      const en = s.en.local + s.en.online;
      const zh = s.zh.local + s.zh.online;
      scanText.replaceChildren('這台電腦偵測到 ', h('b', { text: String(s.total) }), ' 個語音：英文 ', h('b', { text: String(en) }),
        ` 個（本機 ${s.en.local}、線上 ${s.en.online}），中文 `, h('b', { text: String(zh) }), ` 個（本機 ${s.zh.local}、線上 ${s.zh.online}）`);
    }

    function updateNotice() {
      const lines = voicesKnown ? speech.resolveVoices(names, voices).notices : [];
      const enCount = voicesKnown ? speech.voicesFor(voices, 'en').length : -1;
      const noEn = enCount === 0;
      if (noEn) lines.unshift('這台電腦沒有英文語音，無法播放。請到 Windows「設定 > 時間與語言 > 語音」新增英文語音後，按「重新偵測」。');
      if (enCount === 1) lines.push('這台電腦只有 1 個英文語音，對話的 A、B 角會是同一個聲音。要分出兩個人，請到 Windows「設定 > 時間與語言 > 語音」再新增一個英文語音後，按「重新偵測」。');
      if (voicesKnown && !speech.voicesFor(voices, 'zh').length) lines.push('這台電腦沒有中文語音，題目中的中文字可能念不出來。');
      notice.hidden = !lines.length;
      notice.classList.toggle('err', noEn);
      notice.classList.toggle('warn', !noEn);
      notice.querySelector('span').replaceChildren(...lines.map((line) => h('div', { text: line })));
    }

    function setVoices(list) {
      voices = list;
      voicesKnown = true;
      Object.keys(selects).forEach(fillSelect);
      updateScan();
      updateNotice();
    }

    function currentRate() {
      const rate = ui.readNumber(numInputs[0].value);
      return rate !== undefined && !schema.checkNumber('rate', rate) ? rate : base.rate;
    }

    // Reads the text with the voices picked right now; mixed text switches voice per language segment.
    async function preview(role, text) {
      speaker.cancel();
      const picked = speech.resolveVoices(names, voices);
      const segs = timeline.splitByLang(text, role === 'zh' ? 'zh' : 'en');
      const missing = segs.find((seg) => !picked[seg.lang === 'zh' ? 'zh' : 'en']);
      if (missing) { ui.toast(`${NO_VOICE[missing.lang]}，無法試聽`, 'error'); return; }
      const rate = currentRate();
      for (const seg of segs) {
        const voiceRole = seg.lang === 'zh' ? 'zh' : (role === 'enB' ? 'enB' : 'en');
        if (await speaker.say({ text: seg.text, voice: picked[voiceRole], lang: seg.lang, rate }) === 'cancelled') return;
      }
    }

    function renderMixedSegs() {
      const segs = timeline.splitByLang(mixedInput.value, 'en');
      mixedSegs.replaceChildren(...segs.map((s) => h('span', { class: `seg ${s.lang}`, text: s.text })));
    }

    // ---- render / collect ----

    function render(settings) {
      base = { ...settings, voices: { ...settings.voices } };
      names = { ...base.voices };
      Object.keys(selects).forEach(fillSelect);
      updateNotice();
      numInputs.forEach((input) => {
        input.value = String(base[input.dataset.key]);
        ui.setFieldError(input, '');
      });
      Object.entries(SWITCHES).forEach(([key, sel]) => { q(sel).checked = base[key]; });
      pressed(announceButtons, 'data-value', base.announceSection);
    }

    // Settings from the form, plus the problems that block saving and playing.
    function collect() {
      const errors = [];
      const values = {};
      numInputs.forEach((input) => {
        const key = input.dataset.key;
        const value = ui.readNumber(input.value);
        const reason = schema.checkNumber(key, value);
        if (reason) errors.push({ field: input, message: `設定的${NUM_FIELDS.find((f) => f.key === key).label}：${reason}` });
        values[key] = value;
      });
      Object.entries(SWITCHES).forEach(([key, sel]) => { values[key] = q(sel).checked; });
      const announce = announceButtons.find((b) => b.getAttribute('aria-pressed') === 'true');
      values.announceSection = announce ? announce.dataset.value : base.announceSection;
      return { settings: { ...base, ...values, voices: { ...names } }, errors };
    }

    function reveal(error) {
      error.field.scrollIntoView({ block: 'center', behavior: ui.reduceMotion() ? 'auto' : 'smooth' });
      error.field.focus({ preventScroll: true });
    }

    // ---- events ----

    Object.entries(selects).forEach(([role, select]) => select.addEventListener('change', () => {
      names = { ...names, [role]: select.value };
      updateNotice();
      onChange();
    }));
    page.querySelectorAll('[data-preview]').forEach((btn) => btn.addEventListener('click', () => {
      const role = btn.dataset.preview;
      preview(role, role === 'mixed' ? mixedInput.value : PREVIEW_TEXT[role]);
    }));
    q('#btn-rescan').addEventListener('click', () => {
      setVoices(root.speechSynthesis ? root.speechSynthesis.getVoices() : []);
      ui.toast(`重新偵測完成，共 ${voices.length} 個語音`);
    });
    mixedInput.addEventListener('input', renderMixedSegs);
    numInputs.forEach((input) => input.addEventListener('input', () => {
      ui.setFieldError(input, schema.checkNumber(input.dataset.key, ui.readNumber(input.value)));
      onChange();
    }));
    Object.values(SWITCHES).forEach((sel) => q(sel).addEventListener('change', onChange));
    announceButtons.forEach((btn) => btn.addEventListener('click', () => {
      pressed(announceButtons, 'data-value', btn.dataset.value);
      onChange();
    }));
    themeButtons.forEach((btn) => btn.addEventListener('click', () => {
      const theme = btn.dataset.themeSet;
      applyTheme(theme);
      pressed(themeButtons, 'data-theme-set', theme);
      storage.setFlag(storage.KEYS.theme, theme);
    }));
    q('#btn-tour').addEventListener('click', onTour);

    const savedTheme = storage.getFlag(storage.KEYS.theme);
    const theme = THEMES.includes(savedTheme) ? savedTheme : 'auto';
    applyTheme(theme);
    pressed(themeButtons, 'data-theme-set', theme);
    renderMixedSegs();
    updateScan();

    return { render, collect, reveal, setVoices, stopPreview: () => speaker.cancel(), hasEnglishVoice: () => speech.voicesFor(voices, 'en').length > 0 };
  }

  NS.uiSettings = { createSettings };
})(window);
