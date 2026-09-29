/* Minimal SRT / WebVTT parser + text decoding. Defines globalThis.FaSubParser. */
(function () {
  'use strict';

  // Subtitle files show up as UTF-8 (with or without BOM), UTF-16, and — for
  // Persian material from older sources — legacy Windows codepages. Decoding the
  // bytes ourselves keeps the text intact in all of them; guessing UTF-8 for a
  // legacy file is exactly what turns Persian into scrambled characters.
  function tryDecode(bytes, enc, fatal) {
    try {
      return new TextDecoder(enc, fatal ? { fatal: true } : undefined).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  function decode(arrayBuffer) {
    var b = new Uint8Array(arrayBuffer);
    if (b[0] === 0xFF && b[1] === 0xFE) return tryDecode(b.subarray(2), 'utf-16le') || '';
    if (b[0] === 0xFE && b[1] === 0xFF) return tryDecode(b.subarray(2), 'utf-16be') || '';
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return tryDecode(b.subarray(3), 'utf-8') || '';

    // No BOM. Strict UTF-8 first: ASCII-only and real UTF-8 both pass cleanly.
    var u8 = tryDecode(b, 'utf-8', true);
    if (u8 !== null) return u8;

    // Not valid UTF-8, so it must be a legacy codepage. 1256 is the Persian one.
    return tryDecode(b, 'windows-1256') ||
           tryDecode(b, 'windows-1252') || '';
  }

  // "HH:MM:SS,mmm" (SRT), "HH:MM:SS.mmm" / "MM:SS.mmm" (WebVTT) -> seconds.
  function parseTimestamp(raw) {
    var m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(String(raw).trim());
    if (!m) return null;
    var h = m[1] ? parseInt(m[1], 10) : 0;
    var min = parseInt(m[2], 10);
    var s = parseInt(m[3], 10);
    var ms = parseInt(m[4], 10) * (m[4].length === 2 ? 10 : m[4].length === 1 ? 100 : 1);
    return h * 3600 + min * 60 + s + ms / 1000;
  }

  function cleanText(s) {
    return s
      .replace(/<[^>]*>/g, '')          // <i>, <b>, <c.foo>, <v Speaker>, <00:00:01.000>
      .replace(/\{\\[^}]*\}/g, '')      // ASS override blocks that survive in .srt
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  // "00:01:02,000 --> 00:01:05,000 align:center position:50%" -> seconds, or
  // null when the line only looks like a timing line.
  function timingOf(line) {
    if (line.indexOf('-->') === -1) return null;
    var parts = line.split('-->');
    var start = parseTimestamp((parts[0] || '').trim().split(/\s+/)[0]);
    var end = parseTimestamp((parts[1] || '').trim().split(/\s+/)[0]);
    return start !== null && end !== null && end > start ? { start: start, end: end } : null;
  }

  // One cue = the line with "-->" plus everything up to the next cue start.
  // `offset` shifts every cue — used when stitching HLS subtitle segments together.
  function parseCue(lines, shift) {
    var arrowAt = -1, t = null;
    for (var j = 0; j < lines.length; j++) {
      var cand = timingOf(lines[j]);
      if (cand) { arrowAt = j; t = cand; break; }
    }
    if (arrowAt === -1) return null;

    var text = cleanText(lines.slice(arrowAt + 1).join(' '));
    if (!text) return null;
    return { start: t.start + shift, end: t.end + shift, text: text };
  }

  // A line begins the next cue — inside a block that already holds one — when it
  // is an SRT index with a timing line right under it, or a timing line itself.
  // Requiring parseable times keeps cue text that merely contains "-->" or a
  // bare number from splitting anything. This rescues files that leave out the
  // blank line between cues; without it such a file parses as one giant cue.
  function isCueStart(lines, j) {
    if (/^\d+\s*$/.test(lines[j])) {
      return j + 1 < lines.length && timingOf(lines[j + 1]) !== null;
    }
    return timingOf(lines[j]) !== null;
  }

  function parse(text, offset) {
    var cues = [];
    if (!text) return cues;
    var shift = offset || 0;

    text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    var blocks = text.split(/\n{2,}/);

    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n');
      // Well-formed files blank-line separate cues, so a block holds one; files
      // that omit the blank line are split further on cue starts.
      var starts = [0];
      for (var j = 1; j < lines.length; j++) {
        if (isCueStart(lines, j)) starts.push(j);
      }
      for (var s = 0; s < starts.length; s++) {
        var end = s + 1 < starts.length ? starts[s + 1] : lines.length;
        var cue = parseCue(lines.slice(starts[s], end), shift);
        if (cue) cues.push(cue);
      }
    }

    cues.sort(function (a, b) { return a.start - b.start; });
    return cues;
  }

  function srtTime(s) {
    var ms = Math.max(0, Math.round(s * 1000));
    var h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    var sec = Math.floor((ms % 60000) / 1000), mil = ms % 1000;
    function p(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
    return p(h, 2) + ':' + p(m, 2) + ':' + p(sec, 2) + ',' + p(mil, 3);
  }

  // Rebuild a loadable .srt from cues, so extracted text can be translated with AI
  // and fed straight back in without re-typing any timestamps.
  function toSrt(cues) {
    return cues.map(function (c, i) {
      return (i + 1) + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + c.text;
    }).join('\n\n');
  }

  // Every cue covering t (real subtitle files sometimes carry two at once —
  // dialogue plus a sound effect, or a dual-language pair). Binary search finds the
  // first cue that starts after t; only the handful before it can still be open,
  // so the scan stays bounded no matter how long the file is.
  function activeCues(cues, t, max) {
    var out = [];
    if (!cues.length) return out;
    var lo = 0, hi = cues.length - 1, at = cues.length;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) lo = mid + 1; else { at = mid; hi = mid - 1; }
    }
    var from = Math.max(0, at - 8);
    for (var i = at - 1; i >= from; i--) {
      if (cues[i].start <= t && t < cues[i].end) out.push(cues[i]);
    }
    out.reverse();                       // file order: earliest first
    return out.slice(0, max || 2);
  }

  // Index of the first cue covering t, or -1.
  function activeIndex(cues, t) {
    var a = activeCues(cues, t, 1);
    return a.length ? cues.indexOf(a[0]) : -1;
  }

  // Arabic/Persian: U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF
  function isRtl(s) {
    return /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(s);
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60);
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  // Identity of a site for the per-site stores: the origin, or — when the origin
  // is opaque (file:, sandboxed frames) — the URL minus its fragment. Shared by
  // the popup, the picker, the background and the content script so every
  // context keys the same page identically.
  function siteKeyOfUrl(raw) {
    var u = null;
    try { u = new URL(String(raw || '')); } catch (e) { u = null; }
    if (u && u.origin && u.origin !== 'null') return u.origin;
    return String(raw || '').split('#')[0];
  }

  globalThis.FaSubParser = {
    decode: decode,
    parse: parse,
    activeIndex: activeIndex,
    activeCues: activeCues,
    isRtl: isRtl,
    parseTimestamp: parseTimestamp,
    fmtTime: fmtTime,
    srtTime: srtTime,
    toSrt: toSrt,
    siteKeyOfUrl: siteKeyOfUrl
  };
})();
