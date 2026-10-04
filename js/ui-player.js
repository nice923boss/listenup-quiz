// Player screen (projected to students): big item number, pass, countdown ring, progress, controls,
// question list, optional question text with word highlight, background-tab warning (D13).
(function (root) {
  'use strict';

  const NS = root.ListenUpQuiz;
  const { schema, timeline, speech, player: engine, ui } = NS;
  const { h } = ui;

  const RING_C = 2 * Math.PI * 44;
  const APP_TITLE = 'ListenUp Quiz';
  const BACKGROUND_TITLE = `（背景中，間隔可能變長）${APP_TITLE}`;
  const BANNER_KEEP_MS = 10000;
  const HIDDEN_TEXT = '題目文字已隱藏（可在設定開啟）';
  const WORD_RE = /^[A-Za-z0-9']+/;
  const GRADIENTS = [['#0f1a16', '#16302a'], ['#101c1d', '#1b2a33'], ['#13201a', '#1f2c22']];

  function countdownLabel(step) {
    switch (step.kind) {
      case 'repeat-gap': return `秒後念第 ${step.ref.pass + 2} 遍`;
      case 'item-gap': return '秒後下一題';
      case 'section-gap': return '秒後下一大題';
      case 'number-gap': return '秒後念題目';
      case 'section-title-gap': return '秒後開始第 1 題';
      default: return '秒後念下一句';
    }
  }

  function createPlayerView({ screen, onExit }) {
    const q = (sel) => screen.querySelector(sel);
    const el = {
      player: q('.player'), exam: q('.pl-exam'), banner: q('#bg-warning'),
      part: q('.pl-part'), titleEn: q('.pl-title-en'), titleZh: q('.pl-title-zh'),
      number: q('#big-number'), pass: q('.pl-pass'), speaking: q('#state-speaking'),
      countdown: q('#state-countdown'), ring: q('#ring-prog'), ringNum: q('#ring-num'), ringLabel: q('.pl-countdown-label'),
      text: q('#pl-text'), count: q('#pl-count'), bar: q('#pl-bar'), sec: q('#pl-sec'),
      main: q('#pl-main'), list: q('#pl-list'), groups: q('#pl-list-groups'), canvas: q('#player-bg'),
    };
    const wakeLock = engine.createWakeLock();
    el.ring.style.strokeDasharray = String(RING_C);

    let session = null;
    let granim = null;
    let fit = null;
    let listMark = null;
    let bannerTimer = null;
    let shownNumber = '';

    // ---- display helpers ----

    function setMainButton(state) {
      const playing = state === 'playing';
      el.main.setAttribute('aria-label', playing ? '暫停' : (state === 'paused' ? '繼續' : '播放'));
      el.main.replaceChildren(ui.icon(playing ? 'pause' : 'play'));
      ui.icons(el.main);
      el.player.classList.toggle('is-paused', !playing);
    }

    function showStatus(mode) {
      el.speaking.hidden = mode !== 'speaking';
      el.countdown.hidden = mode !== 'countdown';
      if (granim) { if (mode === 'countdown') granim.play(); else granim.pause(); }
    }

    function setNumber(text) {
      if (text === shownNumber) return;
      shownNumber = text;
      el.number.textContent = text;
      ui.animate(el.number, { opacity: [0.15, 1], duration: 250, ease: 'out(2)' });
    }

    function setProgress(done, total) {
      el.count.textContent = `第 ${done} / ${total} 題`;
      el.bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    }

    // Question text split into done / now / todo parts; [from, to) is the part being read.
    function renderText(display, from, to) {
      el.text.replaceChildren(
        h('span', { class: 'w-done', text: display.slice(0, from) }),
        h('span', { class: 'w-now', text: display.slice(from, to) }),
        h('span', { class: 'w-todo', text: display.slice(to) }),
      );
    }

    function showItemText(section, itemIndex) {
      const s = session;
      if (!s.settings.showTextWhilePlaying) return;
      if (itemIndex === null) { s.display = ''; el.text.replaceChildren(); return; }
      s.display = timeline.displayText(section, section.items[itemIndex]);
      renderText(s.display, 0, 0);
    }

    function showStep(step) {
      const s = session;
      const { section: si, item, pass } = step.ref;
      const section = s.exam.sections[si];
      const cfg = schema.sectionSettings(s.settings, section);
      el.part.textContent = `Part ${section.id}`;
      el.titleEn.textContent = section.titleEn;
      el.titleZh.textContent = section.titleZh;
      el.sec.textContent = `${section.id} 大題`;
      setProgress((s.ordinals.get(`${si}:${item === null ? 0 : item}`) || 0) + 1, s.starts.length);
      if (`${si}:${item}` !== s.itemKey) {
        s.itemKey = `${si}:${item}`;
        setNumber(item === null ? `Part ${section.id}` : `${section.id}-${item + 1}`);
        showItemText(section, item);
      }
      el.pass.hidden = item === null;
      if (item !== null) el.pass.replaceChildren('第 ', h('b', { text: String(Math.max(pass, 0) + 1) }), ` / ${cfg.repeat} 遍`);
      if (step.type === 'wait') {
        el.ringLabel.textContent = countdownLabel(step);
        showStatus(s.state === 'playing' ? 'countdown' : 'none');
        // The next pass starts with the whole text unread again.
        if (s.settings.showTextWhilePlaying && step.kind === 'repeat-gap') renderText(s.display, 0, 0);
      } else {
        showStatus(s.state === 'playing' ? 'speaking' : 'none');
      }
    }

    function onSpeechStart(step) {
      const s = session;
      if (!s.settings.showTextWhilePlaying || !step.span) return;
      renderText(s.display, step.span[0], step.span[1]);
    }

    // Word highlight from onboundary (D11); falls back to the whole sentence when not fired.
    function onWord(step, charIndex, charLength) {
      const s = session;
      if (!s.settings.showTextWhilePlaying || !step.span) return;
      const from = step.span[0] + charIndex;
      const word = s.display.slice(from).match(WORD_RE);
      const length = charLength || (word ? word[0].length : 0);
      if (length) renderText(s.display, from, Math.min(from + length, step.span[1]));
    }

    function onCountdown(left, total) {
      el.ringNum.textContent = left.toFixed(1);
      el.ring.style.strokeDashoffset = String(total ? RING_C * (1 - left / total) : RING_C);
    }

    function onState(state) {
      session.state = state;
      setMainButton(state);
      if (state === 'playing') {
        wakeLock.acquire();
        showStep(session.steps[session.player.index()]);
      } else {
        wakeLock.release();
        showStatus('none');
      }
    }

    function onEnd() {
      setNumber('播放結束');
      el.pass.hidden = true;
      setProgress(session.starts.length, session.starts.length);
      session.itemKey = null;
      if (session.settings.showTextWhilePlaying) el.text.replaceChildren();
    }

    // ---- question list ----

    function closeList() {
      if (listMark) { listMark.remove(); listMark = null; }
      el.list.hidden = true;
    }

    function openList() {
      const s = session;
      const current = s.state === 'ended' ? s.starts.length : s.player.currentItem();
      const buttons = [];
      const groups = s.exam.sections.map((section, si) => {
        const mine = s.starts.map((start, ordinal) => ({ start, ordinal })).filter(({ start }) => start.section === si);
        if (!mine.length) return null;
        const items = mine.map(({ start, ordinal }) => {
          const cls = ordinal < current ? 'is-done' : (ordinal === current ? 'is-current' : '');
          const b = h('button', { type: 'button', class: cls, text: `${section.id}-${start.item + 1}` });
          b.addEventListener('click', () => { closeList(); s.player.seekItem(ordinal, { autoplay: true }); });
          buttons[ordinal] = b;
          return b;
        });
        return h('div', { class: 'pl-list-group' }, [h('div', { text: `Part ${section.id}` }), h('div', { class: 'pl-list-items' }, items)]);
      }).filter(Boolean);
      el.groups.replaceChildren(...groups);
      el.list.hidden = false;
      const target = buttons[current];
      if (target) {
        listMark = root.RoughNotation.annotate(target, { type: 'highlight', color: 'rgba(242, 201, 76, 0.35)', animate: !ui.reduceMotion() });
        listMark.show();
        target.focus();
      }
    }

    // ---- background tab (D13) ----

    function onVisibility() {
      if (!session) return;
      clearTimeout(bannerTimer);
      if (document.visibilityState === 'hidden') {
        if (session.state !== 'playing') return;
        document.title = BACKGROUND_TITLE;
        el.banner.hidden = false;
      } else {
        document.title = APP_TITLE;
        bannerTimer = setTimeout(() => { el.banner.hidden = true; }, BANNER_KEEP_MS);
      }
    }

    function onKey(e) {
      if (!session) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (e.type === 'keydown' && !e.repeat) session.player.toggle();
      } else if (e.type === 'keydown' && e.key === 'Escape' && !el.list.hidden) {
        closeList();
      }
    }

    // ---- open / close ----

    function startBackground(settings) {
      const wanted = settings.animatedBackground && !ui.reduceMotion() && Boolean(root.Granim);
      el.canvas.hidden = !wanted;
      if (wanted && !granim) {
        granim = new root.Granim({
          element: el.canvas,
          direction: 'diagonal',
          isPausedWhenNotInView: true,
          states: { 'default-state': { gradients: GRADIENTS, transitionSpeed: 6000 } },
        });
      }
      if (!wanted && granim) granim.pause();
    }

    // Must be called inside the click handler: the first speak() runs synchronously (D4).
    function open(exam, settings, voiceList, onFallback) {
      const steps = timeline.buildTimeline(exam, settings);
      const voices = speech.resolveVoices(settings.voices, voiceList);
      const speaker = speech.createSpeaker({ onFallback });
      const s = {
        exam, settings, steps, speaker, state: 'idle', itemKey: null, display: '', ordinals: new Map(),
      };
      session = s;
      s.player = engine.createPlayer(steps, {
        speak: (step, handlers) => speaker.say({
          text: step.text, voice: voices[step.voiceRole], lang: step.lang, rate: settings.rate,
          onStart: handlers.onStart, onBoundary: handlers.onBoundary,
        }),
        cancelSpeech: () => speaker.cancel(),
        on: { onState, onStep: showStep, onSpeechStart, onWord, onCountdown, onEnd },
      });
      s.starts = s.player.starts;
      s.starts.forEach((start, ordinal) => s.ordinals.set(`${start.section}:${start.item}`, ordinal));

      document.body.classList.add('screen-player');
      screen.hidden = false;
      el.exam.textContent = exam.title;
      el.banner.hidden = true;
      el.text.classList.toggle('is-hidden', !settings.showTextWhilePlaying);
      if (!settings.showTextWhilePlaying) el.text.textContent = HIDDEN_TEXT;
      shownNumber = '';
      closeList();
      showStep(steps[0]);
      setMainButton('idle');
      fit = root.fitty(el.number, { minSize: 80, maxSize: Math.round(root.innerHeight * 0.42) });
      startBackground(settings);
      s.player.play();
      el.main.focus();
    }

    function close() {
      if (!session) return;
      session.player.stop();
      session.speaker.cancel();
      wakeLock.release();
      closeList();
      if (fit) { fit.unsubscribe(); fit = null; }
      if (granim) granim.pause();
      clearTimeout(bannerTimer);
      document.title = APP_TITLE;
      document.body.classList.remove('screen-player');
      screen.hidden = true;
      session = null;
    }

    function stop() {
      session.player.stop();
      session.itemKey = null;
      showStep(session.steps[0]);
    }

    q('#pl-back').addEventListener('click', () => { close(); onExit(); });
    q('#pl-stop').addEventListener('click', stop);
    q('#pl-prev').addEventListener('click', () => session.player.prev());
    q('#pl-next').addEventListener('click', () => session.player.next());
    el.main.addEventListener('click', () => session.player.toggle());
    q('#btn-list').addEventListener('click', () => (el.list.hidden ? openList() : closeList()));
    q('#btn-list-close').addEventListener('click', closeList);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKey);

    return { open, close, isOpen: () => session !== null };
  }

  NS.uiPlayer = { createPlayerView };
})(window);
