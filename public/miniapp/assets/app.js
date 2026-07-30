/* Mini App renderer: fetch the summary payload for this token and draw it. */
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  var contentEl = document.getElementById('content');
  var errorEl = document.getElementById('error');

  function fail(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    contentEl.hidden = true;
  }

  /* Minimal Telegram-flavoured markdown: *bold* and `code`. Everything is
     inserted as text nodes, so payload content can never inject markup. */
  function renderInline(target, text) {
    target.textContent = '';
    var pattern = /(\*[^*\n]+\*|`[^`\n]+`)/g;
    var lastIndex = 0;
    var match;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        target.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      var token = match[0];
      var tag = token[0] === '*' ? 'strong' : 'code';
      var node = document.createElement(tag);
      node.textContent = token.slice(1, -1);
      target.appendChild(node);
      lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) {
      target.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function statusClass(status) {
    var s = String(status || '');
    if (s.indexOf('วิกฤต') !== -1) return 'critical';
    if (s.indexOf('เตือน') !== -1) return 'warn';
    if (s.indexOf('ดี') !== -1) return 'good';
    if (s.indexOf('ปกติ') !== -1) return 'normal';
    return '';
  }

  /* Categorical palette: distinct hues at similar lightness so no series reads
     as more important than another, and all stay legible on light or dark. */
  var PALETTE = ['#3b7dd8', '#e08a3c', '#3aa675', '#b45fc4', '#d4576a', '#4aa3c4'];

  function cssVar(name, fallback) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (value && value.trim()) || fallback;
  }

  function drawChart(chart) {
    var card = document.getElementById('chart-card');
    if (!chart || !chart.labels || !chart.datasets || !chart.datasets.length) return;

    document.getElementById('chart-title').textContent = chart.title || 'กราฟ';
    card.hidden = false;

    var isRound = chart.type === 'doughnut' || chart.type === 'pie';
    var fg = cssVar('--fg', '#1c1c1e');
    var muted = cssVar('--muted', '#8e8e93');
    var gridColor = muted + '33';

    var datasets = chart.datasets.map(function (set, i) {
      var color = PALETTE[i % PALETTE.length];
      if (isRound) {
        return {
          label: set.label,
          data: set.data,
          backgroundColor: chart.labels.map(function (_, j) {
            return PALETTE[j % PALETTE.length];
          }),
          borderWidth: 0,
        };
      }
      return {
        label: set.label,
        data: set.data,
        backgroundColor: chart.type === 'line' ? color + '26' : color,
        borderColor: color,
        borderWidth: 2,
        tension: 0.3,
        pointRadius: chart.labels.length > 20 ? 0 : 3,
        fill: chart.type === 'line',
      };
    });

    new Chart(document.getElementById('chart'), {
      type: chart.type || 'bar',
      data: { labels: chart.labels, datasets: datasets },
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
                return item.dataset.label + ': ' + Number(v).toLocaleString('en-US');
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
                    return Number(v).toLocaleString('en-US');
                  },
                },
                grid: { color: gridColor },
              },
            },
      },
    });
  }

  function renderMetrics(metrics) {
    if (!metrics || !metrics.length) return;

    /* Same metric asked twice in a session should appear once, latest wins. */
    var seen = Object.create(null);
    var unique = [];
    for (var i = metrics.length - 1; i >= 0; i--) {
      var m = metrics[i];
      if (!m || !m.name || seen[m.name]) continue;
      seen[m.name] = true;
      unique.unshift(m);
    }

    var body = document.getElementById('metrics-body');
    unique.forEach(function (metric) {
      var tr = document.createElement('tr');

      var name = document.createElement('td');
      name.textContent = metric.name;

      var value = document.createElement('td');
      value.className = 'value';
      value.textContent = metric.value || '—';

      var status = document.createElement('td');
      if (metric.status) {
        var badge = document.createElement('span');
        badge.className = 'badge ' + statusClass(metric.status);
        badge.textContent = metric.status;
        status.appendChild(badge);
      } else {
        status.textContent = '—';
      }

      tr.appendChild(name);
      tr.appendChild(value);
      tr.appendChild(status);
      body.appendChild(tr);
    });

    document.getElementById('metrics-card').hidden = false;
  }

  function render(payload) {
    if (payload.sites && payload.sites.length) {
      document.getElementById('title').textContent = 'สรุป ' + payload.sites.join(' / ');
      document.getElementById('meta-sites').textContent = 'เว็บ: ' + payload.sites.join(', ');
    }
    if (payload.turnCount) {
      document.getElementById('meta-turns').textContent = payload.turnCount + ' คำถาม';
    }
    if (payload.generatedAt) {
      var d = new Date(payload.generatedAt);
      document.getElementById('meta-time').textContent = d.toLocaleString('th-TH', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    }

    renderInline(document.getElementById('summary'), payload.summaryText || '');
    drawChart(payload.chart);
    renderMetrics(payload.metrics);

    contentEl.hidden = false;
  }

  var token = new URLSearchParams(window.location.search).get('token');
  if (!token) {
    fail('ไม่พบ token — กรุณาเปิดจากปุ่มในแชท');
    return;
  }

  fetch('/api/summary/' + encodeURIComponent(token))
    .then(function (res) {
      if (!res.ok) throw new Error(res.status === 404 ? 'ลิงก์หมดอายุหรือไม่ถูกต้อง' : 'โหลดข้อมูลไม่สำเร็จ');
      return res.json();
    })
    .then(render)
    .catch(function (err) {
      fail(err.message || 'เกิดข้อผิดพลาด');
    });
})();
