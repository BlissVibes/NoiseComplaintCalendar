/*
 * app.js — application state and event wiring.
 */
(function (global) {
  'use strict';

  var I = global.NCCIncidents;
  var Ui = global.NCCUi;
  var cfg = global.NCC_CONFIG;

  var state = {
    incidents: [],
    days: {},
    months: [],
    stats: null,
    cursor: new Date(),       // which month the calendar is showing
    view: 'month',            // 'month' | 'year'
    selectedDay: null,
    openMonths: {},
    afterHoursOnly: false,
  };

  var dom = {};

  function $(id) { return document.getElementById(id); }

  function init() {
    dom = {
      subtitle: $('subtitle'),
      stats: $('stats'),
      calendarHost: $('calendar-host'),
      monthLabel: $('month-label'),
      legend: $('legend'),
      detail: $('detail'),
      monthList: $('month-list'),
      filterCount: $('filter-count'),
      ordinance: $('ordinance-note'),
    };

    $('btn-prev').addEventListener('click', function () { step(-1); });
    $('btn-next').addEventListener('click', function () { step(1); });
    $('btn-view-month').addEventListener('click', function () { setView('month'); });
    $('btn-view-year').addEventListener('click', function () { setView('year'); });
    $('btn-export').addEventListener('click', exportCsv);
    $('btn-print').addEventListener('click', function () { global.print(); });
    $('btn-expand-all').addEventListener('click', function () { setAllMonths(true); });
    $('btn-collapse-all').addEventListener('click', function () { setAllMonths(false); });
    $('filter-afterhours').addEventListener('change', function (e) {
      state.afterHoursOnly = e.target.checked;
      renderList();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.selectedDay) selectDay(null);
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    });

    renderOrdinance();
    Ui.renderLegend(dom.legend);
    load();
  }

  function renderOrdinance() {
    var j = cfg.jurisdiction;
    var window_ = I.formatQuietWindow();
    dom.ordinance.innerHTML = '';
    dom.ordinance.appendChild(document.createTextNode(
      'After-hours incidents are those falling within ' + j.name +
      ' quiet hours, ' + window_ + '. See '));
    var link = document.createElement('a');
    link.href = j.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = j.citation;
    dom.ordinance.appendChild(link);
    dom.ordinance.appendChild(document.createTextNode('.'));
  }

  function load() {
    global.NCCData.load(cfg).then(function (result) {
      var built = I.buildAll(result.files);
      state.incidents = built.incidents;
      state.days = I.indexByDay(state.incidents);
      state.months = I.groupByMonth(state.days);
      state.stats = I.summarize(state.incidents, state.days);

      // Open on the most recent month that actually has incidents.
      if (state.incidents.length) {
        var last = state.incidents[state.incidents.length - 1].date;
        state.cursor = new Date(last.getFullYear(), last.getMonth(), 1);
        if (state.months.length) state.openMonths[state.months[0].key] = true;
      }

      renderSubtitle(result, built.skipped);
      Ui.renderStats(dom.stats, state.stats, I.formatQuietWindow());
      renderCalendar();
      renderList();
      Ui.renderEmptyDetail(dom.detail, state.stats);
    }).catch(function (err) {
      dom.subtitle.textContent = 'Could not load incidents: ' + err.message;
      dom.subtitle.classList.add('is-error');
      Ui.renderEmptyDetail(dom.detail, null);
    });
  }

  function renderSubtitle(result, skipped) {
    var s = state.stats;
    if (!s.total) {
      dom.subtitle.textContent = 'No incidents found in the data source.';
      return;
    }
    var text = s.total + ' recordings from ' +
      Ui.shortDate(s.firstDate) + ' ' + s.firstDate.getFullYear() + ' to ' +
      Ui.shortDate(s.lastDate) + ' ' + s.lastDate.getFullYear();
    if (result.source === 'sample') {
      text += '  ·  showing bundled sample data';
    }
    if (skipped.length) {
      text += '  ·  ' + skipped.length + ' file(s) skipped, no usable date';
    }
    dom.subtitle.textContent = text;
  }

  /* ---------------- calendar ---------------- */

  function renderCalendar() {
    var year = state.cursor.getFullYear();
    var month = state.cursor.getMonth();
    dom.calendarHost.innerHTML = '';

    var opts = {
      onSelect: selectDay,
      selectedDay: state.selectedDay,
    };

    if (state.view === 'year') {
      dom.monthLabel.textContent = String(year);
      appendYearCoverage(year);
      dom.calendarHost.appendChild(Ui.renderYear(year, state.days, opts));
    } else {
      dom.monthLabel.textContent = Ui.MONTH_NAMES[month] + ' ' + year;
      appendMonthCoverage(year, month);
      dom.calendarHost.appendChild(Ui.renderMonth(year, month, state.days, opts));
    }
  }

  /** "12 of 31 days · 39%" beside the month title. */
  function appendMonthCoverage(year, month) {
    var cover = Ui.monthCoverage(year, month, state.days);
    var tag = document.createElement('span');
    tag.className = 'month-coverage';
    if (!cover.count) {
      tag.textContent = 'no incidents';
      tag.classList.add('is-clear');
    } else {
      tag.textContent = cover.affected + ' of ' + cover.totalDays +
        ' days · ' + cover.pct + '%';
      if (cover.pct >= 50) tag.classList.add('is-high');
      tag.title = cover.count + ' incidents across ' + cover.affected +
        ' of the ' + cover.totalDays + ' days this month' +
        (cover.afterHours ? '; ' + cover.afterHours + ' after hours' : '');
    }
    dom.monthLabel.appendChild(tag);
  }

  /** Same idea across a whole year. */
  function appendYearCoverage(year) {
    var affected = 0;
    var count = 0;
    var totalDays = 0;
    for (var m = 0; m < 12; m++) {
      var cover = Ui.monthCoverage(year, m, state.days);
      affected += cover.affected;
      count += cover.count;
      totalDays += cover.totalDays;
    }
    var tag = document.createElement('span');
    tag.className = 'month-coverage';
    if (!count) {
      tag.textContent = 'no incidents';
      tag.classList.add('is-clear');
    } else {
      var pct = Math.round((affected / totalDays) * 100);
      tag.textContent = affected + ' of ' + totalDays + ' days · ' + pct + '%';
      if (pct >= 50) tag.classList.add('is-high');
    }
    dom.monthLabel.appendChild(tag);
  }

  function step(delta) {
    if (state.view === 'year') {
      state.cursor = new Date(state.cursor.getFullYear() + delta, 0, 1);
    } else {
      state.cursor = new Date(
        state.cursor.getFullYear(),
        state.cursor.getMonth() + delta,
        1
      );
    }
    renderCalendar();
  }

  function setView(view) {
    state.view = view;
    $('btn-view-month').classList.toggle('is-active', view === 'month');
    $('btn-view-year').classList.toggle('is-active', view === 'year');
    renderCalendar();
  }

  /* ---------------- selection ---------------- */

  function selectDay(dayKey) {
    state.selectedDay = dayKey;

    if (!dayKey) {
      Ui.renderEmptyDetail(dom.detail, state.stats);
    } else {
      var day = state.days[dayKey];
      // Follow the calendar to the month of the day just picked from the list.
      var d = day.date;
      if (
        d.getFullYear() !== state.cursor.getFullYear() ||
        d.getMonth() !== state.cursor.getMonth()
      ) {
        state.cursor = new Date(d.getFullYear(), d.getMonth(), 1);
      }
      Ui.renderDetail(dom.detail, day, { onClose: function () { selectDay(null); } });
      if (global.matchMedia('(max-width: 900px)').matches) {
        dom.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    renderCalendar();
    renderList();
  }

  /* ---------------- list ---------------- */

  function renderList() {
    var months = state.months;
    var days = state.days;

    if (state.afterHoursOnly) {
      days = {};
      Object.keys(state.days).forEach(function (key) {
        var day = state.days[key];
        if (!day.afterHoursCount) return;
        var filtered = day.incidents.filter(function (i) { return i.afterHours; });
        days[key] = Object.assign({}, day, {
          incidents: filtered,
          count: filtered.length,
        });
      });
      months = I.groupByMonth(days);
    }

    Ui.renderMonthList(dom.monthList, months, days, {
      openMonths: state.openMonths,
      selectedDay: state.selectedDay,
      onSelect: selectDay,
      onToggle: function (key, open) { state.openMonths[key] = open; },
    });

    var shown = months.reduce(function (sum, m) { return sum + m.count; }, 0);
    dom.filterCount.textContent = state.afterHoursOnly
      ? shown + ' of ' + state.stats.total + ' shown'
      : shown + ' total';
  }

  function setAllMonths(open) {
    state.months.forEach(function (m) { state.openMonths[m.key] = open; });
    renderList();
  }

  /* ---------------- export ---------------- */

  function exportCsv() {
    var csv = Ui.toCSV(state.incidents);
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'noise-incidents.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
