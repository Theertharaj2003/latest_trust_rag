import express from 'express';
import multer from 'multer';
import { randomUUID, createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { TextDecoder } from 'node:util';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { scanText, chunksFromDocuments, demoChunks, queryPipeline, parsePassages, evaluate } from './pipeline.mjs';

const MAX_BYTES = 15 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 2, fields: 5, fieldSize: 1024 } });
const decode = buffer => { try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw httpError(422, 'Text files must use UTF-8 encoding.'); } };
const httpError = (status, message) => Object.assign(new Error(message), { status });
const integer = (value, fallback, max) => { const n = value === undefined ? fallback : Number(value); if (!Number.isInteger(n) || n < 1 || n > max) throw httpError(422, `Value must be an integer between 1 and ${max}.`); return n; };
const emptyDataset = () => ({ loaded: false, dataset: 'MS MARCO Passage Ranking', source: 'https://microsoft.github.io/msmarco/Datasets', records_loaded: 0, path: '', max_records: 0, message: 'Upload an extracted UTF-8 collection TSV sample (up to 15 MB and 10,000 passages).' });
const datasetSummary = d => { const { chunks, ...summary } = d; return summary; };
const publicDocument = d => { const { original_text, cleaned_text, findings, ...summary } = d; return summary; };
const scanResponse = d => ({ ...publicDocument(d), findings: d.findings, cleaned_text_preview: d.cleaned_text.slice(0,5000), download_url: `/api/scans/${d.scan_id}/cleaned.txt`, report_url: `/api/scans/${d.scan_id}`, notice: 'This is a heuristic suspicious-content scan, not a guarantee of factual correctness or a malware scan. Review quarantined passages before relying on the output.' });

