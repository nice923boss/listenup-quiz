// Defaults, validation and settings merge for exam.json / settings.json (schemaVersion 1).
(function (root) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const SECTION_TYPES = ['words', 'phonics', 'dialogue', 'picture', 'sentences', 'passage'];
  const ANNOUNCE_SECTION = ['none', 'en', 'en+zh'];
  const GAP_KEYS = ['repeatGapSec', 'itemGapSec', 'sectionGapSec', 'numberGapSec',
    'sectionTitleGapSec', 'dialogueLineGapSec', 'passageSentenceGapSec', 'pictureLookSec', 'pictureItemGapSec'];
  const OVERRIDE_KEYS = ['repeat', 'repeatGapSec', 'itemGapSec'];
  const BOOLEAN_KEYS = ['announceExamTitle', 'announceExamDescription', 'announceNumber', 'showTextWhilePlaying', 'animatedBackground'];
  const VOICE_KEYS = ['en', 'enB', 'zh'];
  // Picture items keep an uploaded image as a data URL (compressed in the editor).
  const IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

  const DEFAULT_SETTINGS = {
    schemaVersion: SCHEMA_VERSION,
    voices: { en: '', enB: '', zh: '' },
    rate: 0.85,
    repeat: 2,
    repeatGapSec: 3,
    itemGapSec: 6,
    sectionGapSec: 10,
    announceExamTitle: true,
    announceExamDescription: true,
    announceNumber: true,
    numberTemplate: 'Number {n}.',
    announceSection: 'en+zh',
    numberGapSec: 0.8,
    sectionTitleGapSec: 1.5,
    dialogueLineGapSec: 0.8,
    passageSentenceGapSec: 0.4,
    pictureLookSec: 5,
    pictureItemGapSec: 10,
    showTextWhilePlaying: false,
    animatedBackground: true,
  };

  const MSG = {
    gap: '請輸入 0～60 之間的數字',
    gapDecimals: '最多到小數點後 1 位',
    repeat: '請輸入 1～5 之間的整數',
    rate: '請輸入 0.5～1.5 之間的數字',
  };

  function defaultSettings() {
    return { ...DEFAULT_SETTINGS, voices: { ...DEFAULT_SETTINGS.voices } };
  }

  function emptyExam() {
    return { schemaVersion: SCHEMA_VERSION, title: '', sections: [] };
  }

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isText = (v) => typeof v === 'string' && v.trim() !== '';

  // Returns '' when valid, otherwise a user-facing reason.
  function checkNumber(key, value) {
    if (GAP_KEYS.includes(key)) {
      if (!isNum(value) || value < 0 || value > 60) return MSG.gap;
      if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) return MSG.gapDecimals;
      return '';
    }
    if (key === 'repeat') return Number.isInteger(value) && value >= 1 && value <= 5 ? '' : MSG.repeat;
    if (key === 'rate') return isNum(value) && value >= 0.5 && value <= 1.5 ? '' : MSG.rate;
    throw new Error(`unknown numeric field: ${key}`);
  }

  function versionError(file, value) {
    if (value === undefined) return { file, field: 'schemaVersion', message: '缺少 schemaVersion' };
    if (value !== SCHEMA_VERSION) {
      return { file, field: 'schemaVersion', message: `不支援的版本 ${JSON.stringify(value)}，只支援 ${SCHEMA_VERSION}` };
    }
    return null;
  }

  function wholeFileError(file) {
    return { file, field: '(整個檔案)', message: '內容必須是 JSON 物件' };
  }

  // Missing fields fall back to defaults; present fields must be valid.
  function validateSettings(input, file = 'settings.json') {
    if (!isObj(input)) return { ok: false, value: null, errors: [wholeFileError(file)] };
    const errors = [];
    const err = (field, message) => errors.push({ file, field, message });
    const vErr = versionError(file, input.schemaVersion);
    if (vErr) errors.push(vErr);
    const base = defaultSettings();
    const has = (key) => input[key] !== undefined;

    let voices = base.voices;
    if (has('voices')) {
      if (!isObj(input.voices)) err('voices', '必須是物件，包含 en、enB、zh');
      else {
        voices = { ...base.voices };
        for (const key of VOICE_KEYS) {
          const v = input.voices[key];
          if (v === undefined) continue;
          if (typeof v !== 'string') err(`voices.${key}`, '必須是文字（語音名稱，空字串代表自動）');
          else voices = { ...voices, [key]: v };
        }
      }
    }

    const picked = {};
    for (const key of ['rate', 'repeat', ...GAP_KEYS]) {
      if (!has(key)) continue;
      const reason = checkNumber(key, input[key]);
      if (reason) err(key, reason);
      else picked[key] = input[key];
    }
    for (const key of BOOLEAN_KEYS) {
      if (!has(key)) continue;
      if (typeof input[key] !== 'boolean') err(key, '必須是 true 或 false');
      else picked[key] = input[key];
    }
    if (has('numberTemplate')) {
      if (typeof input.numberTemplate !== 'string') err('numberTemplate', '必須是文字，例如 "Number {n}."');
      else picked.numberTemplate = input.numberTemplate;
    }
    if (has('announceSection')) {
      if (!ANNOUNCE_SECTION.includes(input.announceSection)) err('announceSection', '必須是 "none"、"en" 或 "en+zh"');
      else picked.announceSection = input.announceSection;
    }

    if (errors.length) return { ok: false, value: null, errors };
    return { ok: true, value: { ...base, ...picked, voices, schemaVersion: SCHEMA_VERSION }, errors: [] };
  }

  function checkItem(type, item, path, err) {
    if (!isObj(item)) { err(path, '每一題必須是物件'); return null; }
    if (type === 'dialogue' || type === 'picture') {
      if (!Array.isArray(item.lines) || item.lines.length === 0) { err(`${path}.lines`, '對話至少要有 1 句'); return null; }
      const lines = item.lines.map((line, j) => {
        const p = `${path}.lines[${j}]`;
        if (!isObj(line)) { err(p, '每一句必須是物件，包含 speaker 與 text'); return null; }
        let ok = true;
        if (line.speaker !== 'A' && line.speaker !== 'B') { err(`${p}.speaker`, '必須是 "A" 或 "B"'); ok = false; }
        if (!isText(line.text) || /[\r\n]/.test(line.text)) { err(`${p}.text`, '台詞不能空白，也不能換行'); ok = false; }
        return ok ? { speaker: line.speaker, text: line.text } : null;
      });
      if (!lines.every(Boolean)) return null;
      if (type !== 'picture' || item.image === undefined) return { lines };
      if (typeof item.image !== 'string' || !IMAGE_RE.test(item.image)) { err(`${path}.image`, '圖片格式不對，必須是 PNG、JPEG、GIF 或 WebP 圖片資料'); return null; }
      return { lines, image: item.image };
    }
    if (!isText(item.text)) { err(`${path}.text`, '題目內容不能空白'); return null; }
    if (type !== 'passage' && /[\r\n]/.test(item.text)) { err(`${path}.text`, '這個題型一題只能有一行'); return null; }
    return { text: item.text };
  }

  function checkOverride(override, path, err) {
    if (!isObj(override)) { err(path, '必須是物件'); return null; }
    const out = {};
    for (const key of Object.keys(override)) {
      if (!OVERRIDE_KEYS.includes(key)) { err(`${path}.${key}`, '不允許的覆寫欄位，只能是 repeat、repeatGapSec、itemGapSec'); continue; }
      const reason = checkNumber(key, override[key]);
      if (reason) err(`${path}.${key}`, reason);
      else out[key] = override[key];
    }
    return out;
  }

  function checkSection(section, i, err) {
    const path = `sections[${i}]`;
    if (!isObj(section)) { err(path, '每個大題必須是物件'); return null; }
    let ok = true;
    const fail = (field, message) => { err(`${path}.${field}`, message); ok = false; };
    if (!isText(section.id)) fail('id', '代號不能空白，例如 A');
    if (!SECTION_TYPES.includes(section.type)) fail('type', `必須是 ${SECTION_TYPES.join('、')} 其中之一`);
    for (const key of ['titleEn', 'titleZh']) if (typeof section[key] !== 'string') fail(key, '必須是文字（可以是空字串）');
    let items = [];
    if (!Array.isArray(section.items)) fail('items', '必須是陣列');
    else if (section.type === 'passage' && section.items.length > 1) fail('items', '短文大題只能有 1 題');
    else items = section.items.map((item, j) => checkItem(section.type, item, `${path}.items[${j}]`, err));
    if (items.some((x) => x === null)) ok = false;
    let override;
    if (section.override !== undefined) {
      override = checkOverride(section.override, `${path}.override`, (f, m) => { err(f, m); ok = false; });
      if (!override) ok = false;
      else if (!Object.keys(override).length) override = undefined;
    }
    if (!ok) return null;
    const out = { id: section.id, type: section.type, titleEn: section.titleEn, titleZh: section.titleZh };
    return override ? { ...out, override, items } : { ...out, items };
  }

  function validateExam(input, file = 'exam.json') {
    if (!isObj(input)) return { ok: false, value: null, errors: [wholeFileError(file)] };
    const errors = [];
    const err = (field, message) => errors.push({ file, field, message });
    const vErr = versionError(file, input.schemaVersion);
    if (vErr) errors.push(vErr);
    if (typeof input.title !== 'string') err('title', '考卷標題必須是文字');
    // Optional; kept only when it has text, like override and image.
    if (input.description !== undefined && typeof input.description !== 'string') err('description', '考卷說明必須是文字');
    if (input.closing !== undefined && typeof input.closing !== 'string') err('closing', '考卷結尾必須是文字');
    let sections = [];
    if (!Array.isArray(input.sections)) err('sections', '必須是陣列');
    else sections = input.sections.map((s, i) => checkSection(s, i, err));
    if (errors.length) return { ok: false, value: null, errors };
    const head = { schemaVersion: SCHEMA_VERSION, title: input.title };
    const value = isText(input.description) ? { ...head, description: input.description, sections } : { ...head, sections };
    return { ok: true, value: isText(input.closing) ? { ...value, closing: input.closing } : value, errors: [] };
  }

  // Section override wins over global settings; only OVERRIDE_KEYS are applied.
  // Picture sections wait pictureItemGapSec between items (answer time) instead of itemGapSec.
  function sectionSettings(settings, section) {
    const override = (section && section.override) || {};
    const picked = {};
    for (const key of OVERRIDE_KEYS) if (override[key] !== undefined) picked[key] = override[key];
    const base = section && section.type === 'picture' ? { ...settings, itemGapSec: settings.pictureItemGapSec } : settings;
    return { ...base, ...picked };
  }

  function formatError(e) {
    return `${e.file} 的 ${e.field}：${e.message}`;
  }

  const api = {
    SCHEMA_VERSION, SECTION_TYPES, ANNOUNCE_SECTION, GAP_KEYS, OVERRIDE_KEYS,
    defaultSettings, emptyExam, checkNumber, validateSettings, validateExam, sectionSettings, formatError,
  };
  root.ListenUpQuiz = root.ListenUpQuiz || {};
  root.ListenUpQuiz.schema = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
