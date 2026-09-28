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

  function fetchText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  // A plain .vtt/.srt comes back as one cue list; an .m3u8 has its segments
  // fetched in order and stitched.
  function buildCues(url) {
    return fetchText(url).then(function (head) {
      if (!isPlaylist(head)) return P.parse(head, 0);

      var segs = playlistSegments(head, url).slice(0, 80);
      if (!segs.length) throw new Error('playlist has no subtitle segments');

      var acc = 0, prevEnd = -1;
      var chain = Promise.resolve([]);
      segs.forEach(function (s) {
        var offset = acc;           // where this segment starts on the video
        acc += s.duration;
        chain = chain.then(function (all) {
          return fetchText(s.url).then(function (text) {
            // HLS local timestamps normally restart at 00:00 per segment, in which
            // case they need the playlist offset. Some hosts ship absolute times
            // instead — re-basing those would push cues past the end of the video,
            // so only shift a segment that overlaps the previous one.
            var local = P.parse(text, 0);
            var use = (all.length && local.length && local[0].start < prevEnd - 0.05)
              ? offset : 0;
            var cues = use ? P.parse(text, use) : local;
            if (cues.length) prevEnd = cues[cues.length - 1].end;
            return all.concat(cues);
          });
        });
      });
      return chain;
    });
  }

  browser.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'fetchCaptions' || !/^https?:/i.test(msg.url || '')) return undefined;

    return buildCues(msg.url).then(function (cues) {
      cues.sort(function (a, b) { return a.start - b.start; });
      if (!cues.length) return { ok: false, error: 'no cue lines in that file' };
      return { ok: true, cueCount: cues.length, cues: cues };
    }, function (e) {
      return { ok: false, error: String(e && e.message || e) };
    });
  });
})();