export function createApp(store) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const existing = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('trustrag_workspace='))?.split('=')[1];
    req.workspace = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(existing || '') ? existing : randomUUID();
    if (req.workspace !== existing) res.cookie('trustrag_workspace', req.workspace, { httpOnly: true, secure: process.env.NODE_ENV !== 'test', sameSite: 'lax', maxAge: 365 * 86400000, path: '/' });
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ detail: 'Cross-site requests are not allowed.' });
    next();
  });
  app.get('/api/health', async (req,res) => {
    const docs = await store.list(req.workspace,'document');
    res.json({ status: 'ok', service: 'TrustRAG', version: '3.0.0', device_selected: 'cpu', gpu: { available: false, cuda: false, name: 'CPU · deterministic lexical pipeline' }, documents_loaded: docs.length, timestamp: new Date().toISOString() });
  });
  app.post('/api/documents/scan', upload.single('file'), async (req,res) => {
    if (!req.file) throw httpError(422,'Choose a file to scan.');
    const filename = basename(req.file.originalname.replaceAll('\\','/')), extension = extname(filename).toLowerCase();
    if (!['.pdf','.docx','.txt','.md'].includes(extension)) throw httpError(415,'Upload PDF, DOCX, TXT or Markdown.');
    if (!req.file.size) throw httpError(400,'The uploaded file is empty.');
    const docs = await store.list(req.workspace,'document');
    if (docs.length >= 100 || docs.reduce((n,d) => n + d.original_text.length, 0) > 2000000) throw httpError(413,'Workspace corpus limit reached (100 documents or 2 million extracted characters).');
    let text;
    try {
      if (extension === '.pdf') {
        const parser = new PDFParse({ data: req.file.buffer, isEvalSupported: false });
        try { text = (await parser.getText({ pageJoiner: '' })).text; } finally { await parser.destroy(); }
      }
      else if (extension === '.docx') text = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
      else text = decode(req.file.buffer);
    } catch (error) { if (error.status) throw error; throw httpError(422,'Unable to extract this document. Use an unencrypted, valid PDF/DOCX or UTF-8 text file.'); }
    if (text.trim().length < 8) throw httpError(422,'Too little extractable text. Scanned-image PDFs need OCR, which is not enabled.');
    if (text.length > 500000 || text.split(/\r?\n/).length > 10000) throw httpError(413,'Extracted document exceeds 500,000 characters or 10,000 lines. Upload a smaller sample.');
    const scan_id = randomUUID(), document_id = randomUUID();
    const record = { document_id, scan_id, filename, title: basename(filename,extension), sha256: createHash('sha256').update(req.file.buffer).digest('hex'), original_text: text, created_at: new Date().toISOString(), ...scanText(text) };
    await store.put(req.workspace,'document',scan_id,record);
    res.json(scanResponse(record));
  });
  app.get('/api/documents', async (req,res) => res.json({ documents: (await store.list(req.workspace,'document')).map(publicDocument) }));
  app.get('/api/scans/:id', async (req,res) => {
    const d = await store.get(req.workspace,'document',req.params.id); if (!d) throw httpError(404,'Scan not found in this workspace.'); res.json(scanResponse(d));
  });
  app.get('/api/scans/:id/cleaned.txt', async (req,res) => {
    const d = await store.get(req.workspace,'document',req.params.id); if (!d) throw httpError(404,'Scan not found in this workspace.');
    res.attachment(basename(d.filename,extname(d.filename)) + '_reviewed_cleaned.txt').type('text/plain').send(d.cleaned_text);
  });
  app.post('/api/query', async (req,res) => {
    const { query, heal = true, use_demo_corpus = false, use_msmarco = false } = req.body || {};
    if (typeof query !== 'string' || query.trim().length < 3 || query.length > 2000) throw httpError(422,'Enter a question between 3 and 2,000 characters.');
    if ([heal,use_demo_corpus,use_msmarco].some(v => typeof v !== 'boolean')) throw httpError(422,'Query options must be booleans.');
    let chunks, corpus;
    if (use_msmarco) {
      const d = await store.get(req.workspace,'dataset','current'); if (!d?.loaded) throw httpError(422,'Upload an MS MARCO sample in Dataset Lab first.'); chunks = d.chunks; corpus = `MS MARCO passage collection (${chunks.length} loaded passages)`;
    } else {
      const documents = await store.list(req.workspace,'document');
      chunks = use_demo_corpus || !documents.length ? demoChunks : chunksFromDocuments(documents);
      corpus = use_demo_corpus || !documents.length ? 'controlled demo corpus' : 'uploaded documents (retained passages only)';
    }
    if (!chunks.length) throw httpError(422,'No retained text is available. Upload another document or use the demo corpus.');
    const result = { query_id: randomUUID(), query: query.trim(), corpus, ...queryPipeline(query.trim(),chunks,heal), timestamp: new Date().toISOString(), notice: 'CPU heuristic pipeline: BM25 + unigram TF-IDF, lexical reranking and verification. No learned models or GPU inference are used. Scores do not prove factual correctness.' };
    await store.put(req.workspace,'query',result.query_id,result); res.json(result);
  });
  app.get('/api/queries', async (req,res) => {
    const rows = await store.list(req.workspace,'query',integer(req.query.limit,20,100));
    res.json({ count: rows.length, queries: rows.map(({query_id,query,corpus,timestamp,quarantined_count}) => ({query_id,query,corpus,timestamp,quarantined_count})) });
  });
  app.get('/api/dataset/status', async (req,res) => res.json(datasetSummary(await store.get(req.workspace,'dataset','current') || emptyDataset())));
  app.post('/api/dataset/load', upload.single('file'), async (req,res) => {
    if (!req.file) throw httpError(422,'Upload an extracted collection TSV/TXT sample; server filesystem paths are not supported.');
    if (!/\.(tsv|txt)$/i.test(req.file.originalname)) throw httpError(415,'Upload an extracted UTF-8 TSV or TXT sample.');
    const max_records = integer(req.body.max_records,1000,10000), chunks = parsePassages(decode(req.file.buffer),max_records);
    if (!chunks.length) throw httpError(422,'No valid pid<TAB>passage records were found.');
    const d = { ...emptyDataset(), loaded: true, records_loaded: chunks.length, max_records, path: basename(req.file.originalname.replaceAll('\\','/')), revision: randomUUID(), message: 'Sample saved to your workspace. MS MARCO relevance labels are not poisoning labels.', chunks };
    await store.put(req.workspace,'dataset','current',d); await store.remove(req.workspace,'benchmark','current'); res.json(datasetSummary(d));
  });
  app.post('/api/dataset/unload', async (req,res) => { await store.remove(req.workspace,'dataset','current'); await store.remove(req.workspace,'benchmark','current'); res.json(emptyDataset()); });
  app.post('/api/dataset/evaluate', upload.fields([{name:'queries_file',maxCount:1},{name:'qrels_file',maxCount:1}]), async (req,res) => {
    const max = integer(req.query.max_queries,50,100), d = await store.get(req.workspace,'dataset','current');
    if (!d?.loaded) throw httpError(422,'Load MS MARCO passages first.');
    const q = req.files?.queries_file?.[0], r = req.files?.qrels_file?.[0];
    if (!q || !r) throw httpError(422,'Upload both queries and qrels files.');
    if (q.size > 10*1024*1024 || r.size > 10*1024*1024) throw httpError(413,'Each evaluation file must be at most 10 MB.');
    let result; try { result = evaluate(d.chunks,decode(q.buffer),decode(r.buffer),max); } catch (e) { throw httpError(422,e.message); }
    await store.put(req.workspace,'benchmark','current',{ ...result, dataset_revision: d.revision }); res.json(result);
  });
  app.get('/api/dataset/evaluation', async (req,res) => {
    const [b,d] = await Promise.all([store.get(req.workspace,'benchmark','current'),store.get(req.workspace,'dataset','current')]);
    res.json(b && b.dataset_revision === d?.revision ? b : {available:false,message:'No ranking evaluation exists for the current dataset.'});
  });
  app.get('/api/experiments/results', (req,res) => res.json({available:false,summary:{},message:'No controlled experiment output is deployed. Run the Python research tools locally; no synthetic results are presented as measurements.'}));
  app.get('/api/openapi-note', (req,res) => res.json({docs:'/docs',note:'The hosted API uses the Netlify Node.js runtime; the local research API remains FastAPI.'}));
  app.get(['/docs','/redoc'], (req,res) => res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>TrustRAG API</title><h1>TrustRAG hosted API</h1><p>Requests use your browser workspace cookie. Data persists between server restarts.</p><ul><li>GET /api/health</li><li>POST /api/documents/scan — multipart file (PDF, DOCX, TXT, MD; 15 MB)</li><li>GET /api/documents</li><li>GET /api/scans/:id</li><li>GET /api/scans/:id/cleaned.txt</li><li>POST /api/query — JSON query, heal, use_demo_corpus, use_msmarco</li><li>GET /api/queries?limit=20</li><li>POST /api/dataset/load — multipart file (TSV/TXT; 15 MB), max_records (1–10,000)</li><li>GET /api/dataset/status</li><li>POST /api/dataset/unload</li><li>POST /api/dataset/evaluate?max_queries=50 — multipart queries_file and qrels_file (10 MB each; maximum 100 queries)</li><li>GET /api/dataset/evaluation</li><li>GET /api/experiments/results</li></ul><p>Retrieval uses CPU BM25 and unigram TF-IDF. Verification and suspicious-content scanning are heuristics.</p></html>`));
  app.use((req,res) => res.status(404).json({detail:'Route not found.'}));
  app.use((error,req,res,next) => {
    const status = error instanceof multer.MulterError ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 422) : error.status || 500;
    res.status(status).json({detail: status >= 500 ? 'The service could not complete the request. Please retry.' : error.message});
  });
  return app;
}
