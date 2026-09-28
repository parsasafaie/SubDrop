'use strict';

// Small window the popup opens to pick a subtitle file. A browser-action popup is
// torn down by Firefox the moment its native file dialog opens, so the picker has
// to live somewhere that survives — this window does. The file is decoded here and
// written straight into the per-site store; the page picks it up from storage.

var P = globalThis.FaSubParser;

var siteKey = '';
try { siteKey = decodeURIComponent(location.hash.slice(1) || ''); } catch (e) { siteKey = ''; }

var fileEl = document.getElementById('file');
var zoneEl = document.getElementById('zone');
var nameEl = document.getElementById('name');
var errEl = document.getElementById('err');

function showError(msg) {
  errEl.textContent = msg;
  errEl.hidden = false;
}

function clearError() {
  errEl.hidden = true;
}

// A window opened with browser.windows.create() is closed through the API, not
// window.close() — that one only closes script-opened tabs.
function closeSelf() {
  try {
    browser.windows.getCurrent().then(function (w) {
      return browser.windows.remove(w.id);
    }).catch(function () { try { window.close(); } catch (e) { } });
  } catch (e) {
    try { window.close(); } catch (e2) { }
  }
}

function load(file) {
  var name = file.name || 'file';
  var m = /\.([a-z0-9]+)$/i.exec(name);
  var ext = m ? m[1].toLowerCase() : '';
  if (ext !== 'srt' && ext !== 'vtt') {
    return showError(name + ' is not a subtitle file — use .srt or .vtt');
  }
  if (!file.size) return showError(name + ' is empty');
  if (!siteKey) return showError('No target site — reopen the picker from the popup.');

  clearError();
  nameEl.textContent = 'Reading ' + name + '…';
  nameEl.className = 'name';

  file.arrayBuffer()
    .then(function (buf) { return P.decode(buf); })
    .then(function (text) {
      if (!P.parse(text).length) throw new Error('no subtitles found in ' + name);
      return browser.storage.local.get('sites').then(function (r) {
        var sites = (r && r.sites) || {};
        sites[siteKey] = { name: name, text: text, ts: Date.now() };
        return browser.storage.local.set({ sites: sites });
      });
    })
    .then(function () {
      nameEl.textContent = name + ' loaded — the video page has it now.';
      nameEl.className = 'name set';
      setTimeout(closeSelf, 900);
    })
    .catch(function (e) {
      nameEl.textContent = '';
      showError(String(e && e.message || e));
    });
}

// Clear the value before handling the file, so choosing the same file again still
// raises a change event instead of silently doing nothing.
fileEl.addEventListener('change', function () {
  var f = fileEl.files && fileEl.files[0];
  fileEl.value = '';
  if (f) load(f);
});

var stop = function (e) { e.preventDefault(); e.stopPropagation(); };
['dragenter', 'dragover'].forEach(function (n) {
  document.body.addEventListener(n, function (e) {
    stop(e);
    e.dataTransfer.dropEffect = 'copy';
    zoneEl.classList.add('over');
  });
});
['dragleave', 'dragend'].forEach(function (n) {
  document.body.addEventListener(n, function () { zoneEl.classList.remove('over'); });
});
document.body.addEventListener('drop', function (e) {
  stop(e);
  zoneEl.classList.remove('over');
  var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) load(f);
  else showError('that was not a file — drop a .srt or .vtt');
});
