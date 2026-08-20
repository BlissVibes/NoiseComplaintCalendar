/*
 * ui.js — all rendering. Pure functions of (state) -> DOM, plus small
 * formatting helpers. No data fetching happens here.
 */
(function (global) {
  'use strict';

  var I = global.NCCIncidents;

  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /* ---------------- formatting ---------------- */

  // "10:42p" — compact enough to fit several badges in one calendar cell.
  function badgeTime(date) {
    var h = date.getHours();
    var m = date.getMinutes();
    var suffix = h >= 12 ? 'p' : 'a';
    var display = h % 12;
    if (display === 0) display = 12;
    return display + ':' + I.pad(m) + suffix;
  }

  // "10:42 PM"
  function clockTime(date) {
    var h = date.getHours();
    var m = date.getMinutes();
    var suffix = h >= 12 ? 'PM' : 'AM';
    var display = h % 12;
    if (display === 0) display = 12;
    return display + ':' + I.pad(m) + ' ' + suffix;
  }

  function longDate(date) {
    return DAY_SHORT[date.getDay()] + ', ' + MONTH_NAMES[date.getMonth()] +
      ' ' + date.getDate() + ', ' + date.getFullYear();
  }

  function shortDate(date) {
    return MONTH_SHORT[date.getMonth()] + ' ' + date.getDate();
  }

  function duration(ms) {
    if (!ms) return null;
    var total = Math.round(ms / 1000);
    var mins = Math.floor(total / 60);
    var secs = total % 60;
    return mins + ':' + I.pad(secs);
  }

  function fileSize(bytes) {
    if (!bytes) return null;
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    var n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
  }

  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ---------------- summary statistics ---------------- */

  function renderStats(host, stats, quietLabel) {
    host.innerHTML = '';
    if (!stats.total) return;

    var cards = [
      {
        value: stats.total,
        label: 'recorded incidents',
        sub: stats.spanDays + ' days documented',
      },
      {
        value: stats.afterHoursPct + '%',
        label: 'after hours',
        sub: stats.afterHours + ' of ' + stats.total + ' during ' + quietLabel,
        danger: stats.afterHoursPct >= 50,
      },
      {
        value: stats.daysAffected,
        label: 'separate days affected',
        sub: stats.spanDays
          ? Math.round((stats.daysAffected / stats.spanDays) * 100) + '% of the period'
          : '',
      },
      {
        value: stats.longestStreak,
        label: stats.longestStreak === 1 ? 'day streak' : 'consecutive days',
        sub: 'longest unbroken run',
      },
      {
        value: stats.perWeek,
        label: 'per week',
        sub: 'average frequency',
      },
      {
        value: stats.busiestDayCount,
        label: 'in one day',
        sub: stats.busiestDay
          ? 'on ' + shortDate(I.dayKeyToDate(stats.busiestDay))
          : '',
      },
    ];

    cards.forEach(function (card) {
      var node = el('div', 'stat' + (card.danger ? ' stat-danger' : ''));
      node.appendChild(el('div', 'stat-value', String(card.value)));
      node.appendChild(el('div', 'stat-label', card.label));
      if (card.sub) node.appendChild(el('div', 'stat-sub', card.sub));
      host.appendChild(node);
    });
  }

  /* ---------------- calendar ---------------- */

  /** Column order, honouring config.weekStartsOn. */
  function weekdayOrder(weekStartsOn) {
    var order = [];
    for (var i = 0; i < 7; i++) order.push((weekStartsOn + i) % 7);
    return order;
  }

  /**
   * One month grid. `onSelect` fires with a dayKey when a populated cell is
   * clicked. Empty cells are inert and not focusable.
   */
  function renderMonth(year, month, days, opts) {
    opts = opts || {};
    var cfg = global.NCC_CONFIG;
    var order = weekdayOrder(cfg.weekStartsOn);
    var compact = !!opts.compact;

    var wrap = el('div', 'month-grid' + (compact ? ' month-grid-compact' : ''));

    if (compact) {
      var head = el('div', 'mini-month-head');
      head.appendChild(el('span', 'mini-month-name', MONTH_NAMES[month]));
      var mstat = monthCoverage(year, month, days);
      if (mstat.count) {
        head.appendChild(el('span', 'mini-month-count',
          mstat.count + ' · ' + mstat.pct + '%'));
      }
      wrap.appendChild(head);
    }

    var grid = el('div', 'grid');

    order.forEach(function (d) {
      grid.appendChild(el('div', 'weekday', compact ? DAY_SHORT[d][0] : DAY_SHORT[d]));
    });

    var first = new Date(year, month, 1);
    var lead = (first.getDay() - cfg.weekStartsOn + 7) % 7;
    for (var i = 0; i < lead; i++) {
      grid.appendChild(el('div', 'cell cell-empty'));
    }

    var total = daysInMonth(year, month);
    for (var day = 1; day <= total; day++) {
      var date = new Date(year, month, day);
      var key = I.dayKey(date);
      var info = days[key];
      grid.appendChild(renderCell(date, day, key, info, compact, opts));
    }

    wrap.appendChild(grid);
    return wrap;
  }

  function renderCell(date, day, key, info, compact, opts) {
    var cfg = global.NCC_CONFIG;
    var hasIncidents = !!info;
    var cell = el(hasIncidents ? 'button' : 'div', 'cell');

    if (hasIncidents) {
      cell.type = 'button';
      cell.dataset.dayKey = key;
      cell.classList.add('cell-hit', 'level-' + info.level);
      if (info.afterHoursCount) cell.classList.add('cell-afterhours');
      if (opts.selectedDay === key) cell.classList.add('is-selected');

      var summary = info.count + (info.count === 1 ? ' incident' : ' incidents') +
        (info.afterHoursCount ? ', ' + info.afterHoursCount + ' after hours' : '');
      cell.setAttribute('aria-label', longDate(date) + ': ' + summary);
      cell.title = longDate(date) + '\n' + summary;

      if (opts.onSelect) {
        cell.addEventListener('click', function () { opts.onSelect(key); });
      }
    } else {
      cell.classList.add('cell-quiet');
    }

    cell.appendChild(el('span', 'cell-num', String(day)));

    if (!hasIncidents) return cell;

    if (compact) {
      // Year view has no room for badges; a count dot carries the load.
      cell.appendChild(el('span', 'cell-dot', String(info.count)));
      return cell;
    }

    // Time badges — what happened, before you click.
    var badges = el('div', 'badges');
    var limit = cfg.maxBadgesPerDay;
    info.incidents.slice(0, limit).forEach(function (inc) {
      var badge = el('span', 'badge' + (inc.afterHours ? ' badge-night' : ''));
      badge.textContent = inc.dateOnly ? 'time n/a' : badgeTime(inc.date);
      if (inc.afterHours) badge.title = 'After-hours incident at ' + clockTime(inc.date);
      badges.appendChild(badge);
    });
    if (info.incidents.length > limit) {
      var extra = info.incidents.length - limit;
      var more = el('span', 'badge badge-more', '+' + extra);
      more.title = extra + ' more on this day';
      badges.appendChild(more);
    }
    cell.appendChild(badges);
    return cell;
  }

  /** Incident count and share-of-days for one month. */
  function monthCoverage(year, month, days) {
    var total = daysInMonth(year, month);
    var count = 0;
    var affected = 0;
    var afterHours = 0;
    for (var d = 1; d <= total; d++) {
      var info = days[I.dayKey(new Date(year, month, d))];
      if (!info) continue;
      affected++;
      count += info.count;
      afterHours += info.afterHoursCount;
    }
    return {
      count: count,
      affected: affected,
      totalDays: total,
      afterHours: afterHours,
      pct: total ? Math.round((affected / total) * 100) : 0,
    };
  }

  function renderYear(year, days, opts) {
    var wrap = el('div', 'year-grid');
    for (var m = 0; m < 12; m++) {
      wrap.appendChild(renderMonth(year, m, days, {
        compact: true,
        onSelect: opts.onSelect,
        selectedDay: opts.selectedDay,
      }));
    }
    return wrap;
  }

  function renderLegend(host) {
    host.innerHTML = '';

    var scale = el('div', 'legend-item');
    scale.appendChild(el('span', 'legend-label', 'Less'));
    var swatches = el('span', 'legend-swatches');
    for (var i = 1; i <= 5; i++) {
      var sw = el('span', 'swatch level-' + i);
      sw.title = 'Heat level ' + i;
      swatches.appendChild(sw);
    }
    scale.appendChild(swatches);
    scale.appendChild(el('span', 'legend-label', 'More'));
    scale.appendChild(el('span', 'legend-note',
      '— yellow through orange and red to deep purple as incidents mount ' +
      'up on a day, or on the days around it'));
    host.appendChild(scale);

    // A miniature calendar cell, so the red rim in the legend is literally the
    // same thing the calendar draws.
    var glow = el('div', 'legend-item');
    var swatch = el('span', 'swatch level-3 cell-afterhours legend-glow');
    glow.appendChild(swatch);
    glow.appendChild(el('span', 'legend-note',
      'red glow — this day had at least one incident during quiet hours'));
    host.appendChild(glow);

    var night = el('div', 'legend-item');
    var demo = el('span', 'badge badge-night', '11:20p');
    night.appendChild(demo);
    night.appendChild(el('span', 'legend-note', 'after-hours incident'));
    host.appendChild(night);

    var dayItem = el('div', 'legend-item');
    dayItem.appendChild(el('span', 'badge', '2:15p'));
    dayItem.appendChild(el('span', 'legend-note', 'daytime incident'));
    host.appendChild(dayItem);
  }

  /* ---------------- detail pane ---------------- */

  function renderEmptyDetail(host, stats) {
    host.innerHTML = '';
    var empty = el('div', 'detail-empty');
    empty.appendChild(el('div', 'detail-empty-icon', '▤'));
    empty.appendChild(el('h2', null, 'Select a day'));
    empty.appendChild(el('p', null,
      stats && stats.total
        ? 'Click any shaded date on the calendar to watch the recordings from that day.'
        : 'No incidents loaded yet.'));
    host.appendChild(empty);
  }

  /**
   * Render every recording for one day. Each gets its own player, so a day
   * with three videos shows three players stacked, newest logic preserved in
   * chronological order.
   */
  function renderDetail(host, dayInfo, opts) {
    host.innerHTML = '';
    if (!dayInfo) return;

    var head = el('div', 'detail-head');
    var titles = el('div');
    titles.appendChild(el('h2', 'detail-date', longDate(dayInfo.date)));

    var meta = el('div', 'detail-meta');
    meta.appendChild(el('span', 'pill',
      dayInfo.count + (dayInfo.count === 1 ? ' recording' : ' recordings')));
    if (dayInfo.afterHoursCount) {
      meta.appendChild(el('span', 'pill pill-night',
        dayInfo.afterHoursCount + ' after hours'));
    }
    titles.appendChild(meta);
    head.appendChild(titles);

    var close = el('button', 'icon-btn', '✕');
    close.type = 'button';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close day details');
    close.addEventListener('click', function () { opts.onClose(); });
    head.appendChild(close);
    host.appendChild(head);

    dayInfo.incidents.forEach(function (inc, idx) {
      host.appendChild(renderIncidentCard(inc, idx, dayInfo.incidents.length));
    });
  }

  function renderIncidentCard(inc, idx, total) {
    var card = el('article', 'incident-card');
    card.id = 'incident-' + inc.id;

    var head = el('div', 'incident-head');

    var left = el('div', 'incident-head-left');
    var time = el('div', 'incident-time' + (inc.afterHours ? ' is-night' : ''));
    time.textContent = inc.dateOnly ? 'Time not recorded' : clockTime(inc.date);
    left.appendChild(time);
    if (inc.afterHours) {
      left.appendChild(el('span', 'tag tag-night', 'AFTER HOURS'));
    }
    if (total > 1) {
      left.appendChild(el('span', 'tag', 'Recording ' + (idx + 1) + ' of ' + total));
    }
    head.appendChild(left);
    card.appendChild(head);

    // The player: Drive's /preview endpoint plays the file inline.
    if (inc.previewUrl) {
      var frame = el('div', 'player');
      var iframe = document.createElement('iframe');
      iframe.src = inc.previewUrl;
      iframe.title = inc.name;
      iframe.loading = 'lazy';
      iframe.allow = 'autoplay; fullscreen';
      iframe.allowFullscreen = true;
      frame.appendChild(iframe);
      card.appendChild(frame);
    } else {
      var missing = el('div', 'player player-missing');
      missing.appendChild(el('p', null,
        'No Google Drive link for this file, so it cannot be played here.'));
      card.appendChild(missing);
    }

    var foot = el('div', 'incident-foot');

    var name = el('div', 'incident-name');
    name.textContent = inc.name;
    name.title = inc.name;
    foot.appendChild(name);

    // The raw reading, shown verbatim so it can be checked against the file
    // rather than taken on trust. This value never changes with the viewer.
    var stamp = el('div', 'incident-stamp');
    stamp.appendChild(el('span', 'stamp-key', 'Recorded'));
    stamp.appendChild(el('span', 'stamp-value', inc.rawStamp));
    if (inc.timeOrigin && inc.timeOrigin !== inc.rawStamp) {
      var origin = el('span', 'stamp-origin', 'read from “' + inc.timeOrigin + '”');
      origin.title = inc.timeNote || '';
      stamp.appendChild(origin);
    }
    foot.appendChild(stamp);

    var facts = el('div', 'incident-facts');
    var bits = [];
    if (inc.durationMs) bits.push(duration(inc.durationMs) + ' long');
    if (inc.sizeBytes) bits.push(fileSize(inc.sizeBytes));
    bits.push('Time source: ' + inc.timeLabel);
    facts.textContent = bits.join('  ·  ');
    if (inc.timeNote) facts.title = inc.timeNote;
    foot.appendChild(facts);

    if (inc.timeConfidence === 'low') {
      var warn = el('div', 'warn', '⚠ ' + inc.timeNote);
      foot.appendChild(warn);
    }
    if (inc.note) foot.appendChild(el('div', 'incident-note', inc.note));

    if (inc.viewUrl) {
      var link = el('a', 'open-link', 'Open in Google Drive ↗');
      link.href = inc.viewUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      foot.appendChild(link);
    }

    card.appendChild(foot);
    return card;
  }

  /* ---------------- the full list, grouped by month ---------------- */

  function renderMonthList(host, months, days, opts) {
    host.innerHTML = '';

    if (!months.length) {
      host.appendChild(el('p', 'muted', 'No incidents match this filter.'));
      return;
    }

    months.forEach(function (month) {
      var year = month.date.getFullYear();
      var monthIdx = month.date.getMonth();
      var cover = monthCoverage(year, monthIdx, days);

      var details = el('details', 'month-block');
      details.open = !!opts.openMonths[month.key];
      details.addEventListener('toggle', function () {
        opts.onToggle(month.key, details.open);
      });

      var summary = el('summary', 'month-summary');
      var title = el('span', 'month-title',
        MONTH_NAMES[monthIdx] + ' ' + year);
      summary.appendChild(title);

      // Share of the month's days that had at least one incident.
      var pct = el('span', 'month-pct', cover.pct + '% of days');
      pct.title = cover.affected + ' of ' + cover.totalDays +
        ' days in ' + MONTH_NAMES[monthIdx] + ' had at least one incident';
      if (cover.pct >= 50) pct.classList.add('is-high');
      summary.appendChild(pct);

      var counts = el('span', 'month-counts');
      counts.appendChild(el('span', 'pill', month.count +
        (month.count === 1 ? ' incident' : ' incidents')));
      if (month.afterHoursCount) {
        counts.appendChild(el('span', 'pill pill-night',
          month.afterHoursCount + ' after hours'));
      }
      summary.appendChild(counts);
      details.appendChild(summary);

      var list = el('div', 'day-list');
      month.days.slice().sort(function (a, b) { return a.date - b.date; })
        .forEach(function (day) {
          list.appendChild(renderDayRow(day, opts));
        });
      details.appendChild(list);
      host.appendChild(details);
    });
  }

  function renderDayRow(day, opts) {
    var row = el('button', 'day-row');
    row.type = 'button';
    if (opts.selectedDay === day.key) row.classList.add('is-selected');
    row.addEventListener('click', function () { opts.onSelect(day.key); });

    var dateCol = el('div', 'day-row-date');
    dateCol.appendChild(el('span', 'day-row-dow', DAY_SHORT[day.date.getDay()]));
    dateCol.appendChild(el('span', 'day-row-num', String(day.date.getDate())));
    row.appendChild(dateCol);

    var times = el('div', 'day-row-times');
    day.incidents.forEach(function (inc) {
      var badge = el('span', 'badge' + (inc.afterHours ? ' badge-night' : ''));
      badge.textContent = inc.dateOnly ? 'time n/a' : badgeTime(inc.date);
      times.appendChild(badge);
    });
    row.appendChild(times);

    var count = el('div', 'day-row-count',
      day.count + (day.count === 1 ? ' video' : ' videos'));
    row.appendChild(count);

    return row;
  }

  /* ---------------- CSV export ---------------- */

  function toCSV(incidents) {
    var header = ['Date', 'Day', 'Time', 'Recorded (raw)', 'After hours',
      'File name', 'Duration', 'Time source', 'Read from', 'Drive link'];
    var rows = incidents.map(function (inc) {
      return [
        I.dayKey(inc.date),
        DAY_SHORT[inc.date.getDay()],
        inc.dateOnly ? '' : clockTime(inc.date),
        inc.rawStamp,
        inc.afterHours ? 'YES' : 'no',
        inc.name,
        duration(inc.durationMs) || '',
        inc.timeLabel,
        inc.timeOrigin || '',
        inc.viewUrl || '',
      ];
    });
    return [header].concat(rows).map(function (row) {
      return row.map(function (cell) {
        var s = String(cell == null ? '' : cell);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\n');
  }

  global.NCCUi = {
    renderStats: renderStats,
    renderMonth: renderMonth,
    renderYear: renderYear,
    renderLegend: renderLegend,
    renderDetail: renderDetail,
    renderEmptyDetail: renderEmptyDetail,
    renderMonthList: renderMonthList,
    monthCoverage: monthCoverage,
    toCSV: toCSV,
    badgeTime: badgeTime,
    clockTime: clockTime,
    longDate: longDate,
    shortDate: shortDate,
    MONTH_NAMES: MONTH_NAMES,
  };
})(window);
