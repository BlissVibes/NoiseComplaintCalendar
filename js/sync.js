/*
 * sync.js — "check Drive for new recordings" for the owner of the record.
 *
 * The site is static, so it cannot write data/incidents.json by itself. This
 * module does the half a browser can do: query the Drive folder, work out
 * which files are not in the calendar yet, show them immediately, and hand
 * back an updated incidents.json to commit.
 *
 * The API key is typed by the owner and kept in this browser's localStorage.
 * It is never written into the page source, so visitors to the public URL
 * never receive it and never see this panel do anything.
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'ncc.driveCredentials';
  var I = global.NCCIncidents;

  var hooks = null;   // { getRaw, applyRaw }
  var dom = {};
  var found = null;   // last scan result

  /* ---------------- credential storage (this browser only) ---------------- */

  function loadCreds() {
    try {
      var raw = global.localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveCreds(creds) {
    try {
      global.localStorage.setItem(STORE_KEY, JSON.stringify(creds));
    } catch (e) { /* private browsing; the scan still works this once */ }
  }

  function clearCreds() {
    try { global.localStorage.removeItem(STORE_KEY); } catch (e) {}
  }

  /* ---------------- panel ---------------- */

  function init(options) {
    hooks = options;
    dom.panel = document.getElementById('sync-panel');
    dom.button = document.getElementById('btn-sync');

    dom.button.addEventListener('click', toggle);
    render();
  }

  function toggle() {
    var open = dom.panel.hasAttribute('hidden');
    if (open) {
      dom.panel.removeAttribute('hidden');
      render();
      var first = dom.panel.querySelector('input');
      if (first) first.focus();
    } else {
      dom.panel.setAttribute('hidden', '');
    }
  }

  function close() {
    dom.panel.setAttribute('hidden', '');
  }

  function render() {
    var creds = loadCreds() || {
      folderId: global.NCC_CONFIG.driveFolderId || '',
      apiKey: global.NCC_CONFIG.driveApiKey || '',
    };

    dom.panel.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'sync-head';
    var title = document.createElement('h3');
    title.textContent = 'Check Drive for new recordings';
    head.appendChild(title);
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'icon-btn';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', close);
    head.appendChild(x);
    dom.panel.appendChild(head);

    var intro = document.createElement('p');
    intro.className = 'sync-intro';
    intro.textContent =
      'Scans the folder and lists anything not already on the calendar. ' +
      'Your API key stays in this browser — it is never part of the published ' +
      'page, so visitors cannot see or use it.';
    dom.panel.appendChild(intro);

    var form = document.createElement('form');
    form.className = 'sync-form';

    form.appendChild(field('Drive folder URL or ID', 'sync-folder', 'text',
      creds.folderId, 'https://drive.google.com/drive/folders/…'));
    form.appendChild(field('Drive API key', 'sync-key', 'password',
      creds.apiKey, 'AIza…'));

    var actions = document.createElement('div');
    actions.className = 'sync-actions';

    var scan = document.createElement('button');
    scan.type = 'submit';
    scan.className = 'btn btn-primary';
    scan.textContent = 'Scan folder';
    actions.appendChild(scan);

    if (loadCreds()) {
      var forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'link-btn';
      forget.textContent = 'Forget saved key';
      forget.addEventListener('click', function () {
        clearCreds();
        render();
      });
      actions.appendChild(forget);
    }

    form.appendChild(actions);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      scanNow(
        document.getElementById('sync-folder').value,
        document.getElementById('sync-key').value
      );
    });
    dom.panel.appendChild(form);

    dom.status = document.createElement('div');
    dom.status.className = 'sync-status';
    dom.panel.appendChild(dom.status);

    dom.results = document.createElement('div');
    dom.results.className = 'sync-results';
    dom.panel.appendChild(dom.results);
  }

  function field(labelText, id, type, value, placeholder) {
    var wrap = document.createElement('label');
    wrap.className = 'sync-field';
    var span = document.createElement('span');
    span.textContent = labelText;
    wrap.appendChild(span);
    var input = document.createElement('input');
    input.type = type;
    input.id = id;
    input.value = value || '';
    input.placeholder = placeholder || '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    wrap.appendChild(input);
    return wrap;
  }

  function status(text, kind) {
    dom.status.textContent = text || '';
    dom.status.className = 'sync-status' + (kind ? ' is-' + kind : '');
  }

  /* ---------------- the scan ---------------- */

  function scanNow(folderInput, apiKey) {
    var folderId = I.extractDriveId(folderInput) || String(folderInput || '').trim();
    apiKey = String(apiKey || '').trim();

    dom.results.innerHTML = '';
    found = null;

    if (!folderId || !apiKey) {
      status('Enter both the folder and the API key.', 'error');
      return;
    }

    status('Scanning Drive…', 'busy');

    global.NCCData.loadFromDrive(folderId, apiKey).then(function (result) {
      saveCreds({ folderId: folderId, apiKey: apiKey });

      var media = (result.files || []).filter(function (f) {
        return f.mimeType &&
          (f.mimeType.indexOf('video/') === 0 || f.mimeType.indexOf('image/') === 0);
      });

      var existing = hooks.getRaw() || [];
      var known = {};
      existing.forEach(function (f) {
        var id = f.id || I.extractDriveId(f.link || f.webViewLink || f.url);
        if (id) known[id] = true;
        if (f.name) known['name:' + f.name] = true;
      });

      var fresh = media.filter(function (f) {
        return !known[f.id] && !known['name:' + f.name];
      });

      found = { folderId: folderId, all: media, fresh: fresh };

      if (!media.length) {
        status('The folder is readable but contains no videos or images.', 'warn');
        return;
      }
      if (!fresh.length) {
        status('Up to date — all ' + media.length +
          ' recordings in the folder are already on the calendar.', 'ok');
        return;
      }

      status('Found ' + fresh.length + ' new recording' +
        (fresh.length === 1 ? '' : 's') + ' out of ' + media.length +
        ' in the folder.', 'ok');
      renderResults(fresh);
    }).catch(function (err) {
      status(explain(err), 'error');
    });
  }

  /* Drive's own errors are terse; say what actually needs fixing. */
  function explain(err) {
    var msg = String(err && err.message || err);
    var status = err && err.status;
    if (status === 400 || /API key not valid/i.test(msg)) {
      return 'That API key was rejected. Check it was copied in full, and that ' +
        'it belongs to a project with the Drive API enabled.';
    }
    if (status === 403 || /403/.test(msg) || /forbidden|blocked/i.test(msg)) {
      return 'Drive refused the key (403). Enable the Drive API for this key’s ' +
        'project, and if the key is restricted by referrer, allow this site.';
    }
    if (status === 404 || /404/.test(msg) || /not found/i.test(msg)) {
      return 'Folder not found (404). Check the folder ID, and that it is ' +
        'shared as “Anyone with the link → Viewer”.';
    }
    return msg;
  }

  function renderResults(fresh) {
    dom.results.innerHTML = '';

    var list = document.createElement('ul');
    list.className = 'sync-list';

    // Preview each new file with the date we would read from it, so a bad
    // filename is obvious before anything is committed.
    fresh.slice(0, 40).forEach(function (file) {
      var li = document.createElement('li');
      var resolved = global.NCCTimestamps.resolve(
        file, global.NCC_CONFIG.timestampPriority, global.NCC_CONFIG.recordTimeZone);

      var name = document.createElement('span');
      name.className = 'sync-file';
      name.textContent = file.name;
      li.appendChild(name);

      var when = document.createElement('span');
      if (resolved) {
        when.className = 'sync-when' +
          (resolved.confidence === 'low' ? ' is-weak' : '');
        when.textContent = resolved.raw +
          (resolved.confidence === 'low' ? '  (from Drive upload date)' : '');
      } else {
        when.className = 'sync-when is-weak';
        when.textContent = 'no usable date';
      }
      li.appendChild(when);
      list.appendChild(li);
    });

    if (fresh.length > 40) {
      var more = document.createElement('li');
      more.className = 'sync-more';
      more.textContent = '…and ' + (fresh.length - 40) + ' more';
      list.appendChild(more);
    }
    dom.results.appendChild(list);

    // The Drive API returns file listings, not what is inside the files. For a
    // recording whose real capture time lives in its QuickTime metadata (every
    // iPhone clip, since IMG_1234.MOV carries no date), the browser cannot
    // reach it, and the only date on offer is the Drive upload date. Plotting
    // that would put the incident on the day it was uploaded. So the merge and
    // download are offered only when every new file has a date we can actually
    // trust from its name alone.
    var trustworthy = fresh.every(function (file) {
      var r = global.NCCTimestamps.resolve(
        file, global.NCC_CONFIG.timestampPriority, global.NCC_CONFIG.recordTimeZone);
      return r && r.confidence === 'high';
    });

    var actions = document.createElement('div');
    actions.className = 'sync-actions';

    if (trustworthy) {
      var add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn btn-primary';
      add.textContent = 'Show on calendar now';
      add.addEventListener('click', function () {
        hooks.applyRaw(found.all);
        status('Showing the folder’s ' + found.all.length + ' recordings, ' +
          'jumped to the newest. This is temporary — reload and you are back ' +
          'to the committed data, so download the file below and commit it.',
          'ok');
        dom.results.innerHTML = '';
      });
      actions.appendChild(add);

      var dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'btn';
      dl.textContent = 'Download incidents.json';
      dl.addEventListener('click', download);
      actions.appendChild(dl);
      dom.results.appendChild(actions);

      var hint = document.createElement('p');
      hint.className = 'sync-hint';
      hint.textContent =
        'To make this permanent for everyone, put the downloaded file at ' +
        'data/incidents.json and commit it.';
      dom.results.appendChild(hint);
      return;
    }

    var warn = document.createElement('p');
    warn.className = 'sync-hint is-warn';
    warn.textContent =
      'These filenames carry no date, so their real capture time is inside ' +
      'the video files themselves and a browser cannot read it. Adding them ' +
      'from here would date them to when they were uploaded, not when they ' +
      'happened. Run this instead — it reads each file’s own recorded time ' +
      'and needs no API key:';
    dom.results.appendChild(warn);

    var code = document.createElement('code');
    code.className = 'sync-code';
    code.textContent = 'node tools/scan-drive-folder.mjs';
    dom.results.appendChild(code);

    var also = document.createElement('p');
    also.className = 'sync-hint';
    also.textContent =
      'Then commit data/incidents.json. The GitHub Action in this repo runs ' +
      'the same command for you — see the README.';
    dom.results.appendChild(also);
  }

  /* The download is byte-compatible with tools/fetch-drive-metadata.mjs. */
  function download() {
    if (!found) return;
    var payload = {
      generatedAt: new Date().toISOString(),
      folderId: found.folderId,
      files: found.all,
    };
    var blob = new Blob([JSON.stringify(payload, null, 2) + '\n'],
      { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'incidents.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  global.NCCSync = { init: init };
})(window);
