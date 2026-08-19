/*
 * incidents.js — turn raw Drive file records into the incident model the rest
 * of the UI works from, and derive the per-day statistics.
 */
(function (global) {
  'use strict';

  var cfg = function () { return global.NCC_CONFIG; };

  /* ---------------- date helpers (all local time) ---------------- */

  function dayKey(date) {
    return (
      date.getFullYear() + '-' +
      pad(date.getMonth() + 1) + '-' +
      pad(date.getDate())
    );
  }

  function monthKey(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1);
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function dayKeyToDate(key) {
    var p = key.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function addDays(date, n) {
    var d = new Date(date.getTime());
    d.setDate(d.getDate() + n);
    return d;
  }

  /* ---------------- quiet-hours logic ---------------- */

  /**
   * Is this timestamp inside the jurisdiction's quiet hours?
   * The window wraps midnight (22:00 -> 07:00), so the test is an OR, not a
   * range. Uses fractional hours so 9:59 PM and 10:00 PM land correctly.
   */
  function isAfterHours(date, quiet) {
    quiet = quiet || cfg().quietHours;
    var h = date.getHours() + date.getMinutes() / 60;
    if (quiet.start === quiet.end) return false;
    if (quiet.start > quiet.end) {
      // Wraps past midnight, the normal case: >= 22:00 OR < 07:00
      return h >= quiet.start || h < quiet.end;
    }
    return h >= quiet.start && h < quiet.end;
  }

  /* Friendly name for the record's zone, e.g. "America/Los_Angeles (PDT)". */
  function describeTimeZone() {
    var zone = cfg().recordTimeZone || 'America/Los_Angeles';
    try {
      var abbr = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        timeZoneName: 'short',
      }).formatToParts(new Date()).filter(function (p) {
        return p.type === 'timeZoneName';
      })[0];
      return abbr ? zone + ' (' + abbr.value + ')' : zone;
    } catch (e) {
      return zone;
    }
  }

  function formatQuietWindow(quiet) {
    quiet = quiet || cfg().quietHours;
    return formatHour(quiet.start) + ' – ' + formatHour(quiet.end);
  }

  function formatHour(h) {
    var suffix = h >= 12 ? 'PM' : 'AM';
    var display = h % 12;
    if (display === 0) display = 12;
    return display + ':00 ' + suffix;
  }

  /* ---------------- Drive link helpers ---------------- */

  // Accepts a full Drive URL in any of its shapes, or a bare ID.
  function extractDriveId(value) {
    if (!value) return null;
    var patterns = [
      /\/file\/d\/([a-zA-Z0-9_-]{10,})/,
      /\/folders\/([a-zA-Z0-9_-]{10,})/,
      /[?&]id=([a-zA-Z0-9_-]{10,})/,
      /^([a-zA-Z0-9_-]{20,})$/,
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = patterns[i].exec(String(value).trim());
      if (m) return m[1];
    }
    return null;
  }

  function previewUrl(id) {
    return 'https://drive.google.com/file/d/' + id + '/preview';
  }

  function viewUrl(id) {
    return 'https://drive.google.com/file/d/' + id + '/view';
  }

  function thumbUrl(id, size) {
    return 'https://drive.google.com/thumbnail?id=' + id + '&sz=w' + (size || 640);
  }

  /* ---------------- building incidents ---------------- */

  /**
   * Normalise one raw record into an incident.
   * Raw records may come from the Drive API or straight from incidents.json.
   */
  function build(raw) {
    var id = raw.id || extractDriveId(raw.link || raw.webViewLink || raw.url);
    var resolved = global.NCCTimestamps.resolve(
      raw, cfg().timestampPriority, cfg().recordTimeZone);
    if (!resolved) return null;

    var date = resolved.date;
    return {
      id: id || raw.name,
      driveId: id,
      name: raw.name || 'Untitled recording',
      date: date,
      dayKey: dayKey(date),
      monthKey: monthKey(date),
      timeSource: resolved.source,
      timeLabel: resolved.label,
      timeConfidence: resolved.confidence,
      timeNote: resolved.note,
      dateOnly: resolved.dateOnly,
      afterHours: resolved.dateOnly ? false : isAfterHours(date),
      durationMs: raw.videoMediaMetadata && raw.videoMediaMetadata.durationMillis
        ? Number(raw.videoMediaMetadata.durationMillis)
        : (raw.durationMs || null),
      sizeBytes: raw.size ? Number(raw.size) : (raw.sizeBytes || null),
      mimeType: raw.mimeType || '',
      note: raw.note || '',
      previewUrl: id ? previewUrl(id) : null,
      viewUrl: id ? viewUrl(id) : (raw.link || null),
      thumbnailUrl: id ? thumbUrl(id) : (raw.thumbnailLink || null),
    };
  }

  /** Build, drop unusable rows, and sort oldest -> newest. */
  function buildAll(rawList) {
    var out = [];
    var skipped = [];
    (rawList || []).forEach(function (raw) {
      var inc = build(raw);
      if (inc) out.push(inc);
      else skipped.push(raw.name || '(unnamed)');
    });
    out.sort(function (a, b) { return a.date - b.date; });
    return { incidents: out, skipped: skipped };
  }

  /* ---------------- day index + heat scoring ---------------- */

  /**
   * Group incidents by day and score each day for the heatmap.
   *
   * The score is the day's own count plus a decaying share of its neighbours',
   * which is what makes a run of consecutive nights read darker than the same
   * number of incidents scattered across a month. Days with no incidents of
   * their own are never shaded — an empty Tuesday between two loud nights is
   * still an empty Tuesday.
   */
  function indexByDay(incidents) {
    var days = {};

    incidents.forEach(function (inc) {
      if (!days[inc.dayKey]) {
        days[inc.dayKey] = {
          key: inc.dayKey,
          date: dayKeyToDate(inc.dayKey),
          incidents: [],
          count: 0,
          afterHoursCount: 0,
          score: 0,
          level: 0,
        };
      }
      var d = days[inc.dayKey];
      d.incidents.push(inc);
      d.count++;
      if (inc.afterHours) d.afterHoursCount++;
    });

    var weights = cfg().clusterWeights;
    var thresholds = cfg().heatThresholds;

    Object.keys(days).forEach(function (key) {
      var day = days[key];
      var score = day.count * weights[0];
      for (var offset = 1; offset < weights.length; offset++) {
        var before = days[dayKey(addDays(day.date, -offset))];
        var after = days[dayKey(addDays(day.date, offset))];
        if (before) score += before.count * weights[offset];
        if (after) score += after.count * weights[offset];
      }
      day.score = score;
      day.level = levelFor(score, thresholds);
      day.incidents.sort(function (a, b) { return a.date - b.date; });
    });

    return days;
  }

  function levelFor(score, thresholds) {
    for (var i = 0; i < thresholds.length; i++) {
      if (score < thresholds[i]) return i + 1;
    }
    return thresholds.length + 1;
  }

  /* ---------------- headline statistics ---------------- */

  /**
   * The numbers that make the pattern obvious at a glance. "Longest streak"
   * counts consecutive calendar days that each had at least one incident.
   */
  function summarize(incidents, days) {
    var keys = Object.keys(days).sort();
    var afterHours = incidents.filter(function (i) { return i.afterHours; }).length;

    var longestStreak = 0;
    var currentStreak = 0;
    var streakEnd = null;
    var bestStreakEnd = null;

    keys.forEach(function (key) {
      var prev = dayKey(addDays(dayKeyToDate(key), -1));
      currentStreak = days[prev] ? currentStreak + 1 : 1;
      streakEnd = key;
      if (currentStreak > longestStreak) {
        longestStreak = currentStreak;
        bestStreakEnd = streakEnd;
      }
    });

    var busiest = null;
    keys.forEach(function (key) {
      if (!busiest || days[key].count > days[busiest].count) busiest = key;
    });

    var first = incidents.length ? incidents[0].date : null;
    var last = incidents.length ? incidents[incidents.length - 1].date : null;
    var spanDays = first && last
      ? Math.round((dayKeyToDate(dayKey(last)) - dayKeyToDate(dayKey(first))) / 86400000) + 1
      : 0;

    return {
      total: incidents.length,
      daysAffected: keys.length,
      afterHours: afterHours,
      afterHoursPct: incidents.length
        ? Math.round((afterHours / incidents.length) * 100)
        : 0,
      longestStreak: longestStreak,
      longestStreakEnd: bestStreakEnd,
      busiestDay: busiest,
      busiestDayCount: busiest ? days[busiest].count : 0,
      firstDate: first,
      lastDate: last,
      spanDays: spanDays,
      // How often it happens across the whole documented period.
      perWeek: spanDays > 0
        ? Math.round((incidents.length / (spanDays / 7)) * 10) / 10
        : 0,
      lowConfidence: incidents.filter(function (i) {
        return i.timeConfidence === 'low';
      }).length,
    };
  }

  /** Group day keys into months, newest month first, for the dropdown list. */
  function groupByMonth(days) {
    var months = {};
    Object.keys(days).sort().forEach(function (key) {
      var day = days[key];
      var mk = monthKey(day.date);
      if (!months[mk]) {
        months[mk] = {
          key: mk,
          date: new Date(day.date.getFullYear(), day.date.getMonth(), 1),
          days: [],
          count: 0,
          afterHoursCount: 0,
        };
      }
      months[mk].days.push(day);
      months[mk].count += day.count;
      months[mk].afterHoursCount += day.afterHoursCount;
    });
    return Object.keys(months)
      .sort()
      .reverse()
      .map(function (k) { return months[k]; });
  }

  global.NCCIncidents = {
    build: build,
    buildAll: buildAll,
    indexByDay: indexByDay,
    summarize: summarize,
    groupByMonth: groupByMonth,
    isAfterHours: isAfterHours,
    formatQuietWindow: formatQuietWindow,
    describeTimeZone: describeTimeZone,
    extractDriveId: extractDriveId,
    previewUrl: previewUrl,
    viewUrl: viewUrl,
    thumbUrl: thumbUrl,
    dayKey: dayKey,
    monthKey: monthKey,
    dayKeyToDate: dayKeyToDate,
    addDays: addDays,
    pad: pad,
  };
})(window);
