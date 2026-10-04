// Textarea <-> section items (parse / serialize). Round-trip safe for valid data.
(function (root) {
  'use strict';

  const TYPES = ['words', 'phonics', 'dialogue', 'picture', 'sentences', 'passage'];
  const SPEAKER_RE = /^([AB])\s*[:：]\s*(.*)$/;
  // A second "A:" / "B:" on the same line, as printed on paper: "A：…  B：…".
  const INLINE_SPEAKER_RE = /[\s　]+(?=[AB]\s*[:：])/;
  const PHONICS_EXAMPLE = '例如 [d]og';

  function checkType(type) {
    if (!TYPES.includes(type)) throw new Error(`unknown section type: ${type}`);
  }

  function splitLines(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  }

  function lineError(line, text, reason) {
    return { kind: 'error', line, text, message: `第 ${line} 行：${reason}` };
  }

  // Scan "[d]og" into parts; returns { parts, error } where error is a reason or ''.
  function scanPhonics(text) {
    const parts = [];
    let buf = '';
    let inside = false;
    let groups = 0;
    for (const ch of text) {
      if (ch === '[') {
        if (inside) return { parts: null, error: '[ ] 不能放在另一組 [ ] 裡面' };
        if (buf) parts.push({ text: buf, underline: false });
        buf = '';
        inside = true;
      } else if (ch === ']') {
        if (!inside) return { parts: null, error: `] 前面沒有 [，${PHONICS_EXAMPLE}` };
        if (!buf) return { parts: null, error: `[ ] 裡面不能是空的，${PHONICS_EXAMPLE}` };
        parts.push({ text: buf, underline: true });
        buf = '';
        inside = false;
        groups += 1;
      } else {
        buf += ch;
      }
    }
    if (inside) return { parts: null, error: `[ 沒有對應的 ]，${PHONICS_EXAMPLE}` };
    if (buf) parts.push({ text: buf, underline: false });
    if (!groups) return { parts, error: `要用 [ ] 標出底線字母，${PHONICS_EXAMPLE}` };
    return { parts, error: '' };
  }

  function phonicsParts(text) {
    const { parts } = scanPhonics(text);
    return parts || [{ text, underline: false }];
  }

  function stripPhonics(text) {
    return String(text).replace(/[[\]]/g, '');
  }

  function finish(entries) {
    const sorted = [...entries].sort((a, b) => a.line - b.line);
    let index = 0;
    const withIndex = sorted.map((e) => (e.kind === 'item' ? { ...e, index: index++ } : e));
    return {
      items: withIndex.filter((e) => e.kind === 'item').map((e) => e.item),
      errors: withIndex.filter((e) => e.kind === 'error').map(({ line, text, message }) => ({ line, text, message })),
      entries: withIndex.map((e) => (e.kind === 'item'
        ? { kind: 'item', index: e.index, item: e.item, line: e.line }
        : { kind: 'error', line: e.line, text: e.text, message: e.message })),
    };
  }

  function parseLines(type, lines) {
    const entries = [];
    lines.forEach((raw, i) => {
      const text = raw.trim();
      if (!text) return;
      if (type === 'phonics') {
        const { error } = scanPhonics(text);
        if (error) { entries.push(lineError(i + 1, text, error)); return; }
      }
      entries.push({ kind: 'item', item: { text }, line: i + 1 });
    });
    return entries;
  }

  // Parse one physical line into dialogue lines, or return an error reason.
  function parseDialogueLine(text) {
    const pieces = text.split(INLINE_SPEAKER_RE);
    const out = [];
    for (const piece of pieces) {
      const m = piece.match(SPEAKER_RE);
      if (!m) return { error: '開頭要是 A: 或 B:（半形、全形冒號都可以）' };
      const said = m[2].trim();
      if (!said) return { error: `${m[1]}: 後面沒有台詞` };
      out.push({ speaker: m[1], text: said });
    }
    return { lines: out };
  }

  function parseDialogue(lines) {
    const entries = [];
    let block = null;
    const close = () => {
      if (block && block.lines.length) entries.push({ kind: 'item', item: { lines: block.lines }, line: block.line });
      block = null;
    };
    lines.forEach((raw, i) => {
      const text = raw.trim();
      if (!text) { close(); return; }
      if (!block) block = { lines: [], line: 0 };
      const parsed = parseDialogueLine(text);
      if (parsed.error) { entries.push(lineError(i + 1, text, parsed.error)); return; }
      if (!block.lines.length) block.line = i + 1;
      block.lines = [...block.lines, ...parsed.lines];
    });
    close();
    return entries;
  }

  function parsePassage(lines) {
    const text = lines.join('\n').trim();
    if (!text) return [];
    const first = lines.findIndex((l) => l.trim() !== '');
    return [{ kind: 'item', item: { text }, line: first + 1 }];
  }

  function parseSection(type, text) {
    checkType(type);
    const lines = splitLines(text);
    if (type === 'dialogue' || type === 'picture') return finish(parseDialogue(lines));
    if (type === 'passage') return finish(parsePassage(lines));
    return finish(parseLines(type, lines));
  }

  function serializeSection(type, items) {
    checkType(type);
    const list = items || [];
    if (type === 'dialogue' || type === 'picture') {
      return list.map((it) => it.lines.map((l) => `${l.speaker}: ${l.text}`).join('\n')).join('\n\n');
    }
    if (type === 'passage') return list.length ? list[0].text : '';
    return list.map((it) => it.text).join('\n');
  }

  const api = { TYPES, parseSection, serializeSection, phonicsParts, stripPhonics };
  root.ListenUpQuiz = root.ListenUpQuiz || {};
  root.ListenUpQuiz.parser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
