/* Monthly dashboard renderer.
 *
 * Generic on purpose: it knows about `kpis`, `charts` and `tables` and about
 * the unit tags the payload puts on each figure, and about nothing else. Every
 * casino metric lives in `src/session/monthlyReport.js`, so adding a section
 * there needs no change here.
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

  /* Chart instances of the tab being replaced. Chart.js keeps a registry keyed
     by canvas, so leaving these attached leaks a listener per tab switch and
     eventually refuses to draw onto a canvas it thinks is still in use. */
  var liveCharts = [];

  function fail(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    contentEl.hidden = true;
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
    'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
  ];

  /* `2026-07` → `ก.ค. 2026`. Formatted here rather than in the payload so the
     builder stays a data module — and it has to match what the chat message
     said, or the page looks like it opened a different month. */
  function monthLabel(yearMonth) {
    var match = /^(\d{4})-(\d{2})$/.exec(String(yearMonth || ''));
    if (!match) return String(yearMonth || '');
    var month = THAI_MONTHS[Number(match[2]) - 1];
    return month ? month + ' ' + match[1] : String(yearMonth);
  }

  // --- pieces ----------------------------------------------------------------

  function renderKpis(kpis) {
    if (!kpis || !kpis.length) return null;

    var card = el('section');
    card.appendChild(el('h2', null, 'ตัวเลขสำคัญ'));
    var grid = el('div', 'kpis');

    kpis.forEach(function (kpi) {
      var cell = el('div');
      cell.appendChild(el('div', 'kpi-label', kpi.label));
      cell.appendChild(el('div', 'kpi-value', formatValue(kpi.value, kpi.unit)));
      if (kpi.hint) cell.appendChild(el('div', 'kpi-hint', kpi.hint));
      grid.appendChild(cell);
    });

    card.appendChild(grid);
    return card;
  }

  /* Categorical palette: distinct hues at similar lightness so no series reads
     as more important than another, and all stay legible on light or dark.
     Same set as the session dashboard, so the two pages look like one product. */
  var PALETTE = ['#3b7dd8', '#e08a3c', '#3aa675', '#b45fc4', '#d4576a', '#4aa3c4'];

  function cssVar(name, fallback) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (value && value.trim()) || fallback;
  }

  function renderChart(spec) {
    if (!spec || !spec.labels || !spec.labels.length || !spec.datasets || !spec.datasets.length) {
      return null;
    }

    var card = el('section');
    card.appendChild(el('h2', null, spec.title || 'กราฟ'));

    var scroll = el('div', 'scroll-x');
    var box = el('div', 'chart-box');
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
      return {
        label: set.label,
        data: set.data,
        backgroundColor: spec.type === 'line' ? color + '26' : color,
        borderColor: color,
        borderWidth: 2,
        tension: 0.3,
        pointRadius: spec.labels.length > 20 ? 0 : 3,
        fill: spec.type === 'line' && spec.datasets.length === 1,
      };
    });

    var chart = new Chart(canvas, {
      type: spec.type || 'bar',
      data: { labels: spec.labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: datasets.length > 1 || isRound,
            labels: { color: fg, boxWidth: 12, usePointStyle: true },
          },
          tooltip: {
            callbacks: {
              label: function (item) {
                var v = item.parsed.y !== undefined ? item.parsed.y : item.parsed;
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
          : {
              x: { ticks: { color: muted, maxRotation: 0, autoSkip: true }, grid: { display: false } },
              y: {
                ticks: {
                  color: muted,
                  callback: function (v) {
                    return formatValue(v, unit);
                  },
                },
                grid: { color: muted + '33' },
              },
            },
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
      return card;
    }

    var scroll = el('div', 'scroll-x');
    var table = el('table');

    var thead = el('thead');
    var headRow = el('tr');
    spec.columns.forEach(function (column) {
      var th = el('th', NUMERIC_UNITS[column.unit] ? 'num' : null, column.label);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    spec.rows.forEach(function (row) {
      var tr = el('tr');
      spec.columns.forEach(function (column) {
        tr.appendChild(
          el('td', NUMERIC_UNITS[column.unit] ? 'num' : null, formatValue(row[column.key], column.unit)),
        );
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
          (section.reason || 'ไม่มีข้อมูล') + ' — ไฟล์ที่ต้องใช้: ' + (section.fileLabel || section.fileType),
        ),
      );
      panelEl.appendChild(card);
      return;
    }

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

    if (!panelEl.firstChild) {
      var blank = el('section');
      blank.appendChild(el('h2', null, section.title));
      blank.appendChild(el('div', 'empty-state', 'ไฟล์นี้อ่านได้ แต่ไม่มีตัวเลขที่แสดงได้'));
      panelEl.appendChild(blank);
    }
  }

  function buildTabs(sections) {
    var buttons = [];

    sections.forEach(function (section, index) {
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
        /* Keep the tapped tab visible when the strip is scrolled. */
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
      buttons.push(button);
      tabsEl.appendChild(button);
      if (index === 0) button.setAttribute('aria-selected', 'true');
    });

    return buttons;
  }

  function render(payload) {
    if (payload.kind !== 'monthly') {
      fail('ลิงก์นี้เป็นสรุป session ไม่ใช่สรุปเดือน — เปิดจากปุ่ม "ดูกราฟ" ในแชทแทนครับ');
      return;
    }

    document.getElementById('title').textContent =
      'สรุปเดือน ' + monthLabel(payload.yearMonth) + ' — ' + (payload.siteName || '');
    document.title = 'สรุปเดือน ' + monthLabel(payload.yearMonth);

    if (payload.currency) {
      var c = payload.currency;
      document.getElementById('meta-currency').textContent = c.needsFxConversion
        ? 'สกุลเงิน ' + c.currency + ' → THB (อัตรา ' + c.fxRate + ' ณ ' + c.fxRateAsOf + ')'
        : 'สกุลเงิน ' + c.currency + ' (เป็นบาทอยู่แล้ว)';
    }

    if (payload.generatedAt) {
      document.getElementById('meta-time').textContent = new Date(
        payload.generatedAt,
      ).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
    }

    var sections = payload.sections || [];
    if (!sections.length) {
      fail('ไม่มีข้อมูลในเดือนนี้');
      return;
    }

    buildTabs(sections);
    /* Open on the first tab that actually has something in it, so a month
       missing its Daily Value file does not greet the user with an empty page. */
    var first = sections.filter(function (section) {
      return section.available;
    })[0];
    if (first) {
      var index = sections.indexOf(first);
      tabsEl.children[0].setAttribute('aria-selected', 'false');
      tabsEl.children[index].setAttribute('aria-selected', 'true');
      showSection(first);
    } else {
      showSection(sections[0]);
    }

    if (payload.missingFiles && payload.missingFiles.length) {
      var list = document.getElementById('missing-list');
      payload.missingFiles.forEach(function (entry) {
        list.appendChild(el('li', null, entry.label));
      });
      document.getElementById('missing-card').hidden = false;
    }

    contentEl.hidden = false;
  }

  var token = new URLSearchParams(window.location.search).get('token');
  if (!token) {
    fail('ไม่พบ token — กรุณาเปิดจากปุ่มในแชท');
    return;
  }

  fetch('/api/summary/' + encodeURIComponent(token))
    .then(function (res) {
      if (!res.ok) {
        throw new Error(res.status === 404 ? 'ลิงก์หมดอายุหรือไม่ถูกต้อง' : 'โหลดข้อมูลไม่สำเร็จ');
      }
      return res.json();
    })
    .then(render)
    .catch(function (err) {
      fail(err.message || 'เกิดข้อผิดพลาด');
    });
})();
