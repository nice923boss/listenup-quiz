// Playback engine: walks the timeline steps, handles pause/resume (D9), gaps timed after onend (D10)
// and jumping between items. The DOM and speech are injected so the engine runs under Node tests.
(function (root) {
  'use strict';

  const NS = root.ListenUpQuiz || {};
  const timeline = NS.timeline || require('./timeline.js');
  const TICK_MS = 100;

  const realClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    now: () => Date.now(),
  };

  // speak(step, { onStart, onBoundary }) must call the browser synchronously (D4)
  // and resolve 'done' or 'cancelled'.
  function createPlayer(steps, { speak, cancelSpeech, clock = realClock, on = {} }) {
    const emit = (name, ...args) => { if (on[name]) on[name](...args); };
    const starts = timeline.itemStarts(steps);
    let state = 'idle';
    let index = 0;
    let token = 0;
    let resumeMs = null;
    let waiting = null;

    function setState(next) {
      if (state === next) return;
      state = next;
      emit('onState', state);
    }

    function waitStep(step, my) {
      const totalMs = step.sec * 1000;
      const end = clock.now() + (resumeMs === null ? totalMs : resumeMs);
      resumeMs = null;
      return new Promise((resolve) => {
        const tick = () => {
          if (my !== token) return;
          const left = Math.max(0, end - clock.now());
          emit('onCountdown', left / 1000, step.sec, step, index);
          if (left <= 0) { waiting = null; resolve(true); return; }
          waiting.timer = clock.setTimeout(tick, Math.min(TICK_MS, left));
        };
        waiting = { end, resolve, timer: null };
        tick();
      });
    }

    function stopWaiting() {
      if (!waiting) return null;
      clock.clearTimeout(waiting.timer);
      const left = Math.max(0, waiting.end - clock.now());
      const { resolve } = waiting;
      waiting = null;
      resolve(false);
      return left;
    }

    async function run() {
      token += 1;
      const my = token;
      while (my === token && index < steps.length) {
        const step = steps[index];
        emit('onStep', step, index);
        if (step.type === 'speak') {
          await speak(step, {
            onStart: () => { if (my === token) emit('onSpeechStart', step, index); },
            onBoundary: (charIndex, charLength) => { if (my === token) emit('onWord', step, charIndex, charLength); },
          });
        } else {
          await waitStep(step, my);
        }
        if (my !== token) return;
        index += 1;
      }
      if (my === token) {
        setState('ended');
        emit('onEnd');
      }
    }

    // Invalidate whatever is in flight. Keeps the remaining wait time when asked to.
    function interrupt(keepRemaining) {
      token += 1;
      const left = stopWaiting();
      resumeMs = keepRemaining && left !== null ? left : null;
      if (state === 'playing') cancelSpeech();
    }

    function play(from) {
      if (state === 'playing') return;
      if (typeof from === 'number') { index = from; resumeMs = null; }
      if (state === 'ended' || index >= steps.length) { index = 0; resumeMs = null; }
      setState('playing');
      run();
    }

    function pause() {
      if (state !== 'playing') return;
      interrupt(true);
      setState('paused');
    }

    function toggle() {
      if (state === 'playing') pause(); else play();
    }

    function stop() {
      interrupt(false);
      index = 0;
      setState('idle');
    }

    function currentItem() {
      let found = 0;
      starts.forEach((s, ordinal) => { if (s.index <= index) found = ordinal; });
      return found;
    }

    function seekItem(ordinal, { autoplay = false } = {}) {
      if (!starts.length) return;
      const target = starts[Math.max(0, Math.min(ordinal, starts.length - 1))];
      const wasPlaying = state === 'playing';
      interrupt(false);
      index = target.index;
      if (wasPlaying) {
        run();
      } else if (autoplay) {
        state = 'paused';
        play();
      } else {
        setState('paused');
        emit('onStep', steps[index], index);
      }
    }

    const next = () => { if (currentItem() < starts.length - 1) seekItem(currentItem() + 1); };
    const prev = () => seekItem(currentItem() - 1);

    return {
      play, pause, toggle, stop, seekItem, next, prev, currentItem,
      starts,
      state: () => state,
      index: () => index,
    };
  }

  // Keeps the screen awake while playing; silently unavailable where the API is missing.
  function createWakeLock(nav = root.navigator, doc = root.document) {
    let sentinel = null;
    let wanted = false;
    let requesting = false;

    async function request() {
      if (!nav || !nav.wakeLock || sentinel || requesting) return;
      requesting = true;
      try {
        const lock = await nav.wakeLock.request('screen');
        if (!wanted) { lock.release(); return; }
        sentinel = lock;
        sentinel.addEventListener('release', () => { sentinel = null; });
      } catch (err) {
        console.warn('[ListenUp Quiz] wake lock unavailable:', err && err.message);
      } finally {
        requesting = false;
      }
    }

    if (doc) {
      doc.addEventListener('visibilitychange', () => {
        if (wanted && doc.visibilityState === 'visible') request();
      });
    }

    return {
      acquire() { wanted = true; request(); },
      release() {
        wanted = false;
        if (sentinel) { sentinel.release(); sentinel = null; }
      },
    };
  }

  const api = { createPlayer, createWakeLock };
  root.ListenUpQuiz = root.ListenUpQuiz || {};
  root.ListenUpQuiz.player = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
