/*
 * data.js — the single seam through which incident data enters the app.
 *
 * Everything downstream consumes the array this returns, so swapping the
 * static file for a real API later means changing only this file.
 */
(function (global) {
  'use strict';

  var DRIVE_FIELDS =
    'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,' +
    'webViewLink,thumbnailLink,videoMediaMetadata,imageMediaMetadata)';

  /** Read the committed JSON snapshot. */
  function loadFromFile(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) {
        throw new Error('Could not read ' + url + ' (HTTP ' + res.status + ')');
      }
      return res.json();
    }).then(function (json) {
      // Accept either a bare array or { generatedAt, files: [...] }
      var files = Array.isArray(json) ? json : (json.files || json.incidents || []);
      return { files: files, source: 'file', generatedAt: json.generatedAt || null };
    });
  }

  /** Optional live mode: query the Drive API directly, paging through results. */
  function loadFromDrive(folderId, apiKey) {
    var files = [];

    function page(token) {
      var params = new URLSearchParams({
        q: "'" + folderId + "' in parents and trashed = false",
        key: apiKey,
        fields: DRIVE_FIELDS,
        pageSize: '1000',
        orderBy: 'createdTime',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (token) params.set('pageToken', token);

      return fetch('https://www.googleapis.com/drive/v3/files?' + params)
        .then(function (res) {
          return res.json().then(function (json) {
            if (!res.ok) {
              var msg = (json.error && json.error.message) || ('HTTP ' + res.status);
              var err = new Error('Google Drive: ' + msg);
              // Keep the status: callers translate it into what to actually fix.
              err.status = res.status;
              throw err;
            }
            return json;
          });
        })
        .then(function (json) {
          files = files.concat(json.files || []);
          if (json.nextPageToken) return page(json.nextPageToken);
          return { files: files, source: 'drive', generatedAt: new Date().toISOString() };
        });
    }

    return page(null);
  }

  /**
   * Load incidents using whichever source is configured.
   * Live Drive mode wins when credentials are present; otherwise the committed
   * snapshot is used. If the snapshot is missing we fall back to the bundled
   * demo data so the page still demonstrates itself.
   */
  function load(cfg) {
    var useDrive = cfg.driveFolderId && cfg.driveApiKey;
    var attempt = useDrive
      ? loadFromDrive(cfg.driveFolderId, cfg.driveApiKey)
      : loadFromFile(cfg.dataUrl);

    return attempt.catch(function (err) {
      if (useDrive) throw err;
      return loadFromFile('data/sample-incidents.json')
        .then(function (result) {
          result.source = 'sample';
          result.warning = err.message;
          return result;
        });
    });
  }

  global.NCCData = {
    load: load,
    loadFromFile: loadFromFile,
    loadFromDrive: loadFromDrive,
  };
})(window);
