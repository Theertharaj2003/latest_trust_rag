> The architecture below describes the local Python research service. The Netlify deployment uses `netlify/server/index.mjs`, a Node.js port of the default lexical/heuristic pipeline, and Netlify Database. See the README deployment section for hosted limits, storage, and tests. Hosted dataset loading accepts multipart TSV/TXT uploads rather than server filesystem paths.

# TrustRAG full-stack developer guide

## System architecture

```text
Browser / web/index.html + web/app.js + web/styles.css
                         |
                 REST /api/* (FastAPI)
                         |
      +------------------+------------------+
      |                  |                  |
 Document scanner    Corpus selector   Benchmark evaluator
 PDF/DOCX/TXT/MD     uploads / demo    MS MARCO queries + qrels
      |               / MS MARCO                 |
 Quarantine/copy        |                BM25 MRR@10, Hit@10
      |             TrustRAG pipeline             |
      |           retrieval -> risk              |
      |             -> trust -> NLI              |
      |             -> attribution               |
      |             -> healing                   |
      +------------------+-----------------------+
                         |
                  JSON response
```

## File ownership and responsibility

| Path | Responsibility |
| --- | --- |
| `api/main.py` | REST routes, request validation, in-memory sessions, corpus management |
| `core/msmarco_eval.py` | Query/qrels parsing and real BM25 passage-ranking evaluation |
| `core/retrieval.py` | BM25 + optional sentence-transformer / TF-IDF retrieval |
| `core/detection.py` | Evidence poisoning-risk scoring in the RAG pipeline |
| `core/trust.py` | Evidence trust scoring |
| `core/verification.py` | Evidence/claim verification |
| `core/pipeline.py` | Retrieval, detection, verification, generation and healing orchestration |
| `core/ingestion.py` | Text extraction and chunking |
| `web/index.html` | Page structure, controls and navigation |
| `web/styles.css` | Responsive interface, styling |
| `web/app.js` | REST calls, rendering and interactive workflows |
| `experiments/run_experiment.py` | Existing controlled research demonstration |
| `tests/` | Automated regression and REST API tests |
| `sample_data/` | Small synthetic end-to-end example; **not** official MS MARCO content |

## API summary

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/health` | GET | Device and service status |
| `/api/documents/scan` | POST | Scan an uploaded document (multipart field `file`) |
| `/api/documents` | GET | List scanned documents |
| `/api/scans/{id}` | GET | Get scan report |
| `/api/scans/{id}/cleaned.txt` | GET | Download text with flagged passages omitted |
| `/api/query` | POST | Ask selected RAG corpus and view evidence, provenance and healing |
| `/api/queries` | GET | List last 20 queries (session memory) |
| `/api/dataset/status` | GET | Current loaded passage collection |
| `/api/dataset/load` | POST | `{"path": "...", "max_records": 1000}` |
| `/api/dataset/unload` | POST | Free loaded passage memory |
| `/api/dataset/evaluate` | POST | Query/qrels multipart upload, BM25 ranking test |
| `/api/dataset/evaluation` | GET | Last session's evaluation report |
| `/api/experiments/results` | GET | Existing controlled demonstration metrics |
| `/docs` | GET | FastAPI auto-generated documentation |

## MS MARCO evaluation protocol

1. Download the **Passage Ranking** collection, queries and qrels from the official Microsoft MS MARCO project at https://microsoft.github.io/msmarco/Datasets.
2. Load an extracted `collection.tsv` or supported archive into the Dataset Lab. The backend loads at most 100,000 records. Recommended initial limit: 1,000.
3. Add a query TSV with lines `qid<TAB>question` and a qrels file with `qid 0 pid relevance`, using matching query IDs.
4. Click **Run ranking evaluation**. The backend builds a lexical BM25 index and computes **MRR@10** and **Hit@10** over up to 100 selected queries. The evaluation also shows how many query labels point to passages in the loaded sample.
5. Interpret the result as **sample-specific**: absent gold passages count as misses. A prefix of 1,000 passages does not represent the full corpus. The result is **not** the official benchmark score and does not measure poisoning-defense performance.
6. To benchmark poisoning detection, define injected/clean passage ground truth independently of the retrieval ranking labels; run a held-out evaluation and calculate classifier and attack metrics separately.

## Security and operational limitations

- This is a **local, single-user research prototype**, not a publicly deployable secure service. Run bound to `127.0.0.1`; don't expose it to the Internet without authentication, storage policies, API rate limits, background job isolation, and security review.
- The dataset loader accepts paths on the local server's filesystem, which is appropriate only for trusted local users. Do not expose this route to untrusted users.
- Dataset, uploads and query history live in RAM and disappear when the backend stops; the original dataset file is unchanged.
- Suspicious-content detection is based on patterns and heuristics, not guaranteed fact checking or malware scanning.
- Learned embeddings and NLI models may be disabled by default; inspect actual runtime configuration before reporting model-based results.
- Large corpora can consume substantial RAM and CPU; benchmark evaluation is intentionally bounded.

## Run and test

From Windows PowerShell in the root directory:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements/local.txt
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8001
```

Open `http://127.0.0.1:8001/` or `http://127.0.0.1:8001/docs`.

The provided `sample_data` files let you test the **data path** before downloading MS MARCO. To do so, load `sample_data/collection_sample.tsv`, then evaluate against `sample_data/queries_sample.tsv` and `sample_data/qrels_sample.tsv`. These examples are synthetic, not a dataset benchmark.
