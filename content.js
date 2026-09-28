/* Overlay a subtitle file on the page's <video>, synced to video.currentTime. */
(function () {
  'use strict';

  var P = globalThis.FaSubParser;

  var state = {
    video: null,
    cues: [],
    activeIdx: -1,
    offset: 0,       // seconds the user nudged the subtitle by, for this site
    appliedTs: 0,    // timestamp of the last subtitle this frame applied
    overlay: null,
    textEl: null,
    picker: null,
    pickerDot: null,
    pickerText: null,
    pickerReady: false,
    lastSrc: '',
    lastDur: 0,
    lastRect: '',
    scanUntil: 0,
    scanTimer: 0,
    mutTimer: 0,
    raf: 0,
    sourceName: '',
    fileKey: '',     // identity of the file currently in state.cues
    badKey: '',      // identity of the file that last failed to load
    detail: '',
    error: ''
  };

  // ---------------------------------------------------------------- video
  //
  // Discovery is event-driven: one scan at boot, a slow retry window, a throttled
  // DOM observer — and nothing spins while none of those fire.

  // The first <video> in the DOM is often a hidden preview or an ad; the overlay
  // belongs on the largest one the user can actually see.
  function findVideo() {
    var best = null, bestArea = 0;
    function consider(v) {
      if (!v || v === state.video) return;
      var r = v.getBoundingClientRect();
      var onScreen = r.width > 20 && r.height > 20 && r.bottom > 0 && r.right > 0 &&
        r.top < (window.innerHeight || 0) && r.left < (window.innerWidth || 0);
      var area = onScreen ? r.width * r.height : 0;
      if (!best || area > bestArea) { best = v; bestArea = area; }
    }
    [].forEach.call(document.querySelectorAll('video'), consider);
    if (best) return best;
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length && i < 3000; i++) {
      if (all[i].shadowRoot) {
        var s = all[i].shadowRoot.querySelector('video');
        if (s) { consider(s); return best || s; }
      }
    }
    return best;
  }

  var videoEvents = ['play', 'pause', 'seeked', 'seeking', 'loadedmetadata', 'emptied', 'ratechange'];
  function bindVideo(v) {
    videoEvents.forEach(function (n) { v.addEventListener(n, requestUpdate); });
    if (typeof ResizeObserver !== 'undefined') {
      state.ro = new ResizeObserver(requestUpdate);
      state.ro.observe(v);
    }
  }
  function unbindVideo(v) {
    videoEvents.forEach(function (n) { v.removeEventListener(n, requestUpdate); });
    if (state.ro) { state.ro.disconnect(); state.ro = null; }
  }

  function attachVideo() {
    // Keep the video we already hold; re-scanning on every DOM change would churn
    // the overlay between players. Only look again if it went away.
    if (state.video && state.video.isConnected) return false;

    var v = findVideo();
    if (v && v !== state.video) {
      if (state.video) unbindVideo(state.video);
      state.video = v;
      state.lastSrc = v.currentSrc || v.src || '';
      state.lastDur = isFinite(v.duration) ? v.duration : 0;
      document.documentElement.setAttribute('data-fa-sub-video', '1');
      bindVideo(v);
      ensurePicker();      // only on pages that actually have a video
      ensureOverlay();
      restoreForSite();
      requestUpdate();
      return true;
    }
    if (!v && state.video) {   // the player went away
      unbindVideo(state.video);
      state.video = null;
      hideOverlay();
      paintPicker();
    }
    return false;
  }

  function scheduleScan() {
    if (state.scanTimer) return;
    state.scanTimer = setInterval(function () {
      if (state.video || Date.now() > state.scanUntil) {
        clearInterval(state.scanTimer);
        state.scanTimer = 0;
        return;
      }
      attachVideo();
    }, 750);
  }

  var observer = null;
  function watchDom() {
    if (observer || !window.MutationObserver) return;
    observer = new MutationObserver(function () {
      if (state.mutTimer) return;
      state.mutTimer = setTimeout(function () {
        state.mutTimer = 0;
        if (!state.video || !state.video.isConnected) attachVideo();
      }, 500);
    });
    observer.observe(document.documentElement || document, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------- overlay

  var CSS = [
    // Subtitles. position:fixed mirrors video.getBoundingClientRect(), so the
    // overlay shares the video's coordinate space and site CSS cannot shift it.
    // No caption box: readability comes from the outline, like modern players.
    '#__fa_sub_overlay__{position:fixed;z-index:2147483647;pointer-events:none;',
    'box-sizing:border-box;display:none;align-items:flex-end;justify-content:center;',
    'padding:0 5% 3.4% 5%;font-family:"Vazirmatn","Noto Naskh Arabic","Noto Sans Arabic",Tahoma,"DejaVu Sans",sans-serif;}',
    '#__fa_sub_overlay__>span{direction:rtl;unicode-bidi:isolate;text-align:center;',
    'color:#fff;line-height:1.6;font-weight:600;max-width:100%;white-space:pre-line;',
    'text-shadow:0 0 3px rgba(0,0,0,.9),0 0 8px rgba(0,0,0,.8),0 1px 3px rgba(0,0,0,.95),0 0 1px #000;}',

    // The on-page bar is a status chip only — the file dialog lives in the picker
    // window the popup opens. It still accepts a dropped file, which costs nothing
    // and is the fastest path when a file manager is already open.
    '#__fa_sub_picker__.drop{outline:2px solid #ffd400;outline-offset:3px;}'
  ].join('');

  function ensureStyle() {
    if (document.getElementById('__fa_sub_style__')) return;
    var st = document.createElement('style');
    st.id = '__fa_sub_style__';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function ensureOverlay() {
    ensureStyle();
    if (state.overlay) return;
    var ov = document.createElement('div');
    ov.id = '__fa_sub_overlay__';
    var sp = document.createElement('span');
    sp.dir = 'rtl';
    ov.appendChild(sp);

    (document.body || document.documentElement).appendChild(ov);

    state.overlay = ov;
    state.textEl = sp;
    applyAppearance();
  }

  function hideOverlay() {
    if (state.overlay) state.overlay.style.display = 'none';
    if (state.textEl) state.textEl.style.visibility = 'hidden';
  }

  // ---------------------------------------------------------------- loading

  // Single entry point for getting cues on screen. Never throws: a malformed file
  // has to leave the existing overlay alone and report a message, not break the page.
  // opts: { ts, restored } — ts deduplicates a storage write against the direct
  // message; restored marks a subtitle that came back from storage.
  function installCues(text, name, opts) {
    opts = opts || {};
    if (typeof opts.ts === 'number' && opts.ts <= state.appliedTs) {
      return { ok: true, cueCount: state.cues.length, source: state.sourceName, message: state.detail };
    }
    if (typeof opts.ts === 'number') state.appliedTs = opts.ts;

    var cues;
    try {
      cues = P.parse(text || '');
    } catch (e) {
      return fail((name || 'file') + ' could not be parsed');
    }
    if (!cues.length) return fail('no subtitles found in ' + (name || 'file'));

    state.cues = cues;
    state.activeIdx = -1;
    state.sourceName = name || '';
    state.error = '';
    state.detail = name + ' · ' + cues.length + (cues.length === 1 ? ' cue · 0:00–' : ' cues · 0:00–') +
      P.fmtTime(cues[cues.length - 1].end) + (opts.restored ? ' · restored' : '');

    attachVideo();
    if (state.video) ensureOverlay();
    requestUpdate();
    paintPicker();
    return {
      ok: true,
      cueCount: cues.length,
      source: state.sourceName,
      message: state.detail
    };
  }

  // Records a short message without disturbing whatever is already on screen.
  function fail(msg) {
    state.error = msg;
    state.detail = '';
    paintPicker();
    return { ok: false, error: msg, cueCount: state.cues.length };
  }

  // name + size + mtime: enough to recognise "the very same file" without hashing it.
  function keyOf(f) {
    return (f.name || '') + '|' + f.size + '|' + (f.lastModified || 0);
  }

  // ------------------------------------------------- remembering the last subtitle
  //
  // Subtitles are stored per site, so a reload or a return visit puts them back
  // without re-picking the file. The popup writes here too — which is what makes a
  // file chosen in the popup survive the popup being torn down mid-read.

  var MAX_SITES = 10;
  var MAX_TEXT = 1500000;

  function siteKey() {
    var o = location.origin;
    return o && o !== 'null' ? o : location.href.split('#')[0];
  }

  function storageGet(key) {
    try { return browser.storage.local.get(key); } catch (e) { return Promise.reject(e); }
  }
  function storageSet(obj) {
    try { return browser.storage.local.set(obj); } catch (e) { return Promise.reject(e); }
  }

  function persistSite(name, text, ts) {
    if (!text || text.length > MAX_TEXT) return Promise.resolve();
    return storageGet('sites').then(function (r) {
      var sites = (r && r.sites) || {};
      var keys = Object.keys(sites);
      if (!sites[siteKey()] && keys.length >= MAX_SITES) {
        keys.sort(function (a, b) { return (sites[a].ts || 0) - (sites[b].ts || 0); });
        delete sites[keys[0]];
      }
      sites[siteKey()] = { name: name, text: text, ts: ts };
      return storageSet({ sites: sites });
    }).catch(function () { /* storage unavailable: nothing to remember */ });
  }

  function restoreForSite() {
    if (state.cues.length) return;
    storageGet('sites').then(function (r) {
      var e = r && r.sites && r.sites[siteKey()];
      if (e && e.text && e.ts > state.appliedTs) installCues(e.text, e.name, { ts: e.ts, restored: true });
    }).catch(function () { /* nothing remembered */ });
  }

  function forgetSite() {
    state.appliedTs = Date.now() + 60000;   // ignore any in-flight storage echo
    return storageGet(['sites', 'offsets']).then(function (r) {
      var patch = {};
      if (r && r.sites && r.sites[siteKey()]) {
        var s = r.sites; delete s[siteKey()]; patch.sites = s;
      }
      if (r && r.offsets && r.offsets[siteKey()]) {
        var o = r.offsets; delete o[siteKey()]; patch.offsets = o;
      }
      state.offset = 0;
      return Object.keys(patch).length ? storageSet(patch) : Promise.resolve();
    }).catch(function () { });
  }

  function readFile(file) {
    if (!file) return Promise.resolve(fail('no file given'));

    var name = file.name || 'file';
    var m = /\.([a-z0-9]+)$/i.exec(name);
    var ext = m ? m[1].toLowerCase() : '';
    if (ext !== 'srt' && ext !== 'vtt') {
      return Promise.resolve(fail(name + ' is not a subtitle file — use .srt or .vtt'));
    }
    if (!file.size) return Promise.resolve(fail(name + ' is empty'));

    var key = keyOf(file);

    // Same file chosen again: it is already parsed, so reuse it instead of
    // re-reading and re-parsing identical bytes.
    if (key === state.fileKey && state.cues.length) {
      state.error = '';
      paintPicker();
      return Promise.resolve({
        ok: true, cached: true, cueCount: state.cues.length,
        source: state.sourceName, message: state.detail
      });
    }
    // Same file that already failed: do not run the failing parse again.
    if (key === state.badKey) {
      return Promise.resolve({ ok: false, error: state.error, cueCount: state.cues.length });
    }

    var ts = Date.now();
    return file.arrayBuffer()
      .then(function (buf) { return P.decode(buf); })
      .then(function (text) {
        var r = installCues(text, name, { ts: ts });
        if (r.ok) { state.fileKey = key; state.badKey = ''; persistSite(name, text, ts); }
        else state.badKey = key;
        return r;
      })
      .catch(function () {
        state.badKey = key;
        return fail('could not read ' + name);
      });
  }

  // ------------------------------------------------------- file picker (in page)
  //
  // A second way in, kept deliberately: the popup can be torn down by Firefox while
  // its native file dialog is open, and the page's own control is immune to that.

  var DOT = {
    ok:   { dot: '#3fb950', glow: 'rgba(63,185,80,.22)' },
    wait: { dot: '#58a6ff', glow: 'rgba(88,166,255,.22)' },
    bad:  { dot: '#f85149', glow: 'rgba(248,81,73,.24)' },
    off:  { dot: '#6e7681', glow: 'rgba(255,255,255,.09)' }
  };

  // -------------------------------------------------------------- appearance
  //
  // Text colour, size and typeface for the subtitle line. Kept in storage so they
  // survive reloads and apply to every tab; the popup edits them and this script
  // follows along through storage.onChanged.

  var APPEARANCE = { color: 'white', size: 0, font: '' };

  var FONTS = {
    '':           '"Vazirmatn","Noto Naskh Arabic","Noto Sans Arabic",Tahoma,"DejaVu Sans",sans-serif',
    'vazirmatn':  '"Vazirmatn","Noto Sans Arabic",Tahoma,sans-serif',
    'noto-sans':  '"Noto Sans Arabic","Vazirmatn",Tahoma,sans-serif',
    'noto-naskh': '"Noto Naskh Arabic","Vazirmatn",serif',
    'noto-kufi':  '"Noto Kufi Arabic","Noto Sans Arabic",sans-serif',
    'nastaliq':   '"Noto Nastaliq Urdu","Noto Naskh Arabic",serif',
    'tahoma':     'Tahoma,"Noto Sans Arabic",sans-serif',
    'dejavu':     '"DejaVu Sans","Noto Sans Arabic",sans-serif'
  };
  // Nastaliq and Naskh carry far taller glyphs than a Latin face expects.
  var LINE = { nastaliq: 2.4, 'noto-naskh': 1.9 };

  var GLOW = {
    white: '0 0 3px rgba(0,0,0,.9),0 0 8px rgba(0,0,0,.8),0 1px 3px rgba(0,0,0,.95),0 0 1px #000',
    black: '0 0 3px rgba(255,255,255,.95),0 0 8px rgba(255,255,255,.8),0 1px 3px rgba(255,255,255,.9)'
  };

  function applyAppearance() {
    if (!state.textEl) return;
    var el = state.textEl;
    el.style.color = APPEARANCE.color === 'black' ? '#000' : '#fff';
    el.style.textShadow = GLOW[APPEARANCE.color] || GLOW.white;
    el.style.fontFamily = FONTS[APPEARANCE.font] || FONTS[''];
    el.style.lineHeight = String(LINE[APPEARANCE.font] || 1.6);
  }

  function loadAppearance() {
    storageGet('appearance').then(function (r) {
      if (r && r.appearance) {
        APPEARANCE.color = r.appearance.color || 'white';
        APPEARANCE.size = Number(r.appearance.size) || 0;
        APPEARANCE.font = r.appearance.font || '';
        applyAppearance();
      }
    }).catch(function () { /* storage unavailable: keep the defaults */ });

    storageGet('offsets').then(function (r) {
      var o = r && r.offsets && r.offsets[siteKey()];
      if (typeof o === 'number') { state.offset = o; requestUpdate(); }
    }).catch(function () { });
  }

  try {
    browser.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;

      if (changes.appearance) {
        var a = changes.appearance.newValue || {};
        APPEARANCE.color = a.color || 'white';
        APPEARANCE.size = Number(a.size) || 0;
        APPEARANCE.font = a.font || '';
        applyAppearance();
        requestUpdate();   // the frame loop is idle while paused: repaint by hand
      }
      // A subtitle written by the popup lands here even if the popup was torn down
      // the moment its file dialog opened — this is the load path that cannot die.
      if (changes.sites) {
        var e = (changes.sites.newValue || {})[siteKey()];
        if (e && e.text && e.ts > state.appliedTs) installCues(e.text, e.name, { ts: e.ts });
      }
      if (changes.offsets) {
        var o = (changes.offsets.newValue || {})[siteKey()];
        var next = typeof o === 'number' ? o : 0;
        if (next !== state.offset) { state.offset = next; requestUpdate(); }
      }
    });
  } catch (e) { /* storage events unavailable: settings just will not sync live */ }

  function statusOf() {
    if (!state.video) return { key: 'no-video', text: 'Video not found', dot: DOT.bad };
    if (state.error) return { key: 'error', text: state.error, dot: DOT.bad };
    if (!state.cues.length) return { key: 'no-subtitle', text: 'No subtitle selected', dot: DOT.off };
    if (state.activeIdx >= 0) return { key: 'active', text: 'Subtitle active', dot: DOT.ok };
    return { key: 'loaded', text: 'Subtitle loaded', dot: DOT.wait };
  }

  function paintPicker() {
    if (!state.picker) return;
    var s = statusOf();
    state.pickerDot.style.background = s.dot.dot;
    state.pickerDot.style.boxShadow = '0 0 0 3px ' + s.dot.glow;
    state.pickerText.textContent = s.key === 'loaded' || s.key === 'active' ? state.detail : s.text;
    // The bar stays one line; hovering shows the whole message, and the popup
    // prints the full error in its own box.
    state.picker.title = s.text;
  }

  function ensurePicker() {
    if (state.pickerReady) return;
    state.pickerReady = true;
    ensureStyle();

    // One slim glass pill: status dot and the current file. Doubles as a drop target.
    var wrap = document.createElement('div');
    wrap.id = '__fa_sub_picker__';
    // all:initial stops the host page's CSS from restyling or hiding these.
    wrap.setAttribute('style',
      'all:initial;position:fixed;left:10px;bottom:10px;z-index:2147483647;' +
      'display:flex;align-items:center;gap:8px;box-sizing:border-box;' +
      'background:rgba(17,20,24,.72);color:#e6edf3;border:1px solid rgba(255,255,255,.10);' +
      'border-radius:999px;padding:6px 12px;' +
      'font:500 12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;direction:ltr;text-align:left;' +
      '-webkit-backdrop-filter:blur(16px) saturate(160%);backdrop-filter:blur(16px) saturate(160%);' +
      'box-shadow:0 8px 30px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.07);' +
      'max-width:min(92vw,340px);');

    var dot = document.createElement('i');
    dot.setAttribute('style',
      'all:initial;display:inline-block;width:7px;height:7px;flex:0 0 auto;border-radius:50%;' +
      'background:' + DOT.off.dot + ';box-shadow:0 0 0 3px ' + DOT.off.glow + ';');

    var text = document.createElement('s');
    // all:initial wipes inherited font properties, so the size is restated here —
    // otherwise the chip renders its text at the browser default 16px.
    text.setAttribute('style',
      'all:initial;display:block;flex:0 1 auto;min-width:0;font-style:normal;color:#cdd9e5;' +
      'font:500 12px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');

    // Drag & drop straight from the file manager: no file dialog at all.
    var stop = function (e) { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover'].forEach(function (n) {
      wrap.addEventListener(n, function (e) {
        stop(e);
        e.dataTransfer.dropEffect = 'copy';
        wrap.classList.add('drop');
      });
    });
    ['dragleave', 'dragend', 'drop'].forEach(function (n) {
      wrap.addEventListener(n, function () { wrap.classList.remove('drop'); });
    });
    wrap.addEventListener('drop', function (e) {
      stop(e);
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readFile(f);
      else fail('that was not a file — drop a .srt or .vtt');
    });

    wrap.appendChild(dot);
    wrap.appendChild(text);
    (document.body || document.documentElement).appendChild(wrap);

    state.picker = wrap;
    state.pickerDot = dot;
    state.pickerText = text;
    paintPicker();
  }

  // ---------------------------------------------------------------- fullscreen
  //
  // The overlay is a sibling of the video, and a fullscreen element is painted
  // alone in the top layer, so a sibling vanishes the moment the page goes
  // fullscreen. Move the overlay inside the fullscreen element and offset it
  // against that element instead of the viewport.

  function followFullscreen() {
    var fs = document.fullscreenElement;
    // A <video> cannot host visible children, so fall back to its parent there.
    var host = (fs && fs !== state.video) ? fs : (document.body || document.documentElement);
    if (state.overlay && state.overlay.parentNode !== host) {
      host.appendChild(state.overlay);
    }
    state.lastRect = '';   // the coordinate space changed: force a repaint
    requestUpdate();
  }
  document.addEventListener('fullscreenchange', followFullscreen);

  // Some players build their caption tracks in JavaScript and only fill them once a
  // track is enabled. Switching mode to 'hidden' asks the player for that data
  // without rendering anything on screen; afterwards the original modes are put
  // back exactly as they were.
  function harvestCues(waitMs) {
    var v = state.video;
    if (!v) return Promise.resolve({ ok: false, error: 'no video on this page' });

    var tracks = [], saved = [];
    for (var i = 0; i < v.textTracks.length; i++) {
      var t = v.textTracks[i];
      if (t.kind === 'subtitles' || t.kind === 'captions') { tracks.push(t); saved.push(t.mode); }
    }
    if (!tracks.length) {
      return Promise.resolve({ ok: false, error: 'this video has no caption tracks' });
    }

    var settled = false, timer = null, poll = null;
    var finish = function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);

      var cues = [];
      tracks.forEach(function (t) {
        if (!t.cues) return;
        for (var i = 0; i < t.cues.length; i++) {
          var c = t.cues[i];
          var txt = (c.text || '').replace(/<[^>]*>/g, '').trim();
          if (txt) cues.push({ start: c.startTime, end: c.endTime, text: txt });
        }
      });
      for (var j = 0; j < tracks.length; j++) tracks[j].mode = saved[j];

      cues.sort(function (a, b) { return a.start - b.start; });
      return {
        ok: cues.length > 0,
        cueCount: cues.length,
        cues: cues,
        error: cues.length ? null : 'the player did not expose any cues'
      };
    };

    tracks.forEach(function (t) { t.mode = 'hidden'; });
    return new Promise(function (resolve) {
      timer = setTimeout(function () { resolve(finish()); }, waitMs || 4000);
      poll = setInterval(function () {
        var n = 0;
        tracks.forEach(function (t) { if (t.cues) n += t.cues.length; });
        if (n) resolve(finish());
      }, 400);
    });
  }

  // ---------------------------------------------------------------- loop
  //
  // Driven by events, not by a permanent animation frame: nothing runs at all on a
  // page without a video, and on a paused video only the events that can change
  // what is on screen trigger a single repaint. The frame loop exists only while
  // the video is actually playing.

  function requestUpdate() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(tick);
  }

  function tick() {
    state.raf = 0;
    update();
    // Keep repainting only while there is something moving to paint.
    if (state.video && state.cues.length && !state.video.paused) {
      state.raf = requestAnimationFrame(tick);
    }
  }

  function update() {
    var v = state.video;
    if (!v) { hideOverlay(); return; }

    var src = v.currentSrc || v.src || '';
    var dur = isFinite(v.duration) ? v.duration : 0;
    if (src !== state.lastSrc || Math.abs(dur - state.lastDur) > 0.25) {
      state.lastSrc = src; state.lastDur = dur; state.activeIdx = -1;
    }

    var r = v.getBoundingClientRect();
    var visible = r.width > 40 && r.height > 40 &&
      r.bottom > 0 && r.right > 0 &&
      r.top < (window.innerHeight || document.documentElement.clientHeight) &&
      r.left < (window.innerWidth || document.documentElement.clientWidth);

    if (!visible) { hideOverlay(); return; }

    // Inside a fullscreen element the offset has to be relative to that element,
    // not the viewport, and position has to be absolute.
    var fs = document.fullscreenElement;
    var base = fs ? state.overlay.parentNode.getBoundingClientRect() : null;
    var left = fs ? r.left - base.left : r.left;
    var top = fs ? r.top - base.top : r.top;

    // Writing identical values still costs a style pass, and this runs per frame:
    // skip everything that has not changed.
    var sig = [left, top, r.width, r.height, fs ? 1 : 0].join(',');
    if (sig !== state.lastRect) {
      state.lastRect = sig;
      state.overlay.style.position = fs ? 'absolute' : 'fixed';
      state.overlay.style.left = left + 'px';
      state.overlay.style.top = top + 'px';
      state.overlay.style.width = r.width + 'px';
      state.overlay.style.height = r.height + 'px';
    }
    state.overlay.style.display = state.cues.length ? 'flex' : 'none';

    // A fixed size wins when the user set one; otherwise scale with the video.
    var size = APPEARANCE.size > 0
      ? APPEARANCE.size
      : Math.max(13, Math.min(r.height * 0.048, r.width * 0.032));
    var sizePx = size.toFixed(1) + 'px';
    if (state.textEl.style.fontSize !== sizePx) state.textEl.style.fontSize = sizePx;

    var t = v.currentTime + state.offset;
    var live = P.activeCues(state.cues, t, 2);
    var idx = live.length ? state.cues.indexOf(live[0]) : -1;
    if (idx !== state.activeIdx) {
      state.activeIdx = idx;
      paintPicker();
    }

    if (!live.length) {
      if (state.textEl.style.visibility !== 'hidden') {
        state.textEl.textContent = '';
        state.textEl.style.visibility = 'hidden';
      }
      return;
    }
    // Up to two simultaneous cues, each on its own line; the line's direction
    // follows the text (Latin stays LTR, Persian/Arabic flips to RTL).
    var text = live.map(function (c) { return c.text; }).join('\n');
    if (state.textEl.textContent !== text) state.textEl.textContent = text;
    var dir = P.isRtl(text) ? 'rtl' : 'ltr';
    if (state.textEl.dir !== dir) state.textEl.dir = dir;
    state.textEl.style.visibility = 'visible';
  }

  window.addEventListener('resize', requestUpdate, { passive: true });
  window.addEventListener('scroll', requestUpdate, { passive: true, capture: true });

  // ---------------------------------------------------------------- messages

  browser.runtime.onMessage.addListener(function (msg) {
    if (!msg || typeof msg !== 'object') return undefined;

    if (msg.type === 'status') {
      attachVideo();
      var v = state.video;
      var s = statusOf();
      var c = state.activeIdx >= 0 ? state.cues[state.activeIdx] : null;
      return Promise.resolve({
        kind: s.key,
        statusText: s.text,
        hasVideo: !!v,
        src: v ? (v.currentSrc || v.src || '') : '',
        size: v ? v.videoWidth + '×' + v.videoHeight : '',
        duration: v && isFinite(v.duration) ? v.duration : null,
        time: v ? v.currentTime : null,
        paused: v ? v.paused : null,
        source: state.sourceName,
        cueCount: state.cues.length,
        activeIdx: state.activeIdx,
        activeText: c ? c.text : '',
        activeStart: c ? c.start : null,
        activeEnd: c ? c.end : null,
        detail: state.detail,
        error: state.error,
        offset: state.offset
      });
    }

    // Caption tracks the page itself offers, for the popup's extract-and-copy flow.
    if (msg.type === 'listCaptions') {
      attachVideo();
      var vv = state.video;
      var tracks = [];
      if (vv) {
        var seen = {};
        var els = vv.getElementsByTagName('track');
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          var src = el.getAttribute('src') || '';
          if (!src) continue;
          var lang = el.getAttribute('srclang') || '';
          if (seen[lang + '|' + src]) continue;
          seen[lang + '|' + src] = 1;
          tracks.push({
            lang: lang,
            label: el.getAttribute('label') || lang || 'captions',
            src: new URL(src, location.href).href
          });
        }
        // Players that parse cues in-page instead of using <track src>.
        for (var j = 0; j < vv.textTracks.length; j++) {
          var t = vv.textTracks[j];
          if (t.cues && t.cues.length && !seen[(t.language || '') + '|inline']) {
            seen[(t.language || '') + '|inline'] = 1;
            tracks.push({ lang: t.language || '', label: t.label || t.language || 'captions', inline: j });
          }
        }
      }
      return Promise.resolve({ hasVideo: !!vv, tracks: tracks });
    }

    // Cue list for a track the page already parsed itself.
    if (msg.type === 'inlineCues') {
      var v2 = state.video;
      var tr = v2 && v2.textTracks[msg.index];
      var out = [];
      if (tr && tr.cues) {
        for (var q = 0; q < tr.cues.length; q++) {
          var c = tr.cues[q];
          out.push({ start: c.startTime, end: c.endTime, text: (c.text || '').replace(/<[^>]*>/g, '').trim() });
        }
      }
      out.sort(function (a, b) { return a.start - b.start; });
      return Promise.resolve({ ok: out.length > 0, cueCount: out.length, cues: out });
    }

    if (msg.type === 'harvestCues') {
      attachVideo();
      return Promise.resolve(harvestCues(msg.wait));
    }

    // Frames without a video say so, and do not bother parsing a file they could
    // never display.
    if (msg.type === 'load') {
      attachVideo();
      if (!state.video) return Promise.resolve({ ok: false, noVideo: true, cueCount: 0 });
      return Promise.resolve(installCues(msg.text || '', msg.name, { ts: msg.ts }));
    }

    if (msg.type === 'clear') {
      state.cues = []; state.activeIdx = -1; state.sourceName = '';
      state.fileKey = ''; state.badKey = ''; state.detail = ''; state.error = '';
      state.appliedTs = Date.now() + 60000;
      hideOverlay();
      paintPicker();
      return Promise.resolve({ ok: true, cueCount: 0 });
    }

    return undefined;
  });

  // ---------------------------------------------------------------- boot

  attachVideo();
  state.scanUntil = Date.now() + 60000;
  scheduleScan();
  watchDom();
  ensureOverlay();
  loadAppearance();
  restoreForSite();
  requestUpdate();
})();
