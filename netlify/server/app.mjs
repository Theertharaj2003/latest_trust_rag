import express from 'express';
import multer from 'multer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import experiment from '../../results/rag_experiment.json' with { type: 'json' };
import { scanText, chunkDocument, demoChunks, runQuery, parsePassages, evaluate, InputError } from './research.mjs';
import { extractDocument } from './extract.mjs';

const MB = 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * MB, files: 2, fields: 4, fieldSize: 1000, parts: 6 } });
const emptyDataset = () => ({ loaded: false, dataset: 'MS MARCO Passage Ranking', source: 'https://microsoft.github.io/msmarco/Datasets', records_loaded: 0, path: '', max_records: 0, message: 'Upload a bounded passage sample to begin.' });
const scanNotice = 'This is a heuristic suspicious-content scan, not a guarantee of factual correctness or a malware scan. Review quarantined passages before relying on the cleaned text.';
function integer(value, fallback, max, name) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new InputError(`${name} must be between 1 and ${max}.`);
  return n;
}
function textFile(file, max = 10 * MB) {
  if (!file?.buffer?.length) throw new InputError('Select a non-empty UTF-8 text file.', 400);
  if (file.size > max) throw new InputError(`File exceeds ${max / MB} MB.`, 413);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(file.buffer); }
  catch { throw new InputError('Files must be UTF-8 encoded.'); }
}
function scanResponse(row) {
  return { ...row.report, cleaned_text_preview: row.cleanedText.slice(0, 5000), download_url: `/api/scans/${row.report.scan_id}/cleaned.txt`, report_url: `/api/scans/${row.report.scan_id}`, notice: scanNotice };
}

