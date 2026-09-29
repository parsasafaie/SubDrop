'use strict';

var P = globalThis.FaSubParser;

var pickEl = document.getElementById('pick');
var nameEl = document.getElementById('name');
var errEl = document.getElementById('err');
var extBoxEl = document.getElementById('extBox');
var langEl = document.getElementById('lang');
var capEl = document.getElementById('cap');
var capActions = document.getElementById('capActions');
var copySrtEl = document.getElementById('copySrt');
var copyTxtEl = document.getElementById('copyTxt');
var extractEl = document.getElementById('extract');
var langRowEl = document.getElementById('langRow');
var urlRowEl = document.getElementById('urlRow');
var capUrlEl = document.getElementById('capUrl');
var capGoEl = document.getElementById('capGo');
var toolsEl = document.getElementById('tools');
var offDownEl = document.getElementById('offDown');
var offUpEl = document.getElementById('offUp');
var offValEl = document.getElementById('offVal');
var forgetEl = document.getElementById('forget');

var tab = null;
var siteKey = '';   // which entry in the per-site store this page maps to
var localErr = '';  // error the popup caught itself, before the page ever saw it
var pollErr = false;  // the displayed error came from polling, so polling may clear it
var offset = 0;     // seconds for this site, mirrored into storage
var extLoaded = false;

// Firefox resolves with one response per frame when no frameId is given; Chrome
// resolves with a single one. Normalise both.
function sendToEveryFrame(msg) {
  return browser.tabs.sendMessage(tab.id, msg).then(function (res) {
    return Array.isArray(res) ? res : (res ? [res] : []);
  }).catch(function () {
    return [{ ok: false, error: 'this page cannot be reached' }];
  });
}

function showError(msg) {
  localErr = msg;
  errEl.textContent = msg;
  errEl.hidden = false;
}

function clearError() {
  localErr = '';
  errEl.hidden = true;
}

function setName(v) {
  if (v && v.source && v.cueCount) {
    nameEl.textContent = v.detail || v.source;
    nameEl.className = 'name set';
    nameEl.title = v.source;
    toolsEl.hidden = false;
  } else {
    nameEl.textContent = 'No subtitle selected';
    nameEl.className = 'name';
    nameEl.title = '';
    toolsEl.hidden = true;
  }
}

function paintOffset() {
  var sign = offset > 0 ? '+' : '';
  offValEl.textContent = sign + offset.toFixed(1) + ' s';
  offValEl.className = offset ? 'off nonzero' : 'off';
}

function saveOffset(value) {
  offset = Math.round(value * 10) / 10;
  paintOffset();
  storageGet('offsets').then(function (r) {
    var map = (r && r.offsets) || {};
    if (offset) map[siteKey] = offset; else delete map[siteKey];
    return storageSet({ offsets: map });
  }).catch(function () { /* storage unavailable: the nudge just will not persist */ });
}

// ------------------------------------------------------- per-site subtitle store
//
// The picker window writes the decoded file here, and the page picks it up on its
// own — the hand-off never depends on the popup staying alive.

function storageGet(key) {
  try { return browser.storage.local.get(key); } catch (e) { return Promise.reject(e); }
}
function storageSet(obj) {
  try { return browser.storage.local.set(obj); } catch (e) { return Promise.reject(e); }
}

// ------------------------------------------------------------------ picking
//
// The button opens a small picker window instead of hosting a file input, because
// Firefox tears a browser-action popup down the moment a native file dialog opens —
// a popup that owns the file can never finish reading it. The picker window is a
// real window, so its dialog and its read both survive; it writes the decoded file
// into the per-site store and the page loads it from there.

pickEl.addEventListener('click', function () {
  if (!siteKey) { showError('Open the popup on the video page first.'); return; }
  browser.windows.create({
    url: 'picker.html#' + encodeURIComponent(siteKey),
    type: 'popup',
    width: 340,
    height: 190
  }).then(function () {
    window.close();   // hand focus to the picker window
  }).catch(function (e) {
    showError('could not open the picker window');
  });
});

// ------------------------------------------------------------------ status

function poll() {
  if (!tab) return;
  sendToEveryFrame({ type: 'status' }).then(function (frames) {
    frames = frames.filter(Boolean);
    if (!frames.length) return;
    // The frame that owns the video wins; otherwise the one holding the cues.
    var v = frames.filter(function (f) { return f.hasVideo && f.cueCount; })[0] ||
            frames.filter(function (f) { return f.hasVideo; })[0] ||
            frames.filter(function (f) { return f.cueCount; })[0] ||
            frames[0];

    if (v.error) {
      pollErr = true;
      showError(v.error);
    } else if (pollErr) {
      pollErr = false;   // the polled error is stale: the page answered again
      clearError();
    } else if (localErr) {
      errEl.hidden = false;
    } else {
      clearError();
    }
    setName(v);
    if (typeof v.offset === 'number' && v.offset !== offset) { offset = v.offset; paintOffset(); }
  });
}

