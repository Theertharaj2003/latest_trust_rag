# TrustRAG — Evidence Security Console

TrustRAG is a local research prototype for trust-aware hybrid retrieval, suspicious-content triage, evidence verification, source attribution and bounded self-healing. It uses **FastAPI + a custom HTML/CSS/JavaScript frontend**. Streamlit has been removed from the runtime.

## Quick start (Windows / VS Code)

1. Extract this folder and open it in VS Code.
2. Open a PowerShell terminal in the project root.
3. Run `py -3 -m venv .venv` (Python 3.10 or newer).
4. Run `\.venv\Scripts\python.exe -m pip install -r requirements.txt`.
5. Run `\.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8001`.
6. Open `http://127.0.0.1:8001`. Interactive API docs are at `http://127.0.0.1:8001/docs`.

Alternatively, double-click `start.bat`; it creates `.venv` if needed, installs requirements, starts the server, and opens the browser. Keep the server terminal open while using the UI.

## Features

- Responsive dashboard with overview, document scanner, corpus query and experiment metrics.
- Upload PDF, DOCX, TXT and Markdown files (15 MB limit).
- PDF/DOCX text extraction and UTF-8 text handling.
- Explainable hybrid suspicious-content scanning: instruction override, secret-exfiltration language, role manipulation, tool-abuse patterns and selected anomalies.
- Passage quarantine and a downloadable `_reviewed_cleaned.txt` derived copy; the original upload is not modified.
- Hybrid retrieval: BM25 plus dense semantic embeddings when explicitly enabled; TF-IDF fallback when learned embeddings are unavailable.
- Trust scoring, verification fallback, source attribution, quarantine/re-retrieval trace and local experiment summary.
- FastAPI REST API, OpenAPI docs, file size/type validation, and human-readable errors.

## API endpoints

- `GET /api/health`
- `POST /api/documents/scan` — multipart field `file`
- `GET /api/documents`
- `GET /api/scans/{scan_id}`
- `GET /api/scans/{scan_id}/cleaned.txt`
- `POST /api/query` — JSON `{ "query": "...", "heal": true, "use_demo_corpus": false }`
- `GET /api/experiments/results`
- `GET /docs`

## Important limits (read before research use)

1. The document scanner is an **explainable heuristic suspicious-content scanner**, not a malware scanner, a fact-checking oracle, or a trained poisoning classifier. A passage with no matched pattern may still be false or malicious; a flagged passage may be legitimate. It does not claim to identify every corrupted or malicious passage.
2. “Automatic correction” means quarantining configured suspicious passages and creating a derived text copy without those passages. It does **not** invent replacement facts or silently rewrite factual claims. Replacement evidence must be retrieved and verified; a human should review the cleaned output.
3. Scanned-image PDFs are not OCR'd in this build. Encrypted PDFs, malformed files and legacy `.doc` files are rejected with an error. Use `.docx` instead.
4. Uploaded data and scan reports are held in process memory and cleared when the server restarts. This is a local prototype, not a multi-user production service. Do not expose it to a public network without authentication, storage controls, upload scanning and deployment hardening.
5. Learned models are optional and not downloaded by default. The default configuration is deterministic and may use TF-IDF/lexical fallbacks. Do not claim that BGE, DeBERTa, NLI or a local LLM ran unless the model is installed, enabled, and the runtime logs confirm it.
6. GPU availability depends on a CUDA-enabled PyTorch wheel compatible with your driver. Your earlier environment showed CPU-only PyTorch; GPU execution must be verified separately. For an RTX 3050 6 GB, start with embeddings/reranking/NLI individually and avoid loading all large models at once.
7. Demo experiment metrics are for implementation checks only, not dissertation benchmark results. The detector must not use ground-truth poison labels; evaluation labels belong only in the evaluator. Validate on a held-out corpus with independent annotations and multiple seeds.

## Test and verify

```powershell
.\.venv\Scripts\python.exe -m compileall -q api core evaluation experiments tests run.py
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8001
```

Then open `/docs`, call `GET /api/health`, upload a test document in the UI, download the reviewed text, and submit a query. `scripts/check_project.py` is a static check; it does not replace runtime testing.

## Project structure

```text
api/main.py       FastAPI service and REST routes
web/index.html    Dashboard markup
web/styles.css    Responsive visual system
web/app.js        UI state and API integration
core/             Ingestion, retrieval, trust, detection, verification, healing
experiments/      Controlled experiment runner
evaluation/       Research metric functions
tests/            Unit and API integration tests
start.bat         Windows one-click launcher
```


## MS MARCO dataset integration

The UI includes an **MS MARCO Dataset Lab** for loading a bounded sample of the official passage-ranking collection into the local TrustRAG retrieval corpus.

1. Open the official dataset page: https://microsoft.github.io/msmarco/Datasets
2. Download the passage collection (`collection.tar.gz`, approximately 2.9 GB) or use an extracted collection TSV. Extracting the archive first is recommended if you have enough disk space.
3. Start TrustRAG and open **MS MARCO Dataset** in the sidebar.
4. Paste the dataset path as seen by the machine running the FastAPI server. Example Windows path: `C:\Users\Admin\Downloads\collection.tsv`.
5. Choose a sample limit (start with 1,000 or 10,000) and click **Load dataset sample**.
6. Go to **Ask your corpus**, enable **Use MS MARCO**, and submit a query.

The loader streams records and stops at the selected maximum (100,000 maximum in this UI) rather than loading the full 8.8-million-passage collection into memory. Large samples require more RAM and can make retrieval slower. This loader expects the passage collection format `pid<TAB>passage`; it supports TSV/TXT, gzip-compressed text, and TAR.GZ archives containing the collection. It does not download the dataset automatically.

**Research caveat:** MS MARCO is an information-retrieval/ranking dataset, not a dataset with poisoning labels. It can provide a realistic retrieval corpus and ranking benchmark. Poisoning detection and self-healing claims need a separate documented injection protocol, clean/poisoned split, and held-out labels. Use relevance query/qrels files separately to calculate ranking metrics such as MRR@10; the current UI loader only imports passages.

Official dataset documentation: https://microsoft.github.io/msmarco/Datasets

## New: MS MARCO relevance evaluation and developer guide

The Dataset Lab now supports **queries TSV + qrels TSV** uploads, BM25 **MRR@10**, **Hit@10**, coverage reporting, downloadable evaluation JSON, and unloading the sample from memory. This is a *subset-specific lexical ranking test*, not an MS MARCO leaderboard submission or poisoning-defense benchmark.

See [`DEVELOPER_GUIDE.md`](DEVELOPER_GUIDE.md) for architecture, every major source file, API routes, benchmark methodology, limitations and a complete Windows setup guide.

To verify the workflow before obtaining the large official dataset, use the included synthetic `sample_data/collection_sample.tsv`, `queries_sample.tsv` and `qrels_sample.tsv`.

The Windows launch scripts default to port **8001**. Use `./start.ps1 -Port 8002` or `start.bat 8002` if that port is occupied.
