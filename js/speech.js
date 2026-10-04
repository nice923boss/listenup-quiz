// Voice list, voice picking and a speak() wrapper with watchdogs and online-voice fallback
// (spike decisions D1-D8, D11, D14 in docs/spike-speech.md).
(function (root) {
  'use strict';

  const LATIN_WORD_RE = /[A-Za-z0-9']+/g;
  const HAN_CHAR_RE = /[㐀-鿿豈-﫿]/g;
  const START_TIMEOUT_MS = 3000;
  const VOICE_WAIT_MS = 1500;
  const PREFERRED_TAG = { en: 'en-US', zh: 'zh-TW' };
  const GROUP_LABEL = { en: '英文', zh: '中文' };

  // Units = English words + Han characters (spike 5.5).
  function speechUnits(text) {
    const s = String(text == null ? '' : text);
    return (s.match(LATIN_WORD_RE) || []).length + (s.match(HAN_CHAR_RE) || []).length;
  }

  // Upper bound in seconds before the watchdog gives up on one utterance (D7).
  function watchdogSec(text, rate) {
    return (speechUnits(text) / (2.5 * rate)) * 2 + 5;
  }

  function langGroup(lang) {
    const tag = String(lang || '');
    if (/^en(?:[-_]|$)/i.test(tag)) return 'en';
    if (/^(?:zh|cmn|yue)(?:[-_]|$)/i.test(tag)) return 'zh';
    return null;
  }

  const sameTag = (a, b) => String(a).replace('_', '-').toLowerCase() === b.toLowerCase();

  // Voices of one language: local before online (D3), preferred tag first, then original order.
  function voicesFor(voices, group) {
    return (voices || [])
      .map((voice, index) => ({ voice, index }))
      .filter(({ voice }) => langGroup(voice.lang) === group)
      .sort((a, b) => (Number(!a.voice.localService) - Number(!b.voice.localService))
        || (Number(!sameTag(a.voice.lang, PREFERRED_TAG[group])) - Number(!sameTag(b.voice.lang, PREFERRED_TAG[group])))
        || (a.index - b.index))
      .map(({ voice }) => voice);
  }

  // Saved name -> voice. A name that is not on this computer falls back to the first voice of the language.
  function pickVoice(voices, group, name) {
    const list = voicesFor(voices, group);
    const found = name ? list.find((v) => v.name === name) : null;
    return { voice: found || list[0] || null, missing: name && !found ? name : '' };
  }

  function resolveVoices(names, voices) {
    const en = pickVoice(voices, 'en', names.en);
    const enB = names.enB ? pickVoice(voices, 'en', names.enB) : { voice: en.voice, missing: '' };
    const zh = pickVoice(voices, 'zh', names.zh);
    const notices = [];
    const missingNotice = (picked, group) => {
      if (!picked.missing) return;
      notices.push(picked.voice
        ? `原設定語音「${picked.missing}」在這台電腦不存在，已改用「${picked.voice.name}」。`
        : `原設定語音「${picked.missing}」在這台電腦不存在，也沒有其他${GROUP_LABEL[group]}語音。`);
    };
    missingNotice(en, 'en');
    missingNotice(enB, 'en');
    missingNotice(zh, 'zh');
    return { en: en.voice, enB: enB.voice, zh: zh.voice, notices };
  }

  function voiceStats(voices) {
    const count = (group, local) => voicesFor(voices, group).filter((v) => Boolean(v.localService) === local).length;
    return {
      total: (voices || []).length,
      en: { local: count('en', true), online: count('en', false) },
      zh: { local: count('zh', true), online: count('zh', false) },
    };
  }

  // Dropdown label; online voices are marked because they need the network (D14).
  function voiceLabel(voice) {
    return `${voice.name} (${voice.lang})${voice.localService ? '' : '，需要網路'}`;
  }

  // Calls onChange with the voice list now and on every voiceschanged (Chrome fires twice, D1).
  function watchVoices(onChange, synth = root.speechSynthesis) {
    if (!synth) { onChange([]); return () => {}; }
    let waited = null;
    const emit = () => {
      const list = synth.getVoices();
      if (list.length || waited === 'done') onChange(list);
    };
    const handler = () => { waited = 'done'; emit(); };
    synth.addEventListener('voiceschanged', handler);
    emit();
    waited = setTimeout(() => { waited = 'done'; emit(); }, VOICE_WAIT_MS);
    return () => synth.removeEventListener('voiceschanged', handler);
  }

  // One utterance. Resolves { status: 'end' | 'error' | 'no-start' | 'timeout' | 'cancelled', error }.
  function speakOnce(env, text, voice, lang, rate, handlers) {
    return new Promise((resolve) => {
      const u = new env.Utterance(text);
      if (voice) u.voice = voice;
      u.lang = voice ? voice.lang : PREFERRED_TAG[lang] || PREFERRED_TAG.en;
      u.rate = rate;
      let settled = false;
      let startTimer = null;
      let limitTimer = null;
      const finish = (status, error) => {
        if (settled) return;
        settled = true;
        env.clock.clearTimeout(startTimer);
        env.clock.clearTimeout(limitTimer);
        if (env.current && env.current.utterance === u) env.current = null;
        resolve({ status, error: error || '' });
      };
      const giveUp = (status, message) => {
        env.warn(`[ListenUp Quiz] ${message}: "${text}" (${voice ? voice.name : 'default voice'})`);
        finish(status);
        env.synth.cancel();
      };
      u.onstart = () => {
        env.clock.clearTimeout(startTimer);
        if (handlers.onStart) handlers.onStart();
      };
      u.onboundary = (e) => {
        if (handlers.onBoundary && e.name !== 'sentence') handlers.onBoundary(e.charIndex, e.charLength);
      };
      u.onend = () => finish('end');
      u.onerror = (e) => finish('error', e.error);
      env.current = { utterance: u, cancel: () => finish('cancelled') };
      startTimer = env.clock.setTimeout(() => giveUp('no-start', `onstart not fired within ${START_TIMEOUT_MS} ms`), START_TIMEOUT_MS);
      limitTimer = env.clock.setTimeout(() => giveUp('timeout', 'utterance exceeded watchdog limit'), watchdogSec(text, rate) * 1000);
      env.synth.speak(u);
    });
  }

  // Speaker keeps the current utterance referenced (D6) and swaps a failing online voice
  // for a local voice of the same language for the rest of the session (D8).
  function createSpeaker(options = {}) {
    const env = {
      synth: options.synth || root.speechSynthesis,
      Utterance: options.Utterance || root.SpeechSynthesisUtterance,
      warn: options.warn || ((msg) => console.warn(msg)),
      clock: options.clock || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
      current: null,
    };
    const getVoices = options.getVoices || (() => env.synth.getVoices());
    const onFallback = options.onFallback || (() => {});
    const failed = new Set();
    let generation = 0;

    function localFallback(voice) {
      const group = langGroup(voice.lang);
      return voicesFor(getVoices(), group).find((v) => v.localService && !failed.has(v.name)) || null;
    }

    function usable(voice) {
      return voice && failed.has(voice.name) ? localFallback(voice) : voice;
    }

    // Resolves 'done' when the text was spoken or skipped by a watchdog, 'cancelled' after cancel().
    async function say({ text, voice, lang, rate, onStart, onBoundary }) {
      const mine = generation;
      let current = usable(voice);
      let result = await speakOnce(env, text, current, lang, rate, { onStart, onBoundary });
      while (mine === generation && current && !current.localService
        && (result.status === 'error' || result.status === 'no-start')) {
        failed.add(current.name);
        const local = localFallback(current);
        if (!local) break;
        onFallback(current, local);
        current = local;
        result = await speakOnce(env, text, current, lang, rate, { onStart, onBoundary });
      }
      if (mine !== generation || result.status === 'cancelled') return 'cancelled';
      if (result.status === 'error') env.warn(`[ListenUp Quiz] speech error "${result.error}": "${text}"`);
      return 'done';
    }

    function cancel() {
      generation += 1;
      if (env.current) env.current.cancel();
      if (env.synth) env.synth.cancel();
    }

    return { say, cancel, failedVoices: () => [...failed] };
  }

  const api = {
    speechUnits, watchdogSec, langGroup, voicesFor, pickVoice, resolveVoices, voiceStats, voiceLabel,
    watchVoices, createSpeaker, PREFERRED_TAG,
  };
  root.ListenUpQuiz = root.ListenUpQuiz || {};
  root.ListenUpQuiz.speech = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