// ------------------------------------------------------------------ site tools

offDownEl.addEventListener('click', function () { saveOffset(offset - 0.1); });
offUpEl.addEventListener('click', function () { saveOffset(offset + 0.1); });
offValEl.addEventListener('click', function () { saveOffset(0); });

forgetEl.addEventListener('click', function () {
  storageGet(['sites', 'offsets']).then(function (r) {
    var patch = {};
    if (r && r.sites && r.sites[siteKey]) { var s = r.sites; delete s[siteKey]; patch.sites = s; }
    if (r && r.offsets && r.offsets[siteKey]) { var o = r.offsets; delete o[siteKey]; patch.offsets = o; }
    return Object.keys(patch).length ? storageSet(patch) : Promise.resolve();
  }).then(function () {
    offset = 0;
    paintOffset();
    return sendToEveryFrame({ type: 'clear' });
  }).then(poll).catch(function () { });
});

// ------------------------------------------------- extracting the page's captions
//
// Reads the caption tracks the page itself ships (DLAI serves one <track> per
// language), pulls their text through the background script, and hands it back as
// cues the user can copy. Translation is deliberately left to the user.

var tracks = [];
var cues = null;

function setCap(msg, cls) {
  capEl.textContent = msg;
  capEl.className = 'cap' + (cls ? ' ' + cls : '');
}

function extract(i) {
  var t = tracks[i];
  if (!t) return;
  cues = null;
  capActions.hidden = true;
  setCap('Fetching captions…');

  var job = (typeof t.inline === 'number')
    ? sendToEveryFrame({ type: 'inlineCues', index: t.inline }).then(function (res) {
        var good = res.filter(function (r) { return r && r.cueCount; })[0];
        return good ? { ok: true, cues: good.cues, cueCount: good.cueCount }
                    : { ok: false, error: 'that track has no cues' };
      })
    : browser.runtime.sendMessage({ type: 'fetchCaptions', url: t.src });

  job.then(function (r) {
    if (!r || !r.ok) { setCap((r && r.error) || 'could not fetch captions', 'bad'); return; }
    cues = r.cues;
    capActions.hidden = false;
    setCap(r.cueCount + (r.cueCount === 1 ? ' segment ready to copy' : ' segments ready to copy') +
      (r.warning ? ' — ' + r.warning : ''));
  }, function () {
    setCap('could not fetch captions', 'bad');
  });
}

function loadCaptions() {
  sendToEveryFrame({ type: 'listCaptions' }).then(function (res) {
    // Any frame with a video is enough to offer extraction; the ones advertising
    // caption tracks get preference.
    var f = res.filter(function (r) { return r && r.hasVideo; })[0];
    if (!f) {
      setCap('No video on this page.');
      langRowEl.hidden = true;
      urlRowEl.hidden = true;
      return;
    }

    urlRowEl.hidden = false;
    var found = (f.tracks || []).filter(function (t) { return t.src || typeof t.inline === 'number'; });
    tracks = found;

    if (found.length) {
      langRowEl.hidden = false;
      langEl.textContent = '';
      found.forEach(function (t, i) {
        var o = document.createElement('option');
        o.value = i;
        o.textContent = t.label || t.lang || ('track ' + (i + 1));
        langEl.appendChild(o);
      });
      langEl.hidden = found.length < 2;
      extract(0);                               // automatic: ready to copy on open
    } else {
      // The page advertises nothing. Players that build caption tracks in JS only
      // fill them once a track is enabled, so ask the page to try that once.
      langRowEl.hidden = true;
      setCap('Looking for caption tracks…');
      harvest();
    }
  });
}

var harvestTried = false;
function harvest() {
  if (harvestTried) return;
  harvestTried = true;
  sendToEveryFrame({ type: 'harvestCues', wait: 4000 }).then(function (res) {
    var good = res.filter(function (r) { return r && r.cueCount; })[0];
    if (!good) {
      setCap('No captions found on this page — you can fetch a caption file by URL below.');
      return;
    }
    cues = good.cues;
    capActions.hidden = false;
    setCap(good.cueCount + (good.cueCount === 1 ? ' segment found on the page' : ' segments found on the page'));
  });
}

function toClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
  }
  return Promise.resolve(false);
}

