// App wiring: tabs, save / unsaved-change tracking, export and import, voices, playback and the guided tour.
(function (root) {
  'use strict';

  const NS = root.ListenUpQuiz;
  const { schema, storage, speech, ui } = NS;
  const doc = root.document;
  const $ = (sel) => doc.querySelector(sel);

  const appScreen = $('#screen-app');
  const playButton = $('#btn-play');
  const dirtyMark = $('#dirty');
  const tabs = [...doc.querySelectorAll('[data-tab]')];
  const pages = { editor: $('#tab-editor'), settings: $('#tab-settings') };

  let snapshot = '';
  let voiceList = [];
  let voicesKnown = false;

  const editor = NS.uiEditor.createEditor({ page: pages.editor, onChange: changed });
  const settingsUi = NS.uiSettings.createSettings({ page: pages.settings, onChange: settingsChanged, onTour: startTour });
  const playerView = NS.uiPlayer.createPlayerView({ screen: $('#screen-player'), onExit: () => { appScreen.hidden = false; playButton.focus(); } });

  // ---- unsaved changes ----

  const stateKey = () => JSON.stringify({ exam: editor.collect().exam, settings: settingsUi.collect().settings });
  const isDirty = () => stateKey() !== snapshot;

  function markSaved() {
    snapshot = stateKey();
    dirtyMark.hidden = true;
  }

  function changed() {
    dirtyMark.hidden = !isDirty();
  }

  function settingsChanged() {
    const { settings, errors } = settingsUi.collect();
    if (!errors.length) editor.setGlobalDefaults(settings);
    changed();
  }

  root.addEventListener('beforeunload', (e) => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---- tabs ----

  function showTab(name) {
    tabs.forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
    });
    Object.entries(pages).forEach(([key, page]) => { page.hidden = key !== name; });
    if (name === 'editor') editor.refreshAnnotations();
    else settingsUi.stopPreview();
  }

  tabs.forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));

  // ---- collect with validation ----

  // Current exam and settings, or null after showing what has to be fixed first.
  function collectAll() {
    const fromEditor = editor.collect();
    const fromSettings = settingsUi.collect();
    const errors = [
      ...fromEditor.errors.map((e) => ({ ...e, page: 'editor' })),
      ...fromSettings.errors.map((e) => ({ ...e, page: 'settings' })),
    ];
    if (!errors.length) return { exam: fromEditor.exam, settings: fromSettings.settings };
    ui.listDialog({
      title: `有 ${errors.length} 個地方要修正`,
      intro: '修正後才能儲存、播放或下載專案：',
      lines: errors.map((e) => e.message),
    }).then(() => {
      const first = errors[0];
      showTab(first.page);
      if (first.page === 'editor') editor.reveal(first); else settingsUi.reveal(first);
    });
    return null;
  }

  // ---- save / export / import ----

  function save() {
    const data = collectAll();
    if (!data) return;
    const reason = storage.saveAll(data.exam, data.settings);
    if (reason) { ui.toast(`儲存失敗：${reason}`, 'error'); return; }
    markSaved();
    ui.toast('已儲存在這個瀏覽器');
  }

  async function exportProject() {
    const data = collectAll();
    if (!data) return;
    try {
      const result = await storage.exportProject({
        ...data,
        confirmOverwrite: (name) => ui.confirmDialog({
          title: `覆蓋「${name}」資料夾？`,
          text: '這個資料夾已經存在，裡面的 exam.json 與 settings.json 會換成目前的內容。',
          confirmText: '覆蓋',
          danger: true,
        }),
      });
      if (result.status === 'folder') ui.toast(`已寫入資料夾「${result.name}」`);
      if (result.status === 'zip') ui.toast(`已下載 ${result.name}.zip（${result.reason}，請解壓縮後保存）`, 'info');
    } catch (err) {
      console.warn('[ListenUp Quiz] export failed:', err);
      ui.toast(`下載專案失敗：${err.message}`, 'error');
    }
  }

  async function importProject() {
    const hasContent = editor.collect().exam.sections.length > 0;
    if ((hasContent || isDirty()) && !(await ui.confirmDialog({
      title: '載入資料夾？',
      text: '載入成功後，目前的題目與設定會換成資料夾裡的內容。載入失敗則不會變動。',
      confirmText: '選擇資料夾',
    }))) return;
    let result;
    try {
      result = await storage.importProject();
    } catch (err) {
      console.warn('[ListenUp Quiz] import failed:', err);
      ui.toast(`無法讀取資料夾：${err.message}`, 'error');
      return;
    }
    if (result.status === 'cancelled') return;
    if (result.status === 'missing') {
      ui.listDialog({ title: '找不到題目檔', lines: ['選擇的資料夾裡沒有 exam.json。請選擇用「下載專案」存下來的資料夾。'] });
      return;
    }
    if (result.status === 'invalid') {
      ui.listDialog({ title: '無法載入', intro: '檔案內容有問題，目前的資料沒有變動：', lines: result.errors.map(schema.formatError) });
      return;
    }
    editor.render(result.exam);
    settingsUi.render(result.settings);
    editor.setGlobalDefaults(result.settings);
    showTab('editor');
    const reason = storage.saveAll(result.exam, result.settings);
    if (reason) {
      changed();
      ui.toast(`已載入，但存到瀏覽器失敗：${reason}`, 'error');
      return;
    }
    markSaved();
    if (result.notices.length) ui.listDialog({ title: '已載入', lines: result.notices, icon: 'info' });
    else ui.toast(`已載入「${result.exam.title || '未命名考卷'}」`);
  }

  // ---- voices and playback ----

  function updatePlayButton() {
    let reason = '';
    if (!voicesKnown) reason = '正在偵測這台電腦的語音';
    else if (!settingsUi.hasEnglishVoice()) reason = '這台電腦沒有英文語音，請到「設定」查看說明';
    playButton.disabled = Boolean(reason);
    playButton.title = reason;
  }

  speech.watchVoices((list) => {
    voiceList = list;
    voicesKnown = true;
    settingsUi.setVoices(list);
    updatePlayButton();
  });

  // Runs synchronously inside the click so the first utterance keeps the user gesture (D4).
  function play() {
    const data = collectAll();
    if (!data) return;
    if (!data.exam.sections.some((s) => s.items.length)) {
      ui.toast('還沒有題目可以播放，請先在「題目」輸入', 'error');
      return;
    }
    settingsUi.stopPreview();
    appScreen.hidden = true;
    playerView.open(data.exam, data.settings, voiceList, (from, to) => {
      ui.toast(`「${from.name}」無法使用（可能沒有網路），改用「${to.name}」`, 'warning');
    });
  }

  $('#btn-save').addEventListener('click', save);
  $('#btn-export').addEventListener('click', exportProject);
  $('#btn-import').addEventListener('click', importProject);
  playButton.addEventListener('click', play);

  // ---- guided tour ----

  function startTour() {
    storage.setFlag(storage.KEYS.tourSeen, '1');
    showTab('editor');
    root.driver.js.driver({
      showProgress: true,
      progressText: '{{current}} / {{total}}',
      nextBtnText: '下一步',
      prevBtnText: '上一步',
      doneBtnText: '完成',
      steps: [
        { element: '#tab-editor .add-section', popover: { title: '1. 輸入題目', description: '按「新增大題」，選題型，把題目貼進文字框。右邊會即時顯示解析結果，有問題的行會被圈起來。' } },
        { element: '[data-tab="settings"]', popover: { title: '2. 設定', description: '選英文、中文語音並試聽，調整重複次數與間隔秒數。' } },
        { element: '#btn-play', popover: { title: '3. 播放', description: '從第一題開始念整份考卷。播放時按空白鍵可以暫停或繼續。' } },
        { element: '#btn-export', popover: { title: '4. 下載專案', description: '題目和設定存成資料夾（或 zip）。換電腦時用「載入資料夾」讀回來。' } },
      ],
    }).drive();
  }

  // ---- start ----

  const saved = storage.loadSaved();
  editor.render(saved.exam || schema.emptyExam());
  settingsUi.render(saved.settings);
  editor.setGlobalDefaults(saved.settings);
  ui.icons(doc);
  markSaved();
  updatePlayButton();
  const firstVisit = !storage.getFlag(storage.KEYS.tourSeen);
  const notices = saved.notices.length
    ? ui.listDialog({ title: '讀取已存資料時發現問題', lines: saved.notices, icon: 'warning' })
    : Promise.resolve();
  if (firstVisit) notices.then(startTour);
})(window);
