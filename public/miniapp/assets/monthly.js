/* Monthly dashboard renderer.
 *
 * Generic on purpose: it knows about `alerts`, `kpis`, `charts`, `tables` and
 * `insights`, and about the unit tags the payload puts on each figure, and
 * about nothing else. Every casino metric, benchmark and threshold lives in
 * `src/session/monthlyReport.js`, so adding a section there needs no change
 * here.
 *
 * Nothing in the payload is ever inserted as markup — values go in through
 * textContent — so a username or a PayName out of an uploaded workbook cannot
 * become HTML. */
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  var contentEl = document.getElementById('content');
  var errorEl = document.getElementById('error');
  var panelEl = document.getElementById('panel');
  var tabsEl = document.getElementById('tabs');
  var gateEl = document.getElementById('pin-gate');

  /* Chart instances of the tab being replaced. Chart.js keeps a registry keyed
     by canvas, so leaving these attached leaks a listener per tab switch and
     eventually refuses to draw onto a canvas it thinks is still in use. */
  var liveCharts = [];

  function fail(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    contentEl.hidden = true;
    gateEl.hidden = true;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // --- formatting ------------------------------------------------------------

  /* SKILL.md "แสดงผลในรายงาน": >= 1M as ฿X.XXM, otherwise ฿X,XXX. The value is
     already baht — the payload only ever carries `_THB` columns — so there is
     no rate applied anywhere on this page. */
  function formatThb(value) {
    var sign = value < 0 ? '-' : '';
    var abs = Math.abs(value);
    if (abs >= 1000000) return sign + '฿' + (abs / 1000000).toFixed(2) + 'M';
    return sign + '฿' + Math.round(abs).toLocaleString('en-US');
  }

  function formatValue(value, unit) {
    if (value === null || value === undefined || value === '') return '—';
    if (unit === 'text') return String(value);
    if (typeof value !== 'number' || !isFinite(value)) return String(value);

    if (unit === 'thb') return formatThb(value);
    /* Already multiplied by 100 upstream (`_pct`, or a ratio of head counts).
       Never multiplied again here. */
    if (unit === 'pct') return value.toFixed(1) + '%';
    if (unit === 'min') return value.toFixed(1) + ' นาที';
    if (unit === 'count') return Math.round(value).toLocaleString('en-US');
    return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  var NUMERIC_UNITS = { thb: 1, pct: 1, count: 1, number: 1, min: 1 };

  var THAI_MONTHS = [
    'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
  ];

  /* `2026-07` → `กรกฎาคม 2026`. Formatted here rather than in the payload so
     the builder stays a data module. */
  function monthLabel(yearMonth) {
    var match = /^(\d{4})-(\d{2})$/.exec(String(yearMonth || ''));
    if (!match) return String(yearMonth || '');
    var month = THAI_MONTHS[Number(match[2]) - 1];
    return month ? month + ' ' + match[1] : String(yearMonth);
  }

  // --- pieces ----------------------------------------------------------------

  function renderAlerts(alerts) {
    if (!alerts || !alerts.length) return null;
    var box = el('div');
    alerts.forEach(function (item) {
      box.appendChild(el('div', 'alert alert-' + (item.level || 'warn'), item.text));
    });
    return box;
  }

  function renderKpis(kpis) {
    if (!kpis || !kpis.length) return null;

    var card = el('section');
    card.appendChild(el('h2', null, 'ตัวเลขสำคัญ'));
    var grid = el('div', 'kpis');

    kpis.forEach(function (kpi) {
      var cell = el('div', 'kpi');
      cell.appendChild(el('div', 'kpi-label', kpi.label));
      cell.appendChild(
        el('div', 'kpi-value' + (kpi.status ? ' is-' + kpi.status : ''), formatValue(kpi.value, kpi.unit)),
      );
      if (kpi.note) cell.appendChild(el('div', 'kpi-note', kpi.note));
      grid.appendChild(cell);
    });

    card.appendChild(grid);
    return card;
  }

  function renderInsights(insights) {
    if (!insights || !insights.length) return null;
    var card = el('section');
    card.appendChild(el('h2', null, 'Key Insights'));
    var list = el('ul', 'insights');
    insights.forEach(function (line) {
      list.appendChild(el('li', null, line));
    });
    card.appendChild(list);
    return card;
  }

  /* Categorical palette: distinct hues at similar lightness so no series reads
     as more important than another, and all stay legible on light or dark.
     Same set as the session dashboard, so the two pages look like one product. */
  var PALETTE = ['#3b7dd8', '#e08a3c', '#3aa675', '#b45fc4', '#d4576a', '#4aa3c4'];
  var GOOD = '#3aa675';
  var WARN = '#e08a3c';
  var BAD = '#d4576a';

  function cssVar(name, fallback) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (value && value.trim()) || fallback;
  }

  /* Per-bar colouring, for the three cases where one colour for the series
     would hide the point of the chart: a negative-profit day, a payment channel
     below threshold, and a funnel whose stages are different things. */
  function barColors(set, spec, fallback) {
    if (set.colorBySign) {
      return set.data.map(function (v) {
        return v >= 0 ? GOOD : BAD;
      });
    }
    if (set.colorByThreshold) {
      return set.data.map(function (v) {
        if (v === null) return fallback;
        if (v >= set.colorByThreshold.good) return GOOD;
        if (v >= set.colorByThreshold.warn) return WARN;
        return BAD;
      });
    }
    if (set.colorByIndex) {
      return spec.labels.map(function (_, i) {
        return PALETTE[i % PALETTE.length];
      });
    }
    return null;
  }

  function renderChart(spec) {
    if (!spec || !spec.labels || !spec.labels.length || !spec.datasets || !spec.datasets.length) {
      return null;
    }

    var card = el('section');
    card.appendChild(el('h2', null, spec.title || 'กราฟ'));

    var scroll = el('div', 'scroll-x');
    var box = el('div', 'chart-box');
    /* A horizontal bar chart needs room per row, or 12 payment channels get
       6px each and no label is readable. */
    if (spec.horizontal) box.style.height = Math.max(220, spec.labels.length * 30 + 60) + 'px';
    var canvas = document.createElement('canvas');
    box.appendChild(canvas);
    scroll.appendChild(box);
    card.appendChild(scroll);

    var isRound = spec.type === 'doughnut' || spec.type === 'pie';
    var fg = cssVar('--fg', '#1c1c1e');
    var muted = cssVar('--muted', '#8e8e93');
    var unit = (spec.datasets[0] && spec.datasets[0].unit) || 'number';

    var datasets = spec.datasets.map(function (set, i) {
      var color = PALETTE[i % PALETTE.length];
      if (isRound) {
        return {
          label: set.label,
          data: set.data,
          backgroundColor: spec.labels.map(function (_, j) {
            return PALETTE[j % PALETTE.length];
          }),
          borderWidth: 0,
        };
      }

      var type = set.chartType || spec.type || 'bar';
      var custom = barColors(set, spec, color);
      return {
        type: type,
        label: set.label,
        data: set.data,
        backgroundColor: custom || (type === 'line' ? color + '26' : color),
        borderColor: custom ? undefined : color,
        borderWidth: 2,
        tension: 0.3,
        pointRadius: spec.labels.length > 20 ? 0 : 3,
        fill: type === 'line' && spec.datasets.length === 1 && !spec.refLine,
        order: type === 'line' ? 1 : 2,
      };
    });

    /* A flat reference line — the 100% RTP mark, where above means the casino
       paid out more than it took in. Drawn as a dashed dataset because that
       needs no plugin. */
    if (spec.refLine) {
      datasets.push({
        type: 'line',
        label: spec.refLine.label || 'อ้างอิง',
        data: spec.labels.map(function () {
          return spec.refLine.value;
        }),
        borderColor: BAD,
        borderDash: [5, 5],
        borderWidth: 1,
        pointRadius: 0,
        fill: false,
      });
    }

    var valueAxis = {
      ticks: {
        color: muted,
        callback: function (v) {
          return formatValue(v, unit);
        },
      },
      grid: { color: muted + '33' },
      stacked: !!spec.stacked,
    };
    if (spec.maxValue !== undefined) valueAxis.max = spec.maxValue;

    var categoryAxis = {
      ticks: { color: muted, maxRotation: 0, autoSkip: !spec.horizontal },
      grid: { display: false },
      stacked: !!spec.stacked,
    };

    var chart = new Chart(canvas, {
      type: spec.type || 'bar',
      data: { labels: spec.labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: spec.horizontal ? 'y' : 'x',
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: datasets.length > 1 || isRound,
            labels: { color: fg, boxWidth: 12, usePointStyle: true },
          },
          tooltip: {
            callbacks: {
              label: function (item) {
                var v = spec.horizontal
                  ? item.parsed.x
                  : item.parsed.y !== undefined
                    ? item.parsed.y
                    : item.parsed;
                var setUnit = spec.datasets[item.datasetIndex]
                  ? spec.datasets[item.datasetIndex].unit || unit
                  : unit;
                return item.dataset.label + ': ' + formatValue(v, setUnit);
              },
            },
          },
        },
        scales: isRound
          ? {}
          : spec.horizontal
            ? { x: valueAxis, y: categoryAxis }
            : { x: categoryAxis, y: valueAxis },
      },
    });

    liveCharts.push(chart);
    return card;
  }

  function renderTable(spec) {
    if (!spec || !spec.columns || !spec.columns.length) return null;

    var card = el('section');
    card.appendChild(el('h2', null, spec.title || 'ตาราง'));

    if (!spec.rows || !spec.rows.length) {
      card.appendChild(el('div', 'empty-state', 'ไม่มีข้อมูลในตารางนี้'));
      if (spec.note) card.appendChild(el('div', 'note', spec.note));
      return card;
    }

    var scroll = el('div', 'scroll-x');
    var table = el('table');

    var thead = el('thead');
    var headRow = el('tr');
    spec.columns.forEach(function (column) {
      headRow.appendChild(el('th', NUMERIC_UNITS[column.unit] ? 'num' : null, column.label));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    spec.rows.forEach(function (row) {
      var tr = el('tr');
      spec.columns.forEach(function (column) {
        var td = el('td', NUMERIC_UNITS[column.unit] ? 'num' : null);
        /* `_status` lets the builder flag one cell of a row — an RTP over
           100%, a payment channel below threshold — without the renderer
           knowing what any of those mean. */
        var status = row._status && row._status[column.key];
        if (status) {
          var tag = el('span', 'tag is-' + status, formatValue(row[column.key], column.unit));
          td.appendChild(tag);
        } else {
          td.textContent = formatValue(row[column.key], column.unit);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    scroll.appendChild(table);
    card.appendChild(scroll);
    if (spec.note) card.appendChild(el('div', 'note', spec.note));
    return card;
  }

  // --- tabs ------------------------------------------------------------------

  function showSection(section) {
    liveCharts.forEach(function (chart) {
      chart.destroy();
    });
    liveCharts = [];
    panelEl.textContent = '';

    if (!section.available) {
      var card = el('section');
      card.appendChild(el('h2', null, section.title));
      card.appendChild(
        el(
          'div',
          'empty-state',
          (section.reason || 'ไม่มีข้อมูล') +
            ' — ไฟล์ที่ต้องใช้: ' +
            (section.fileLabel || section.fileType),
        ),
      );
      panelEl.appendChild(card);
      return;
    }

    var alerts = renderAlerts(section.alerts);
    if (alerts) panelEl.appendChild(alerts);

    var kpiCard = renderKpis(section.kpis);
    if (kpiCard) panelEl.appendChild(kpiCard);

    (section.charts || []).forEach(function (spec) {
      var card = renderChart(spec);
      if (card) panelEl.appendChild(card);
    });

    (section.tables || []).forEach(function (spec) {
      var card = renderTable(spec);
      if (card) panelEl.appendChild(card);
    });

    var insightCard = renderInsights(section.insights);
    if (insightCard) panelEl.appendChild(insightCard);

    if (!panelEl.firstChild) {
      var blank = el('section');
      blank.appendChild(el('h2', null, section.title));
      blank.appendChild(el('div', 'empty-state', 'ไฟล์นี้อ่านได้ แต่ไม่มีตัวเลขที่แสดงได้'));
      panelEl.appendChild(blank);
    }
  }

  function buildTabs(sections) {
    var buttons = [];

    sections.forEach(function (section) {
      var button = el('button', 'tab' + (section.available ? '' : ' empty'), section.title);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', 'false');
      button.addEventListener('click', function () {
        buttons.forEach(function (other) {
          other.setAttribute('aria-selected', 'false');
        });
        button.setAttribute('aria-selected', 'true');
        showSection(section);

        /* Scroll the toolbar to the top, not the panel: the toolbar is sticky,
           so putting the panel at the top of the viewport puts its first card
           underneath it. Landing the toolbar there leaves the panel starting
           exactly below the tabs. */
        tabsEl.scrollIntoView({ block: 'start' });
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
      buttons.push(button);
      tabsEl.appendChild(button);
    });

    return buttons;
  }

  function render(payload) {
    if (payload.kind !== 'monthly') {
      fail('ลิงก์นี้เป็นสรุป session ไม่ใช่สรุปเดือน — เปิดจากปุ่ม "ดูกราฟ" ในแชทแทนครับ');
      return;
    }

    var heading = (payload.siteName || '') + ' — รายงานภาพรวมธุรกิจ';
    document.getElementById('title').textContent = heading;
    document.getElementById('month-badge').textContent = monthLabel(payload.yearMonth);
    document.title = heading + ' ' + monthLabel(payload.yearMonth);

    var sections = payload.sections || [];
    var ready = sections.filter(function (section) {
      return section.available;
    });
    document.getElementById('meta-files').textContent =
      '📊 อ่านจากไฟล์ Power BI ' + (payload.fileCount || 0) + ' ไฟล์ · ' +
      'หมวดที่มีข้อมูล ' + ready.length + '/' + sections.length;

    if (payload.currency) {
      var c = payload.currency;
      document.getElementById('meta-currency').textContent = c.needsFxConversion
        ? '💰 หน่วยเงิน: บาท (แปลงจาก ' + c.currency + ' อัตรา ' + c.fxRate + ' ณ ' + c.fxRateAsOf +
          ', คูณกลับ ' + c.scaleFactor.toLocaleString('en-US') + ' ที่ Power BI ตัดไว้)'
        : '💰 หน่วยเงิน: บาท (' + c.currency + ' อยู่แล้ว, คูณกลับ ' +
          c.scaleFactor.toLocaleString('en-US') + ' ที่ Power BI ตัดไว้)';
    }

    if (payload.generatedAt) {
      document.getElementById('meta-time').textContent =
        '🕒 สร้างเมื่อ ' +
        new Date(payload.generatedAt).toLocaleString('th-TH', {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
    }

    if (!sections.length) {
      fail('ไม่มีข้อมูลในเดือนนี้');
      return;
    }

    var buttons = buildTabs(sections);
    /* Open on the first tab that actually has something in it, so a month
       missing its Daily Value file does not greet the user with an empty page. */
    var first = ready[0] || sections[0];
    var index = sections.indexOf(first);
    buttons[index].setAttribute('aria-selected', 'true');
    showSection(first);

    if (payload.missingFiles && payload.missingFiles.length) {
      var list = document.getElementById('missing-list');
      payload.missingFiles.forEach(function (entry) {
        list.appendChild(el('li', null, entry.label));
      });
      document.getElementById('missing-card').hidden = false;
    }

    contentEl.hidden = false;
  }

  // --- PIN gate --------------------------------------------------------------

  /* The link to this page is meant to be forwarded, so arriving here proves
     nothing. Data is fetched first and the form only appears if the server
     says a PIN is missing — that way someone who already unlocked it in this
     browser goes straight to the report. */

  var token = new URLSearchParams(window.location.search).get('token');

  var formEl = document.getElementById('pin-form');
  var inputEl = document.getElementById('pin-input');
  var submitEl = document.getElementById('pin-submit');
  var pinErrorEl = document.getElementById('pin-error');

  function showGate(message) {
    contentEl.hidden = true;
    errorEl.hidden = true;
    gateEl.hidden = false;
    if (message) {
      pinErrorEl.textContent = message;
      pinErrorEl.hidden = false;
    } else {
      pinErrorEl.hidden = true;
    }
    inputEl.focus();
  }

  function readMessage(res, fallback) {
    return res
      .json()
      .then(function (body) {
        return (body && body.message) || fallback;
      })
      .catch(function () {
        return fallback;
      });
  }

  function loadDashboard() {
    return fetch('/api/monthly/' + encodeURIComponent(token), { credentials: 'same-origin' })
      .then(function (res) {
        if (res.status === 401) return showGate('');
        if (res.status === 503 || res.status === 429) {
          return readMessage(res, 'เปิดดูข้อมูลไม่ได้ตอนนี้').then(fail);
        }
        if (!res.ok) {
          return readMessage(
            res,
            res.status === 404 ? 'ลิงก์หมดอายุหรือไม่ถูกต้อง' : 'โหลดข้อมูลไม่สำเร็จ',
          ).then(fail);
        }
        return res.json().then(function (payload) {
          gateEl.hidden = true;
          render(payload);
        });
      })
      .catch(function (err) {
        fail(err.message || 'เกิดข้อผิดพลาด');
      });
  }

  formEl.addEventListener('submit', function (event) {
    event.preventDefault();
    var pin = inputEl.value;
    if (!pin) return;

    submitEl.disabled = true;
    pinErrorEl.hidden = true;

    fetch('/api/dashboard/pin', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pin }),
    })
      .then(function (res) {
        // Cleared either way: a wrong PIN should not be left on screen, and a
        // right one has already been exchanged for a cookie.
        inputEl.value = '';
        if (res.ok) return loadDashboard();
        return readMessage(res, 'PIN ไม่ถูกต้อง').then(showGate);
      })
      .catch(function () {
        showGate('ติดต่อเซิร์ฟเวอร์ไม่ได้ ลองใหม่อีกครั้ง');
      })
      .then(function () {
        submitEl.disabled = false;
      });
  });

  if (!token) {
    fail('ไม่พบ token — กรุณาเปิดจากปุ่มในแชท');
    return;
  }

  loadDashboard();
})();