function copyWith(text, btn, label) {
  toClipboard(text).then(function (done) {
    if (!done) {
      // Browser-action popups occasionally refuse the async clipboard API.
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('style', 'position:fixed;left:-9999px;top:0;');
      document.body.appendChild(ta);
      ta.select();
      try { done = document.execCommand('copy'); } catch (e) { done = false; }
      ta.remove();
    }
    btn.textContent = done ? 'Copied!' : 'Copy failed';
    setTimeout(function () { btn.textContent = label; }, 1400);
  });
}

langEl.addEventListener('change', function () { extract(Number(langEl.value) || 0); });
extractEl.addEventListener('click', function () { extract(Number(langEl.value) || 0); });

// Fetch a caption file the page never advertised: the background script can read
// cross-origin hosts that block every page-side request.
capGoEl.addEventListener('click', function () {
  var url = (capUrlEl.value || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    setCap('Enter a http(s) URL to a .vtt, .srt or .m3u8 file.', 'bad');
    return;
  }
  cues = null;
  capActions.hidden = true;
  setCap('Fetching…');
  browser.runtime.sendMessage({ type: 'fetchCaptions', url: url }).then(function (r) {
    if (!r || !r.ok) { setCap((r && r.error) || 'could not fetch that URL', 'bad'); return; }
    cues = r.cues;
    capActions.hidden = false;
    setCap(r.cueCount + (r.cueCount === 1 ? ' segment ready to copy' : ' segments ready to copy') +
      (r.warning ? ' — ' + r.warning : ''));
  }, function () { setCap('could not fetch that URL', 'bad'); });
});
capUrlEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); capGoEl.click(); }
});

copySrtEl.addEventListener('click', function () {
  if (!cues) return;
  copyWith(P.toSrt(cues), copySrtEl, 'Copy SRT');
});
copyTxtEl.addEventListener('click', function () {
  if (!cues) return;
  copyWith(cues.map(function (c) { return c.text; }).join('\n'), copyTxtEl, 'Copy text');
});

// --------------------------------------------------------------- appearance
//
// Colour, size and font of the on-video subtitle line. Saved to storage; the
// content script picks the change up through storage.onChanged and repaints live.

var apColorEl = document.getElementById('apColor');
var apSizeEl = document.getElementById('apSize');
var apFontEl = document.getElementById('apFont');

var APPEARANCE_DEFAULTS = { color: 'white', size: 0, font: '' };

function paintAppearance(a) {
  [].forEach.call(apColorEl.querySelectorAll('button'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-v') === a.color);
  });
  apSizeEl.value = String(a.size);
  apFontEl.value = a.font;
}

function saveAppearance(patch) {
  var current = {
    color: (apColorEl.querySelector('button.on') || {}).getAttribute ?
             apColorEl.querySelector('button.on').getAttribute('data-v') : 'white',
    size: Number(apSizeEl.value) || 0,
    font: apFontEl.value
  };
  Object.assign(current, patch);
  try {
    browser.storage.local.set({ appearance: current });
  } catch (e) { /* storage unavailable: settings will not persist */ }
}

apColorEl.addEventListener('click', function (e) {
  var b = e.target.closest('button');
  if (!b) return;
  paintAppearance({ color: b.getAttribute('data-v'), size: Number(apSizeEl.value) || 0, font: apFontEl.value });
  saveAppearance({ color: b.getAttribute('data-v') });
});
apSizeEl.addEventListener('change', function () { saveAppearance({ size: Number(apSizeEl.value) || 0 }); });
apFontEl.addEventListener('change', function () { saveAppearance({ font: apFontEl.value }); });

try {
  browser.storage.local.get('appearance').then(function (r) {
    paintAppearance(Object.assign({}, APPEARANCE_DEFAULTS, (r && r.appearance) || {}));
  }).catch(function () { paintAppearance(APPEARANCE_DEFAULTS); });
} catch (e) { paintAppearance(APPEARANCE_DEFAULTS); }

browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
  tab = tabs[0];
  if (!tab) return;
  siteKey = P.siteKeyOfUrl(tab.url || '');
  poll();
  setInterval(poll, 500);
  // Extraction is lazy: nothing is fetched until the section is opened.
  extBoxEl.addEventListener('toggle', function () {
    if (extBoxEl.open && !extLoaded) { extLoaded = true; loadCaptions(); }
  });
  storageGet('offsets').then(function (r) {
    var o = r && r.offsets && r.offsets[siteKey];
    if (typeof o === 'number') { offset = o; paintOffset(); }
  }).catch(function () { });
}).catch(function () {
  showError('this page cannot be reached');
});
