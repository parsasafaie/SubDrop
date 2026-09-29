/* Fetches caption files cross-origin — the page itself cannot, because caption
   hosts send no CORS headers — and turns HLS subtitle playlists into one cue list. */
(function () {
  'use strict';

  var P = globalThis.FaSubParser;

  function absolute(url, base) {
    try { return new URL(url, base).href; } catch (e) { return url; }
  }

  function isPlaylist(text) {
    return /^\s*#EXTM3U/.test(text || '');
  }

  // Segment URIs, each with the EXTINF duration that precedes it.
  function playlistSegments(text, base) {
    var out = [], dur = null;
    text.split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var m = /^#EXTINF:([\d.]+)/.exec(line);
      if (m) { dur = parseFloat(m[1]); return; }
      if (line.charAt(0) !== '#') {
        out.push({ url: absolute(line, base), duration: dur || 0 });
        dur = null;
      }
    });
    return out;
  }

  var TS_CLOCK = 90000;        // ticks per second on the MPEG-TS clock
  var TS_WRAP = 8589934592;    // the 33-bit TS clock wraps at 2^33
  var SEG_LIMIT = 5000;        // hard bound on how many segments get fetched
  var CONCURRENT = 8;          // segments fetched at the same time
  var FETCH_MS = 20000;        // one fetch may not hang the whole extraction

  // "X-TIMESTAMP-MAP:LOCAL:00:00:00.000,MPEGTS:900000" in a segment's WebVTT
  // header: the MPEG-TS instant that the segment's LOCAL time zero maps to.
  function segmentMap(text) {
    var lines = (text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length && i < 15; i++) {
      var m = /^\s*#EXT-X-TIMESTAMP-MAP:LOCAL:([^,]+),MPEGTS:(\d+)/i.exec(lines[i]);
      if (m) {
        var local = P.parseTimestamp(m[1]);
        if (local !== null) return { local: local, mpegts: parseInt(m[2], 10) };
      }
    }
    return null;
  }

  function fetchText(url) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, FETCH_MS);
    return fetch(url, { signal: ctrl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(
        function (t) { clearTimeout(timer); return t; },
        function (e) {
          clearTimeout(timer);
          throw e && e.name === 'AbortError' ? new Error('timed out') : e;
        }
      );
  }

  // Fetch every segment through a small pool, keeping results in playlist order.
  function fetchSegments(segs) {
    var texts = new Array(segs.length);
    var next = 0;
    function worker() {
      if (next >= segs.length) return Promise.resolve();
      var i = next++;
      return fetchText(segs[i].url).then(function (t) {
        texts[i] = t;
      }).then(worker);
    }
    var pool = [];
    for (var i = 0; i < CONCURRENT && i < segs.length; i++) pool.push(worker());
    return Promise.all(pool).then(function () { return texts; });
  }

  // Stitch fetched segments into one cue list. A segment's local timestamps
  // either restart near zero (the common HLS encoding) and need that segment's
  // position in the playlist, or are already absolute and must not be shifted.
  // When every segment carries X-TIMESTAMP-MAP, the MPEG-TS clock decides
  // exactly. Otherwise the stream votes once: a segment whose first cue starts
  // well before its playlist slot is restart-encoded. Voting per stream — not
  // per segment — keeps sparse dialogue and varying EXTINF durations from
  // flipping the decision for any single segment.
  function stitch(segs, texts, truncated) {
    var maps = [], parsed = [], slots = [];
    var allMapped = texts.length > 0, slot = 0;
    for (var i = 0; i < segs.length; i++) {
      slots.push(slot);
      slot += segs[i].duration || 0;
      var m = allMapped ? segmentMap(texts[i]) : null;
      maps.push(m);
      if (!m) allMapped = false;
      parsed.push(P.parse(texts[i] || '', 0));
    }

    var restarts = false, tsBase = null;
    if (!allMapped) {
      var votes = 0, voted = 0;
      for (var k = 1; k < segs.length; k++) {
        if (!parsed[k].length) continue;
        voted++;
        if (parsed[k][0].start < slots[k] - 0.25) votes++;
      }
      restarts = voted > 0 && votes * 2 > voted;
    }

    var cues = [];
    for (var k = 0; k < segs.length; k++) {
      var shift;
      if (allMapped) {
        if (tsBase === null) tsBase = maps[k].mpegts;
        var d = maps[k].mpegts - tsBase;
        if (d < 0) d += TS_WRAP;
        shift = d / TS_CLOCK - maps[k].local;
      } else {
        shift = restarts ? slots[k] : 0;
      }
      for (var c = 0; c < parsed[k].length; c++) {
        cues.push({
          start: parsed[k][c].start + shift,
          end: parsed[k][c].end + shift,
          text: parsed[k][c].text
        });
      }
    }
    return {
      cues: cues,
      warning: truncated ? 'playlist truncated to the first ' + SEG_LIMIT + ' segments' : null
    };
  }

  // A plain .vtt/.srt comes back as one cue list; an .m3u8 has its segments
  // fetched in order and stitched.
  function buildCues(url) {
    return fetchText(url).then(function (head) {
      if (!isPlaylist(head)) return { cues: P.parse(head, 0), warning: null };

      var segs = playlistSegments(head, url);
      if (!segs.length) throw new Error('playlist has no subtitle segments');
      var truncated = segs.length > SEG_LIMIT;
      if (truncated) segs = segs.slice(0, SEG_LIMIT);

      return fetchSegments(segs).then(function (texts) {
        return stitch(segs, texts, truncated);
      });
    });
  }

  browser.runtime.onMessage.addListener(function (msg, sender) {
    // Content scripts ask which site their tab counts as: the per-site stores
    // are keyed by the tab's origin, which a frame of a cross-origin iframe
    // cannot see from its own location.
    if (msg && msg.type === 'getSiteKey') {
      var t = sender && sender.tab;
      return Promise.resolve({ key: t ? P.siteKeyOfUrl(t.url || '') : null });
    }

    if (!msg || msg.type !== 'fetchCaptions' || !/^https?:/i.test(msg.url || '')) return undefined;

    return buildCues(msg.url).then(function (r) {
      r.cues.sort(function (a, b) { return a.start - b.start; });
      if (!r.cues.length) return { ok: false, error: 'no cue lines in that file' };
      var out = { ok: true, cueCount: r.cues.length, cues: r.cues };
      if (r.warning) out.warning = r.warning;
      return out;
    }, function (e) {
      return { ok: false, error: String(e && e.message || e) };
    });
  });
})();