export function createApp(repo, { secureCookies = !!process.env.NETLIFY } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ detail: 'Cross-site requests are not allowed.' });
      const origin = req.get('origin');
      if (origin) {
        try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ detail: 'Use the API from this site.' }); }
        catch { return res.status(403).json({ detail: 'Invalid origin.' }); }
      }
    }
    // An opaque browser workspace isolates visitors without a public shared corpus.
    // Only its hash is stored in the database. No process memory is used as storage.
    let token = (req.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith('trustrag_workspace='))?.split('=')[1];
    if (!/^[a-f0-9]{64}$/.test(token || '')) {
      token = randomBytes(32).toString('hex');
      res.cookie('trustrag_workspace', token, { httpOnly: true, sameSite: 'strict', secure: secureCookies, maxAge: 365 * 86400000, path: '/' });
    }
    req.workspace = createHash('sha256').update(token).digest('hex');
    next();
  });
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', async (req, res) => {
    const rows = await repo.listDocuments(req.workspace);
    res.json({ status: 'ok', service: 'TrustRAG', version: '3.0.0', runtime: 'Netlify Server', retrieval: 'BM25 + TF-IDF cosine', verification: 'lexical heuristic', device_selected: 'cpu', gpu: { cuda: false, available: false, name: 'Netlify CPU runtime' }, storage: 'Netlify Database', documents_loaded: rows.length, timestamp: new Date().toISOString() });
  });
  app.post('/api/documents/scan', upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file?.size) throw new InputError('Choose a non-empty document.', 400);
    const filename = basename(file.originalname.replaceAll('\\', '/'));
    const existing = await repo.listDocuments(req.workspace);
    if (existing.length >= 100) throw new InputError('This workspace has reached the 100-document limit. Delete a document before adding another.', 409);
    const text = await extractDocument(filename, file.buffer);
    if (text.trim().length < 8) throw new InputError('Too little extractable text. Scanned-image PDFs need OCR, which is not enabled.');
    if (text.length > 2000000 || text.split('\n').length > 10000) throw new InputError('Use a document with at most 2 million characters and 10,000 lines.', 413);
    const { cleaned_text, ...scan } = scanText(text);
    const existingChars = existing.reduce((n, row) => n + row.cleanedText.length, 0);
    if (existingChars + cleaned_text.length > 4000000) throw new InputError('Retained corpus exceeds 4 million characters. Delete documents before adding another.', 413);
    const report = { ...scan, scan_id: randomUUID(), document_id: randomUUID(), filename, title: filename.slice(0, -extname(filename).length), sha256: createHash('sha256').update(file.buffer).digest('hex'), created_at: new Date().toISOString() };
    await repo.addDocument(req.workspace, report, cleaned_text);
    res.json(scanResponse({ report, cleanedText: cleaned_text }));
  });
  app.get('/api/documents', async (req, res) => {
    const rows = await repo.listDocuments(req.workspace);
    res.json({ documents: rows.map(row => { const { findings, ...report } = row.report; return report; }) });
  });
  app.get('/api/scans/:id', async (req, res) => {
    const row = await repo.getDocument(req.workspace, req.params.id);
    if (!row) throw new InputError('Scan not found in this browser workspace.', 404);
    res.json(scanResponse(row));
  });
  app.get('/api/scans/:id/cleaned.txt', async (req, res) => {
    const row = await repo.getDocument(req.workspace, req.params.id);
    if (!row) throw new InputError('Scan not found in this browser workspace.', 404);
    const name = row.report.filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
    res.attachment(`${name}_reviewed_cleaned.txt`).type('text/plain').send(row.cleanedText);
  });
  app.delete('/api/scans/:id', async (req, res) => {
    await repo.deleteDocument(req.workspace, req.params.id);
    res.json({ deleted: true });
  });
  app.post('/api/query', async (req, res) => {
    const payload = req.body || {}, query = typeof payload.query === 'string' ? payload.query.trim() : '';
    if (query.length < 3 || query.length > 2000) throw new InputError('Enter a question between 3 and 2,000 characters.');
    for (const key of ['heal', 'use_demo_corpus', 'use_msmarco']) if (payload[key] !== undefined && typeof payload[key] !== 'boolean') throw new InputError(`${key} must be a boolean.`);
    let chunks, corpus;
    if (payload.use_msmarco) {
      const dataset = await repo.getDataset(req.workspace);
      if (!dataset?.passages.length) throw new InputError('Upload an MS MARCO sample in Dataset Lab first.');
      chunks = dataset.passages;
      corpus = `MS MARCO (${chunks.length.toLocaleString()} uploaded passages)`;
    } else {
      const rows = payload.use_demo_corpus ? [] : await repo.listDocuments(req.workspace);
      chunks = rows.length ? rows.flatMap(row => chunkDocument(row.report.document_id, row.cleanedText, row.report.filename)) : demoChunks();
      corpus = rows.length ? 'uploaded documents (retained passages only)' : 'controlled demo corpus';
    }
    if (chunks.length > 12000) throw new InputError('Corpus exceeds 12,000 retrieval chunks. Remove documents or use a smaller dataset.');
    const result = { query_id: randomUUID(), query, corpus, ...runQuery(chunks, query, payload.heal ?? true), timestamp: new Date().toISOString(), notice: 'CPU research fallback: BM25 + TF-IDF cosine, lexical reranking and verification, and extractive answers. No neural embedding, NLI, GPU or generative model ran. Heuristic scores do not prove factual correctness.' };
    await repo.addQuery(req.workspace, result);
    res.json(result);
  });
  app.get('/api/queries', async (req, res) => {
    const rows = await repo.listQueries(req.workspace, integer(req.query.limit, 20, 100, 'limit'));
    res.json({ count: rows.length, queries: rows.map(({ query_id, query, corpus, timestamp, quarantined_count }) => ({ query_id, query, corpus, timestamp, quarantined_count })) });
  });
  app.get('/api/dataset/status', async (req, res) => res.json((await repo.getDataset(req.workspace))?.info || emptyDataset()));
  app.post(['/api/dataset/load', '/api/dataset/upload'], upload.single('file'), async (req, res) => {
    const max = integer(req.body?.max_records, 10000, 10000, 'max_records');
    const passages = parsePassages(textFile(req.file, 15 * MB), max);
    const info = { ...emptyDataset(), loaded: true, dataset_id: randomUUID(), records_loaded: passages.length, path: basename(req.file.originalname.replaceAll('\\', '/')), max_records: max, message: 'This bounded sample is saved to your browser workspace in Netlify Database. MS MARCO provides ranking data, not poisoning ground truth.' };
    await repo.saveDataset(req.workspace, info, passages);
    res.json(info);
  });
  app.post('/api/dataset/unload', async (req, res) => { await repo.deleteDataset(req.workspace); res.json(emptyDataset()); });
  app.post('/api/dataset/evaluate', upload.fields([{ name: 'queries_file', maxCount: 1 }, { name: 'qrels_file', maxCount: 1 }]), async (req, res) => {
    const dataset = await repo.getDataset(req.workspace);
    if (!dataset?.passages.length) throw new InputError('Upload an MS MARCO passage sample first.');
    const max = integer(req.query.max_queries, 50, 100, 'max_queries');
    const result = evaluate(dataset.passages, textFile(req.files?.queries_file?.[0]), textFile(req.files?.qrels_file?.[0]), max);
    if (!await repo.saveEvaluation(req.workspace, dataset.info.dataset_id, result)) throw new InputError('The dataset changed during evaluation. Run it again.', 409);
    res.json(result);
  });
  app.get('/api/dataset/evaluation', async (req, res) => res.json((await repo.getDataset(req.workspace))?.evaluation || { available: false, message: 'No evaluation has been saved for this dataset.' }));
  app.get('/api/experiments/results', (req, res) => res.json({ available: true, summary: experiment.summary, record_count: experiment.records.length, source: 'Bundled Python controlled experiment output (historical; not recomputed by this runtime)' }));
  app.get('/api/openapi-note', (req, res) => res.json({ docs: '/docs', note: 'Netlify CPU API. See documentation for upload limits and the Python fallback port.' }));
  app.use('/api', (req, res) => res.status(404).json({ detail: 'API endpoint not found.' }));
  app.get(['/docs', '/redoc'], (req, res) => res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>TrustRAG API</title><body><h1>TrustRAG API · Netlify CPU runtime</h1><p>Use the <a href="/">dashboard</a> to scan documents, query evidence and evaluate dataset samples. Requests use a private, anonymous browser workspace cookie. Clearing the cookie loses access to that workspace.</p><p>Deterministic BM25 + TF-IDF retrieval, lexical verification and extractive answers. No GPU or learned models run here.</p><ul><li>GET /api/health</li><li>GET /api/documents</li><li>POST /api/documents/scan — multipart file (PDF/DOCX/TXT/MD, 15 MB; extracted text 2 million characters)</li><li>GET /api/scans/:id</li><li>DELETE /api/scans/:id</li><li>GET /api/scans/:id/cleaned.txt</li><li>POST /api/query — JSON {query, heal, use_demo_corpus, use_msmarco}</li><li>GET /api/queries?limit=20</li><li>GET /api/dataset/status</li><li>POST /api/dataset/load — multipart file (UTF-8 TSV, 15 MB) and max_records (1–10,000). Dashboard samples larger files and decompresses archives in the browser.</li><li>POST /api/dataset/unload</li><li>POST /api/dataset/evaluate?max_queries=50 — multipart queries_file and qrels_file (10 MB each, up to 100 queries)</li><li>GET /api/dataset/evaluation</li><li>GET /api/experiments/results — historical bundled Python demo metrics</li></ul><p>Document and dataset limits keep processing bounded. Uploaded original files are unchanged on your computer; extracted reports and retained text are saved, not the original binaries.</p></body></html>`));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ detail: 'Upload limit exceeded or unexpected field. Documents/samples: 15 MB; evaluation files: 10 MB each.' });
    if (err instanceof InputError) return res.status(err.status).json({ detail: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ detail: 'Invalid JSON body.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ detail: 'Request body is too large.' });
    // Never log request content, credentials, or database errors containing parameters.
    console.error('TrustRAG request failed:', err.name || 'Error');
    res.status(503).json({ detail: 'The service is temporarily unavailable. Retry shortly; if this is a new deploy, check that database migrations completed.' });
  });
  return app;
}
