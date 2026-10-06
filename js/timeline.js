// Exam + settings -> flat list of speak / wait steps (spec 4.3 rules 1-8).
(function (root) {
  'use strict';

  const NS = root.ListenUpQuiz || {};
  const schema = NS.schema || require('./schema.js');
  const parser = NS.parser || require('./parser.js');

  const HAN_RE = /[㐀-鿿豈-﫿]/;
  const CJK_PUNCT_RE = /[、-〿！-／：-＠［-｀｛-￯]/;
  const LATIN_RE = /[A-Za-z]/;
  const FULL_LETTER_RE = /[Ａ-Ｚａ-ｚ]/;
  const FULL_ALNUM_RE = /[０-９Ａ-Ｚａ-ｚ]/g;
  const TERMINATOR_RE = /[.!?。！？]+["'”’)\]）」』]*/g;
  const HALF_TERMINATOR_RE = /[.!?]/;
  const ABBREVIATION_RE = /(?:^|[^A-Za-z])(?:Mr|Mrs|Ms|Dr|St|Mt|Jr|Sr|Prof)$/;
  const isText = (v) => typeof v === 'string' && v.trim() !== '';

  // 'zh' / 'en' for script letters and CJK punctuation, null for neutral characters.
  function classify(ch) {
    if (HAN_RE.test(ch)) return { lang: 'zh', letter: true };
    if (LATIN_RE.test(ch) || FULL_LETTER_RE.test(ch)) return { lang: 'en', letter: true };
    if (CJK_PUNCT_RE.test(ch) && !FULL_ALNUM_RE.test(ch)) return { lang: 'zh', letter: false };
    return { lang: null, letter: false };
  }

  function toHalfWidth(text) {
    return text.replace(FULL_ALNUM_RE, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  }

  function rawSegments(text) {
    const segs = [];
    for (let i = 0; i < text.length; i += 1) {
      const { lang, letter } = classify(text[i]);
      const cur = segs[segs.length - 1];
      if (cur && (lang === null || cur.lang === null || cur.lang === lang)) {
        segs[segs.length - 1] = { ...cur, end: i + 1, lang: cur.lang || lang, letter: cur.letter || letter };
      } else {
        segs.push({ lang, start: i, end: i + 1, letter });
      }
    }
    return segs;
  }

  // Punctuation-only segments join a neighbour; then same-language neighbours coalesce.
  function mergeSegments(segs) {
    const merged = [];
    let carry = null;
    for (const seg of segs) {
      const s = carry ? { ...seg, start: carry.start } : seg;
      carry = null;
      const prev = merged[merged.length - 1];
      if (!s.letter && prev) merged[merged.length - 1] = { ...prev, end: s.end };
      else if (!s.letter) carry = s;
      else if (prev && prev.lang === s.lang) merged[merged.length - 1] = { ...prev, end: s.end };
      else merged.push(s);
    }
    if (carry) merged.push({ ...carry, lang: null });
    return merged;
  }

  function splitByLang(text, defaultLang = 'en') {
    const source = String(text == null ? '' : text);
    return mergeSegments(rawSegments(source)).map((seg) => {
      const slice = source.slice(seg.start, seg.end);
      const lead = slice.length - slice.trimStart().length;
      return { lang: seg.lang || defaultLang, text: toHalfWidth(slice.trim()), start: seg.start + lead };
    }).filter((seg) => seg.text !== '');
  }

  function isBoundary(text, match, end) {
    const after = text.slice(end);
    if (HALF_TERMINATOR_RE.test(match[0]) && after !== '' && !/^\s/.test(after)) return false;
    const next = after.trimStart().charAt(0);
    if (/[a-z]/.test(next)) return false;
    if (match[0] === '.' && ABBREVIATION_RE.test(text.slice(0, match.index))) return false;
    return true;
  }

  function splitSentences(text) {
    const source = String(text == null ? '' : text);
    const out = [];
    const push = (from, to) => {
      const slice = source.slice(from, to);
      const lead = slice.length - slice.trimStart().length;
      if (slice.trim()) out.push({ text: slice.trim(), start: from + lead });
    };
    let cursor = 0;
    for (const match of source.matchAll(TERMINATOR_RE)) {
      const end = match.index + match[0].length;
      if (!isBoundary(source, match, end)) continue;
      push(cursor, end);
      cursor = end;
    }
    push(cursor, source.length);
    return out;
  }

  function displayText(section, item) {
    if (section.type === 'phonics') return parser.stripPhonics(item.text);
    if (section.type === 'dialogue' || section.type === 'picture') return item.lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
    return item.text;
  }

  // Spoken chunks of one item: { text, offset, enRole } with a gap kind between chunks.
  function itemChunks(section, item) {
    if (section.type === 'dialogue' || section.type === 'picture') {
      let offset = 0;
      const chunks = item.lines.map((line) => {
        const chunk = { text: line.text, offset: offset + line.speaker.length + 2, enRole: line.speaker === 'B' ? 'enB' : 'en' };
        offset += line.speaker.length + 2 + line.text.length + 1;
        return chunk;
      });
      return { chunks, gapKind: 'line-gap', gapKey: 'dialogueLineGapSec' };
    }
    if (section.type === 'passage') {
      const chunks = splitSentences(item.text).map((s) => ({ text: s.text, offset: s.start, enRole: 'en' }));
      return { chunks, gapKind: 'sentence-gap', gapKey: 'passageSentenceGapSec' };
    }
    return { chunks: [{ text: displayText(section, item), offset: 0, enRole: 'en' }], gapKind: null, gapKey: null };
  }

  function buildTimeline(exam, settings) {
    const steps = [];
    const wait = (kind, sec, ref) => { if (sec > 0) steps.push({ type: 'wait', kind, sec, ref: { ...ref } }); };
    const say = (kind, text, ref, opts) => {
      for (const seg of splitByLang(text, opts.defaultLang)) {
        const span = opts.offset === undefined ? null : [opts.offset + seg.start, opts.offset + seg.start + seg.text.length];
        const voiceRole = seg.lang === 'zh' ? 'zh' : opts.enRole;
        steps.push({ type: 'speak', kind, text: seg.text, lang: seg.lang, voiceRole, ref: { ...ref }, span });
      }
    };

    const sections = exam.sections
      .map((section, index) => ({ section, index }))
      .filter(({ section }) => section.items.length > 0);

    // Exam title and description come first, each followed by the title gap; section null marks them.
    if (sections.length) {
      const ref = { section: null, item: null, pass: null };
      const intro = [];
      if (settings.announceExamTitle && isText(exam.title)) intro.push(['exam-title', exam.title]);
      if (settings.announceExamDescription && isText(exam.description)) intro.push(['exam-description', exam.description]);
      intro.forEach(([kind, text]) => {
        say(kind, text, ref, { defaultLang: 'zh', enRole: 'en' });
        wait('exam-intro-gap', settings.sectionTitleGapSec, ref);
      });
    }

    sections.forEach(({ section, index: si }, k) => {
      const cfg = schema.sectionSettings(settings, section);
      if (cfg.announceSection !== 'none') {
        const ref = { section: si, item: null, pass: null };
        const title = section.titleEn ? `Part ${section.id}. ${section.titleEn}` : `Part ${section.id}.`;
        say('section-title', title, ref, { defaultLang: 'en', enRole: 'en' });
        if (cfg.announceSection === 'en+zh') say('section-title', section.titleZh, ref, { defaultLang: 'zh', enRole: 'en' });
        wait('section-title-gap', cfg.sectionTitleGapSec, ref);
      }
      section.items.forEach((item, ii) => {
        const { chunks, gapKind, gapKey } = itemChunks(section, item);
        const first = { section: si, item: ii, pass: 0 };
        if (cfg.announceNumber) {
          say('number', cfg.numberTemplate.replace(/\{n\}/g, String(ii + 1)), first, { defaultLang: 'en', enRole: 'en' });
          if (section.type !== 'picture') wait('number-gap', cfg.numberGapSec, first);
        }
        // Students look at the picture before the dialogue starts, with or without a spoken number.
        if (section.type === 'picture') wait('look-gap', cfg.pictureLookSec, first);
        for (let pass = 0; pass < cfg.repeat; pass += 1) {
          const ref = { section: si, item: ii, pass };
          if (pass > 0) wait('repeat-gap', cfg.repeatGapSec, { ...ref, pass: pass - 1 });
          chunks.forEach((chunk, ci) => {
            if (ci > 0) wait(gapKind, cfg[gapKey], ref);
            say('content', chunk.text, ref, { defaultLang: 'en', enRole: chunk.enRole, offset: chunk.offset });
          });
        }
        const last = { section: si, item: ii, pass: cfg.repeat - 1 };
        if (ii < section.items.length - 1) wait('item-gap', cfg.itemGapSec, last);
        else if (k < sections.length - 1) wait('section-gap', cfg.sectionGapSec, last);
      });
    });
    return steps;
  }

  // First step index of every item; the first item of a section starts at its title,
  // and the first item of the exam also takes the exam title / description before it.
  function itemStarts(steps) {
    const starts = [];
    const seen = new Set();
    const titleAt = new Map();
    steps.forEach((step, index) => {
      const { section, item } = step.ref;
      if (step.kind === 'section-title' && !titleAt.has(section)) titleAt.set(section, index);
      if (item === null || seen.has(`${section}:${item}`)) return;
      seen.add(`${section}:${item}`);
      const start = item === 0 && titleAt.has(section) ? titleAt.get(section) : index;
      starts.push({ section, item, index: start });
    });
    if (starts.length && steps[0].ref.section === null) starts[0] = { ...starts[0], index: 0 };
    return starts;
  }

  const api = { splitByLang, splitSentences, displayText, buildTimeline, itemStarts };
  root.ListenUpQuiz = root.ListenUpQuiz || {};
  root.ListenUpQuiz.timeline = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
