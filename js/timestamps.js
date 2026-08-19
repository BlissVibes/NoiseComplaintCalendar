/*
 * timestamps.js — work out when an incident actually happened.
 *
 * Why this is more than a one-liner: uploading a video to Google Drive sets
 * that file's Drive "created" date to the *upload* time, not the time the
 * video was shot. If you record five nights of disturbances and upload them
 * all on Sunday, Drive reports five incidents on Sunday. That would make the
 * whole calendar wrong in exactly the way that matters.
 *
 * So we try sources in order of how trustworthy they are, and we always
 * record which one won so the UI can show it.
 */
(function (global) {
  'use strict';

  var MIN_YEAR = 2000;
  var MAX_YEAR = 2100;

  /* Named filename patterns, tried in order. Each returns a parts object.
   * Anchored loosely because real filenames carry prefixes and suffixes:
   *   PXL_20240512_221430123.mp4
   *   VID_20240512_221430.mp4
   *   20240512_221430.mp4
   *   2024-05-12 22.14.30.mov
   *   Ring_Front_Door_20240512_221430.mp4
   *   Screen Recording 2024-05-12 at 10.14.30 PM.mov
   */
  var PATTERNS = [
    {
      // ISO-ish date + 12-hour time with AM/PM, e.g. "2024-05-12 at 10.14.30 PM"
      name: 'iso-12h',
      re: /(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?:\s*(?:at|@)?\s*|[-_T])(\d{1,2})[-_.:](\d{2})(?:[-_.:](\d{2}))?\s*([AaPp])\.?[Mm]\.?/,
      map: function (m) {
        var hour = Number(m[4]) % 12;
        if (/[Pp]/.test(m[7])) hour += 12;
        return parts(m[1], m[2], m[3], hour, m[5], m[6]);
      },
    },
    {
      // ISO-ish date + 24-hour time, e.g. "20240512_221430", "2024-05-12T22-14-30"
      name: 'iso-24h',
      re: /(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})[-_.T\s]+(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})?/,
      map: function (m) {
        return parts(m[1], m[2], m[3], m[4], m[5], m[6]);
      },
    },
    {
      // Date only, e.g. "2024-05-12.mp4". Time is unknown -> flagged below.
      name: 'iso-date-only',
      re: /(\d{4})[-_.](\d{2})[-_.](\d{2})/,
      dateOnly: true,
      map: function (m) {
        return parts(m[1], m[2], m[3], 0, 0, 0);
      },
    },
    {
      // Compact date only, e.g. "IMG_20240512.jpg"
      name: 'compact-date-only',
      re: /(?:^|[^\d])(\d{4})(\d{2})(\d{2})(?:[^\d]|$)/,
      dateOnly: true,
      map: function (m) {
        return parts(m[1], m[2], m[3], 0, 0, 0);
      },
    },
  ];

  function parts(y, mo, d, h, mi, s) {
    return {
      year: Number(y),
      month: Number(mo),
      day: Number(d),
      hour: Number(h) || 0,
      minute: Number(mi) || 0,
      second: Number(s) || 0,
    };
  }

  function isPlausible(p) {
    return (
      p.year >= MIN_YEAR && p.year <= MAX_YEAR &&
      p.month >= 1 && p.month <= 12 &&
      p.day >= 1 && p.day <= 31 &&
      p.hour >= 0 && p.hour <= 23 &&
      p.minute >= 0 && p.minute <= 59 &&
      p.second >= 0 && p.second <= 59
    );
  }

  /* Build a local-time Date and confirm it did not roll over (e.g. Feb 31). */
  function toDate(p) {
    var d = new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (
      d.getFullYear() !== p.year ||
      d.getMonth() !== p.month - 1 ||
      d.getDate() !== p.day
    ) {
      return null;
    }
    return d;
  }

  /**
   * Pull a capture time out of a filename.
   * @returns {{date: Date, pattern: string, dateOnly: boolean}|null}
   */
  function fromFilename(name) {
    if (!name) return null;
    for (var i = 0; i < PATTERNS.length; i++) {
      var pat = PATTERNS[i];
      var m = pat.re.exec(name);
      if (!m) continue;
      var p = pat.map(m);
      if (!isPlausible(p)) continue;
      var date = toDate(p);
      if (!date) continue;
      return { date: date, pattern: pat.name, dateOnly: !!pat.dateOnly };
    }
    return null;
  }

  /* Drive returns EXIF capture time for images as "YYYY:MM:DD HH:MM:SS". */
  function fromMediaMetadata(file) {
    var raw = file &&
      file.imageMediaMetadata &&
      file.imageMediaMetadata.time;
    if (!raw) return null;
    var m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw);
    if (!m) return null;
    var p = parts(m[1], m[2], m[3], m[4], m[5], m[6]);
    if (!isPlausible(p)) return null;
    return toDate(p);
  }

  function fromISO(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  /* Human-readable provenance, surfaced in the UI next to each incident. */
  var SOURCE_INFO = {
    filename: {
      label: 'Filename',
      confidence: 'high',
      note: 'Capture time read from the recording’s own filename.',
    },
    'filename-dateonly': {
      label: 'Filename (date only)',
      confidence: 'medium',
      note: 'The filename gives the date but no clock time.',
    },
    media: {
      label: 'Embedded metadata',
      confidence: 'high',
      note: 'Capture time read from the file’s embedded EXIF metadata.',
    },
    driveCreated: {
      label: 'Drive upload date',
      confidence: 'low',
      note: 'No capture time in the filename, so this is when the file was ' +
            'added to Drive — it may be later than the actual incident.',
    },
    driveModified: {
      label: 'Drive modified date',
      confidence: 'low',
      note: 'Last-modified date from Drive; may be later than the incident.',
    },
  };

  /**
   * Resolve the incident time for one Drive file.
   * @param {object} file  A Drive files.list resource (or a hand-written entry).
   * @param {string[]} priority  Source order, from config.timestampPriority.
   * @returns {{date: Date, source: string, confidence: string,
   *            label: string, note: string, dateOnly: boolean}|null}
   */
  function resolve(file, priority) {
    priority = priority || ['filename', 'media', 'driveCreated', 'driveModified'];

    // An explicit override always wins — lets you hand-correct a bad guess in
    // data/incidents.json without touching any code.
    if (file.timestampOverride) {
      var forced = fromISO(file.timestampOverride);
      if (forced) {
        return decorate(forced, 'manual', false, {
          label: 'Manually set',
          confidence: 'high',
          note: 'Timestamp entered by hand in the data file.',
        });
      }
    }

    for (var i = 0; i < priority.length; i++) {
      var src = priority[i];

      if (src === 'filename') {
        var hit = fromFilename(file.name);
        if (hit) {
          var key = hit.dateOnly ? 'filename-dateonly' : 'filename';
          return decorate(hit.date, key, hit.dateOnly, SOURCE_INFO[key]);
        }
      } else if (src === 'media') {
        var med = fromMediaMetadata(file);
        if (med) return decorate(med, 'media', false, SOURCE_INFO.media);
      } else if (src === 'driveCreated') {
        var created = fromISO(file.createdTime);
        if (created) {
          return decorate(created, 'driveCreated', false, SOURCE_INFO.driveCreated);
        }
      } else if (src === 'driveModified') {
        var mod = fromISO(file.modifiedTime);
        if (mod) {
          return decorate(mod, 'driveModified', false, SOURCE_INFO.driveModified);
        }
      }
    }
    return null;
  }

  function decorate(date, source, dateOnly, info) {
    return {
      date: date,
      source: source,
      dateOnly: !!dateOnly,
      label: info.label,
      confidence: info.confidence,
      note: info.note,
    };
  }

  global.NCCTimestamps = {
    resolve: resolve,
    fromFilename: fromFilename,
    SOURCE_INFO: SOURCE_INFO,
  };
})(window);
