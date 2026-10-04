// localStorage, project folder export/import (File System Access API) and the JSZip fallback.
(function (root) {
  'use strict';

  const NS = root.ListenUpQuiz || {};
  const schema = NS.schema || require('./schema.js');

  const PREFIX = 'listenupquiz:v1:';
  const KEYS = { exam: 'exam', settings: 'settings', tourSeen: 'tourSeen', theme: 'theme' };
  const EXAM_FILE = 'exam.json';
  const SETTINGS_FILE = 'settings.json';
  const FALLBACK_NAME = 'ListenUp Quiz';
  const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  const INVALID_CHARS_RE = /[\\/:*?"<>|\u0000-\u001f]/g;

  // ---- localStorage ----

  function readRaw(key, store = root.localStorage) {
    try { return store.getItem(PREFIX + key); } catch (err) { return null; }
  }

  // Returns '' on success, otherwise a user-facing reason.
  function writeRaw(key, value, store = root.localStorage) {
    try {
      store.setItem(PREFIX + key, value);
      return '';
    } catch (err) {
      return err && err.name === 'QuotaExceededError' ? '瀏覽器儲存空間已滿，無法儲存。' : `瀏覽器不允許儲存資料（${err && err.message}）。`;
    }
  }

  function readJson(key, store) {
    const raw = readRaw(key, store);
    if (raw === null) return { found: false, value: undefined };
    try { return { found: true, value: JSON.parse(raw) }; } catch (err) { return { found: true, value: undefined }; }
  }

  // Saved exam/settings, validated. exam is null when nothing usable is stored.
  function loadSaved(store) {
    const notices = [];
    let exam = null;
    let settings = schema.defaultSettings();
    const savedExam = readJson(KEYS.exam, store);
    if (savedExam.found) {
      const r = schema.validateExam(savedExam.value);
      if (r.ok) exam = r.value;
      else notices.push('瀏覽器裡儲存的題目格式不正確，已改用空白考卷。');
    }
    const savedSettings = readJson(KEYS.settings, store);
    if (savedSettings.found) {
      const r = schema.validateSettings(savedSettings.value);
      if (r.ok) settings = r.value;
      else notices.push('瀏覽器裡儲存的設定格式不正確，已改用預設值。');
    }
    return { exam, settings, notices };
  }

  function saveAll(exam, settings, store) {
    return writeRaw(KEYS.exam, JSON.stringify(exam), store) || writeRaw(KEYS.settings, JSON.stringify(settings), store);
  }

  const getFlag = (key, store) => readRaw(key, store);
  const setFlag = (key, value, store) => writeRaw(key, value, store);

  // ---- folder names and file contents ----

  // Windows-safe folder name from the exam title.
  function safeFolderName(title, fallback = FALLBACK_NAME) {
    let name = String(title || '').replace(INVALID_CHARS_RE, '').trim().replace(/[. ]+$/, '');
    if (name.length > 100) name = name.slice(0, 100).trim().replace(/[. ]+$/, '');
    if (!name) return fallback;
    return RESERVED_RE.test(name) ? `_${name}` : name;
  }

  const toFileText = (value) => `${JSON.stringify(value, null, 2)}\n`;

  // Parse + validate the two files. settingsText null means the file is missing.
  function parseProject(examText, settingsText) {
    const errors = [];
    const notices = [];
    const parse = (text, file) => {
      try { return JSON.parse(text); } catch (err) {
        errors.push({ file, field: '(整個檔案)', message: `不是有效的 JSON（${err.message}）` });
        return undefined;
      }
    };
    const rawExam = parse(examText, EXAM_FILE);
    const examResult = rawExam === undefined ? null : schema.validateExam(rawExam, EXAM_FILE);
    if (examResult && !examResult.ok) errors.push(...examResult.errors);
    let settings = schema.defaultSettings();
    if (settingsText === null) {
      notices.push('資料夾裡沒有 settings.json，設定改用預設值。');
    } else {
      const rawSettings = parse(settingsText, SETTINGS_FILE);
      const settingsResult = rawSettings === undefined ? null : schema.validateSettings(rawSettings, SETTINGS_FILE);
      if (settingsResult && !settingsResult.ok) errors.push(...settingsResult.errors);
      if (settingsResult && settingsResult.ok) settings = settingsResult.value;
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, exam: examResult.value, settings, notices };
  }

  // Shallowest exam.json among files picked with <input webkitdirectory>, plus its sibling settings.json.
  function findProjectFiles(files) {
    const entries = [...files].map((file) => {
      const path = (file.webkitRelativePath || file.name).split('/');
      return { file, name: path[path.length - 1], dir: path.slice(0, -1).join('/'), depth: path.length };
    });
    const exam = entries.filter((e) => e.name === EXAM_FILE).sort((a, b) => a.depth - b.depth)[0];
    if (!exam) return null;
    const settings = entries.find((e) => e.name === SETTINGS_FILE && e.dir === exam.dir);
    return { exam: exam.file, settings: settings ? settings.file : null };
  }

  // ---- export ----

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function writeFile(dir, name, text) {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  async function hasEntry(dir, name) {
    try { await dir.getDirectoryHandle(name); return true; } catch (err) {
      if (err.name === 'NotFoundError') return false;
      if (err.name === 'TypeMismatchError') return true;
      throw err;
    }
  }

  async function exportZip(name, exam, settings) {
    const zip = new root.JSZip();
    const folder = zip.folder(name);
    folder.file(EXAM_FILE, toFileText(exam));
    folder.file(SETTINGS_FILE, toFileText(settings));
    downloadBlob(await zip.generateAsync({ type: 'blob' }), `${name}.zip`);
  }

  // Resolves { status: 'folder' | 'zip' | 'cancelled', name, reason }.
  async function exportProject({ exam, settings, confirmOverwrite }) {
    const name = safeFolderName(exam.title);
    if (typeof root.showDirectoryPicker !== 'function') {
      await exportZip(name, exam, settings);
      return { status: 'zip', name, reason: '這個瀏覽器不支援直接寫入資料夾' };
    }
    let parent;
    try {
      parent = await root.showDirectoryPicker({ mode: 'readwrite', id: 'listenupquiz' });
    } catch (err) {
      if (err.name === 'AbortError') return { status: 'cancelled', name };
      await exportZip(name, exam, settings);
      return { status: 'zip', name, reason: `無法開啟資料夾選擇視窗（${err.message}）` };
    }
    if (await hasEntry(parent, name) && !(await confirmOverwrite(name))) return { status: 'cancelled', name };
    const dir = await parent.getDirectoryHandle(name, { create: true });
    await writeFile(dir, EXAM_FILE, toFileText(exam));
    await writeFile(dir, SETTINGS_FILE, toFileText(settings));
    return { status: 'folder', name, reason: '' };
  }

  // ---- import ----

  async function readHandleText(dir, name) {
    try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch (err) {
      if (err.name === 'NotFoundError' || err.name === 'TypeMismatchError') return null;
      throw err;
    }
  }

  // Picked folder itself, or (when the teacher picked the parent) its first subfolder holding exam.json.
  async function readFromHandle(dir) {
    const examText = await readHandleText(dir, EXAM_FILE);
    if (examText !== null) return { examText, settingsText: await readHandleText(dir, SETTINGS_FILE) };
    const subdirs = [];
    for await (const entry of dir.values()) if (entry.kind === 'directory') subdirs.push(entry);
    subdirs.sort((a, b) => a.name.localeCompare(b.name));
    for (const sub of subdirs) {
      const text = await readHandleText(sub, EXAM_FILE);
      if (text !== null) return { examText: text, settingsText: await readHandleText(sub, SETTINGS_FILE) };
    }
    return null;
  }

  function pickWithInput() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true;
      input.hidden = true;
      const done = (value) => { input.remove(); resolve(value); };
      input.addEventListener('change', async () => {
        const found = findProjectFiles(input.files);
        if (!found) { done({ picked: true, project: null }); return; }
        const examText = await found.exam.text();
        const settingsText = found.settings ? await found.settings.text() : null;
        done({ picked: true, project: { examText, settingsText } });
      });
      input.addEventListener('cancel', () => done({ picked: false, project: null }));
      document.body.appendChild(input);
      input.click();
    });
  }

  // Resolves { status: 'cancelled' } | { status: 'missing' } | { status: 'invalid', errors }
  //        | { status: 'ok', exam, settings, notices }.
  async function importProject() {
    let picked;
    if (typeof root.showDirectoryPicker === 'function') {
      let dir;
      try {
        dir = await root.showDirectoryPicker({ mode: 'read', id: 'listenupquiz' });
      } catch (err) {
        if (err.name === 'AbortError') return { status: 'cancelled' };
        throw err;
      }
      picked = { picked: true, project: await readFromHandle(dir) };
    } else {
      picked = await pickWithInput();
    }
    if (!picked.picked) return { status: 'cancelled' };
    if (!picked.project) return { status: 'missing' };
    const result = parseProject(picked.project.examText, picked.project.settingsText);
    if (!result.ok) return { status: 'invalid', errors: result.errors };
    return { status: 'ok', exam: result.exam, settings: result.settings, notices: result.notices };
  }

  const api = {
    PREFIX, KEYS, readRaw, writeRaw, loadSaved, saveAll, getFlag, setFlag,
    safeFolderName, toFileText, parseProject, findProjectFiles, exportProject, importProject,
  };
  root.ListenUpQuiz = root.ListenUpQuiz || {};
  root.ListenUpQuiz.storage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
