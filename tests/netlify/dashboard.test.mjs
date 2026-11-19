import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const markup = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../web/app.js', import.meta.url), 'utf8');
async function settle(predicate) {
  for (let i = 0; i < 30; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(predicate(), 'Dashboard did not finish the requested update');
}
function dashboard({ local = false } = {}) {
  const dom = new JSDOM(markup, { url: 'https://trustrag.example', runScripts: 'outside-only' });
  const { window } = dom;
  window.scrollTo = () => {};
  const calls = [];
  const report = { scan_id: 'scan1', document_id: 'doc1', filename: 'notes.txt', total_passages: 1, quarantined_count: 0, retained_count: 1, risk_score: .12, findings: [{ line: 1, status: 'retained', text: '<script>unsafe markup</script>', signals: [] }], cleaned_text_preview: 'Retained evidence.', download_url: '/api/scans/scan1/cleaned.txt' };
  window.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    let data = {};
    if (url === '/api/health') data = { version: '3.0.0', ...(local ? {} : { runtime: 'Netlify Server' }), gpu: { cuda: false }, device_selected: 'cpu' };
    else if (url === '/api/documents') data = { documents: [{ ...report, findings: undefined, cleaned_text_preview: undefined }] };
    else if (url === '/api/queries?limit=100') data = { count: 4, queries: [] };
    else if (url === '/api/dataset/status') data = { loaded: false, records_loaded: 0 };
    else if (url === '/api/dataset/evaluation') data = { mrr_at_10: .5, hit_rate_at_10: .5, coverage_rate: .5, evaluated_queries: 2, notice: 'Saved evaluation.' };
    else if (url === '/api/experiments/results') data = { available: true, summary: {}, record_count: 12 };
    else if (url === '/api/scans/scan1') data = options.method === 'DELETE' ? { deleted: true } : report;
    else if (url === '/api/query') data = { answer: 'Evidence-based answer.', corpus: 'uploaded documents', evidence: [], quarantined_count: 0, healing_rounds: 0, trace: [], attributions: [] };
    else if (url === '/api/dataset/load') data = { loaded: true, records_loaded: 2 };
    return { ok: true, status: 200, json: async () => data };
  };
  window.eval(script);
  return { window, document: window.document, calls, close: () => dom.window.close() };
}

test('dashboard restores saved state, opens full reports, escapes content, and deletes scans', async () => {
  const ui = dashboard();
  try {
    await settle(() => ui.document.querySelector('#statDocs').textContent === '1');
    assert.equal(ui.document.querySelector('#statQueries').textContent, '4');
    assert.equal(ui.document.querySelector('#datasetPath').hidden, true);
    await settle(() => ui.document.querySelector('#rankingResults').textContent.includes('Saved evaluation.'));
    ui.document.querySelector('[data-scan-open]').click();
    await settle(() => ui.document.querySelector('#scanDetail').textContent.includes('unsafe markup'));
    assert.equal(ui.document.querySelector('#scanDetail script'), null);
    assert.match(ui.document.querySelector('.cleaned-preview').textContent, /Retained evidence/);
    ui.document.querySelector('[data-delete-scan]').click();
    await settle(() => ui.document.querySelector('#statDocs').textContent === '0');
    assert.ok(ui.calls.some(c => c.options.method === 'DELETE'));
  } finally { ui.close(); }
});
test('dashboard sends query options and renders the grounded answer', async () => {
  const ui = dashboard();
  try {
    await settle(() => ui.document.querySelector('#statDocs').textContent === '1');
    ui.document.querySelector('#queryInput').value = 'What is retrieval?';
    ui.document.querySelector('#runQueryBtn').click();
    await settle(() => ui.document.querySelector('#queryResult').textContent.includes('Evidence-based answer.'));
    const payload = JSON.parse(ui.calls.find(c => c.url === '/api/query').options.body);
    assert.equal(payload.heal, true);
    assert.equal(payload.query, 'What is retrieval?');
  } finally { ui.close(); }
});
test('local Python mode keeps its dataset path request contract', async () => {
  const ui = dashboard({ local: true });
  try {
    await settle(() => ui.document.querySelector('#statDocs').textContent === '1');
    assert.equal(ui.document.querySelector('#datasetPath').hidden, false);
    assert.equal(ui.document.querySelector('#datasetFile').hidden, true);
    ui.document.querySelector('#datasetPath').value = '/tmp/collection.tsv';
    ui.document.querySelector('#loadDatasetBtn').click();
    await settle(() => ui.calls.some(c => c.url === '/api/dataset/load'));
    const payload = JSON.parse(ui.calls.find(c => c.url === '/api/dataset/load').options.body);
    assert.equal(payload.path, '/tmp/collection.tsv');
  } finally { ui.close(); }
});
