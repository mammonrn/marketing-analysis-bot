import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, parseEnvelope } from '../src/claude/envelope.js';

test('extracts a bare JSON object', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
});

test('extracts JSON from a ```json fence', () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('```\n{"a":1}\n```'), { a: 1 });
});

test('ignores prose around the object', () => {
  assert.deepEqual(extractJsonObject('นี่คือคำตอบครับ\n{"a":1}\nหวังว่าจะช่วยได้'), { a: 1 });
});

test('braces inside strings do not end the scan early', () => {
  const parsed = extractJsonObject('{"text":"ราคา {ไม่ระบุ} บาท","n":2}');
  assert.equal(parsed.text, 'ราคา {ไม่ระบุ} บาท');
  assert.equal(parsed.n, 2);
});

test('escaped quotes are handled', () => {
  const parsed = extractJsonObject('{"text":"เขาบอกว่า \\"ดี\\" นะ"}');
  assert.equal(parsed.text, 'เขาบอกว่า "ดี" นะ');
});

test('nested objects parse whole, not to the first closing brace', () => {
  const parsed = extractJsonObject('{"chart":{"type":"bar"},"show_chart":true}');
  assert.equal(parsed.chart.type, 'bar');
  assert.equal(parsed.show_chart, true);
});

test('returns null on unparseable input', () => {
  assert.equal(extractJsonObject('ไม่มี json เลย'), null);
  assert.equal(extractJsonObject('{"broken": '), null);
  assert.equal(extractJsonObject(null), null);
});

test('parseEnvelope normalises a well-formed reply', () => {
  const env = parseEnvelope(
    JSON.stringify({
      reply_markdown: '*RTP* 96.1% — ปกติ',
      site: 'shwe666',
      response_kind: 'metric',
      metrics: [{ name: 'RTP', value: '96.1%', status: 'ปกติ' }],
      show_chart: false,
      chart: null,
      data_gaps: [],
    }),
  );

  assert.equal(env.parseOk, true);
  assert.equal(env.replyMarkdown, '*RTP* 96.1% — ปกติ');
  assert.equal(env.site, 'shwe666');
  assert.equal(env.responseKind, 'metric');
  assert.equal(env.metrics[0].name, 'RTP');
  assert.equal(env.showChart, false);
});

test('falls back to text-only when JSON is absent — the spec default', () => {
  const env = parseEnvelope('ตอบเป็นข้อความเปล่า ๆ ไม่มี JSON');
  assert.equal(env.parseOk, false);
  assert.equal(env.replyMarkdown, 'ตอบเป็นข้อความเปล่า ๆ ไม่มี JSON');
  assert.equal(env.showChart, false);
  assert.equal(env.chart, null);
  assert.deepEqual(env.metrics, []);
});

test('show_chart is ignored unless the chart payload is usable', () => {
  const noChart = parseEnvelope(JSON.stringify({ reply_markdown: 'x', show_chart: true, chart: null }));
  assert.equal(noChart.showChart, false);

  const emptyLabels = parseEnvelope(
    JSON.stringify({
      reply_markdown: 'x',
      show_chart: true,
      chart: { type: 'bar', labels: [], datasets: [{ label: 'a', data: [1] }] },
    }),
  );
  assert.equal(emptyLabels.showChart, false, 'a chart with no labels is not renderable');

  const good = parseEnvelope(
    JSON.stringify({
      reply_markdown: 'x',
      show_chart: true,
      chart: { type: 'line', title: 'Revenue', labels: ['1', '2'], datasets: [{ label: 'R', data: [1, 2] }] },
    }),
  );
  assert.equal(good.showChart, true);
  assert.equal(good.chart.type, 'line');
});

test('an unknown site or kind degrades instead of propagating', () => {
  const env = parseEnvelope(
    JSON.stringify({ reply_markdown: 'x', site: 'casino-x', response_kind: 'invented' }),
  );
  assert.equal(env.site, null);
  assert.equal(env.responseKind, 'other');
});

test('non-numeric chart points become null rather than NaN', () => {
  const env = parseEnvelope(
    JSON.stringify({
      reply_markdown: 'x',
      show_chart: true,
      chart: { type: 'bar', labels: ['a', 'b'], datasets: [{ label: 'R', data: [1, 'ไม่มีข้อมูล'] }] },
    }),
  );
  assert.deepEqual(env.chart.datasets[0].data, [1, null]);
});
