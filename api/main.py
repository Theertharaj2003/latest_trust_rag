from __future__ import annotations

import hashlib
import io
import gzip
import tarfile
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from core.config import Config
from core.dataset import demo_chunks
from core.device import get_device, gpu_info
from core.ingestion import build_chunks, read_uploaded_document
from core.pipeline import TrustRAG
from core.types import Chunk
from core.msmarco_eval import parse_queries, parse_qrels, evaluate_bm25

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md"}

# Deliberately content-based patterns. Ground-truth evaluation labels are never consulted.
INJECTION_PATTERNS = {
    "instruction_override": re.compile(r"\b(ignore|disregard|override|forget)\b.{0,80}\b(previous|prior|system|developer|user|all)\b.{0,40}\b(instruction|prompt|rules?|messages?)\b", re.I),
    "secret_exfiltration": re.compile(r"\b(reveal|print|expose|leak|exfiltrate)\b.{0,60}\b(secret|hidden prompt|credentials?|api key|password|system prompt)\b", re.I),
    "role_manipulation": re.compile(r"\b(you are now|act as|new system prompt|highest priority instruction)\b", re.I),
    "tool_abuse": re.compile(r"\b(run this command|execute this code|send .* to|open this url)\b", re.I),
}
CONTRADICTION_CUES = re.compile(r"\b(always|never|only|completely false|ignore the evidence|regardless of evidence)\b", re.I)

app = FastAPI(
    title="TrustRAG API",
    description="Trust-aware hybrid retrieval, suspicious-evidence triage, attribution and self-healing prototype.",
    version="2.0.0",
)
app.mount("/assets", StaticFiles(directory=WEB), name="assets")

# In-memory stores are suitable for a single-user local prototype. They reset on restart.
DOCUMENTS: dict[str, dict[str, Any]] = {}
SCANS: dict[str, dict[str, Any]] = {}
QUERY_HISTORY: list[dict[str, Any]] = []
BENCHMARK_RESULTS: dict[str, Any] = {}
MSMARCO_CHUNKS: list[Chunk] = []
MSMARCO_INFO: dict[str, Any] = {
    "loaded": False,
    "dataset": "MS MARCO Passage Ranking",
    "source": "https://microsoft.github.io/msmarco/Datasets",
    "records_loaded": 0,
    "path": None,
    "max_records": 0,
    "message": "Load an extracted collection TSV or a collection archive from your local machine.",
}


class QueryRequest(BaseModel):
    query: str = Field(min_length=3, max_length=2000)
    heal: bool = True
    use_demo_corpus: bool = False
    use_msmarco: bool = False


class DatasetLoadRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    max_records: int = Field(default=10000, ge=100, le=100000)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _scan_text(text: str) -> dict[str, Any]:
    """Hybrid, explainable heuristic scan; it is not a malware or truth oracle."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        lines = [x.strip() for x in re.split(r"(?<=[.!?])\s+", text) if x.strip()]
    findings: list[dict[str, Any]] = []
    safe_lines: list[str] = []
    for idx, line in enumerate(lines, start=1):
        signals: list[str] = []
        for name, pattern in INJECTION_PATTERNS.items():
            if pattern.search(line):
                signals.append(name)
        if len(re.findall(r"https?://", line, re.I)) >= 3:
            signals.append("url_burst")
        if len(re.findall(r"[A-Z]{8,}", line)) >= 3:
            signals.append("uppercase_anomaly")
        if len(line) > 1200:
            signals.append("oversized_passage")
        if CONTRADICTION_CUES.search(line) and any(word in line.lower() for word in ("evidence", "answer", "source", "fact", "truth")):
            signals.append("absolute_or_evidence_override_language")

        # A transparent, bounded risk score from independent text signals.
        strong = {"instruction_override", "secret_exfiltration", "role_manipulation", "tool_abuse"}
        score = min(0.99, 0.12 + 0.42 * sum(s in strong for s in signals) + 0.12 * sum(s not in strong for s in signals))
        suspicious = bool(signals) and (any(s in strong for s in signals) or len(signals) >= 2)
        item = {
            "line": idx,
            "text": line[:1600],
            "risk_score": round(score, 3),
            "status": "quarantined" if suspicious else "retained",
            "signals": signals,
            "explanation": (
                "Contains instruction-like or anomalous content; excluded from the cleaned copy for review."
                if suspicious else "No configured high-risk pattern matched; this does not prove the passage is factually correct."
            ),
        }
        findings.append(item)
        if not suspicious:
            safe_lines.append(line)

    quarantined = [f for f in findings if f["status"] == "quarantined"]
    mean_risk = sum(f["risk_score"] for f in findings) / max(1, len(findings))
    return {
        "findings": findings,
        "cleaned_text": "\n\n".join(safe_lines).strip(),
        "total_passages": len(findings),
        "quarantined_count": len(quarantined),
        "retained_count": len(findings) - len(quarantined),
        "risk_score": round(mean_risk, 3),
        "status": "review_required" if quarantined else "no_configured_signals_found",
    }


async def _read_upload(upload: UploadFile) -> tuple[str, bytes]:
    filename = Path(upload.filename or "upload").name
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(415, "Unsupported file type. Upload PDF, DOCX, TXT or Markdown.")
    content = await upload.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File exceeds the 15 MB local upload limit.")
    if not content:
        raise HTTPException(400, "The uploaded file is empty.")
    return filename, content




def _iter_msmarco_rows(path: Path):
    """Stream official MS MARCO passage collection rows (pid<TAB>passage)."""
    suffixes = "".join(path.suffixes).lower()
    if not path.is_file():
        raise ValueError("Dataset path is not a file. Use an extracted collection TSV or collection archive path.")
    if suffixes.endswith(".tar.gz") or suffixes.endswith(".tgz"):
        with tarfile.open(path, "r:gz") as archive:
            members = [m for m in archive.getmembers() if m.isfile() and (m.name.lower().endswith(".tsv") or "collection" in Path(m.name).name.lower())]
            if not members:
                raise ValueError("No TSV collection file was found inside the TAR.GZ archive.")
            member = max(members, key=lambda m: m.size)
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError("Could not read the collection file inside the archive.")
            import io as _io
            text_stream = _io.TextIOWrapper(stream, encoding="utf-8", errors="replace")
            yield from _parse_passage_lines(text_stream)
    elif suffixes.endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as stream:
            yield from _parse_passage_lines(stream)
    else:
        with path.open("r", encoding="utf-8-sig", errors="replace") as stream:
            yield from _parse_passage_lines(stream)


def _parse_passage_lines(stream):
    for line in stream:
        line = line.rstrip("\r\n")
        if not line:
            continue
        parts = line.split("\t", 1)
        if len(parts) != 2:
            continue
        pid, passage = parts[0].strip(), parts[1].strip()
        if pid.lower() in {"pid", "passage_id", "id"} and passage.lower() in {"passage", "text"}:
            continue
        if passage:
            yield pid or f"row-{uuid.uuid4().hex[:10]}", passage


@app.get("/api/dataset/status")
def dataset_status() -> dict[str, Any]:
    return {**MSMARCO_INFO, "path": str(MSMARCO_INFO.get("path") or "")}


@app.post("/api/dataset/load")
def load_msmarco_dataset(payload: DatasetLoadRequest) -> dict[str, Any]:
    """Load a bounded streaming sample of the official MS MARCO passage collection."""
    global MSMARCO_CHUNKS, MSMARCO_INFO
    path = Path(payload.path).expanduser()
    try:
        chunks: list[Chunk] = []
        for pid, passage in _iter_msmarco_rows(path):
            chunks.append(Chunk(
                document_id=f"msmarco-{pid}",
                chunk_id=f"msmarco-p-{pid}",
                text=passage,
                source=f"MS MARCO passage {pid}",
                source_reliability=0.8,
                metadata={"dataset": "MS MARCO", "pid": pid},
            ))
            if len(chunks) >= payload.max_records:
                break
        if not chunks:
            raise ValueError("No valid pid<TAB>passage records were found in this file.")
    except (OSError, tarfile.TarError, EOFError, ValueError) as exc:
        raise HTTPException(422, f"Could not load MS MARCO data: {exc}") from exc
    MSMARCO_CHUNKS = chunks
    MSMARCO_INFO = {
        "loaded": True,
        "dataset": "MS MARCO Passage Ranking",
        "source": "https://microsoft.github.io/msmarco/Datasets",
        "records_loaded": len(chunks),
        "path": str(path.resolve()),
        "max_records": payload.max_records,
        "message": "A bounded sample was loaded into memory. MS MARCO provides relevance-ranking data, not poisoning ground-truth labels.",
    }
    return {**MSMARCO_INFO, "path": str(path.resolve())}


@app.post("/api/dataset/unload")
def unload_msmarco_dataset() -> dict[str, Any]:
    """Release the in-memory corpus. Does not delete the source dataset file."""
    global MSMARCO_CHUNKS, MSMARCO_INFO
    MSMARCO_CHUNKS = []
    MSMARCO_INFO = {
        "loaded": False, "dataset": "MS MARCO Passage Ranking",
        "source": "https://microsoft.github.io/msmarco/Datasets",
        "records_loaded": 0, "path": None, "max_records": 0,
        "message": "Dataset unloaded. The source file has not been changed.",
    }
    BENCHMARK_RESULTS.clear()
    return MSMARCO_INFO


@app.post("/api/dataset/evaluate")
async def evaluate_msmarco_dataset(
    queries_file: UploadFile = File(...), qrels_file: UploadFile = File(...),
    max_queries: int = 50,
) -> dict[str, Any]:
    """Evaluate BM25 MRR@10 / Hit@10 on an explicitly loaded passage subset."""
    if not MSMARCO_CHUNKS:
        raise HTTPException(422, "Load MS MARCO passages first.")
    if not 1 <= max_queries <= 100:
        raise HTTPException(422, "max_queries must be between 1 and 100.")
    data = []
    for file in (queries_file, qrels_file):
        raw = await file.read(10 * 1024 * 1024 + 1)
        if len(raw) > 10 * 1024 * 1024:
            raise HTTPException(413, "Each evaluation file must be at most 10 MB.")
        try:
            data.append(raw.decode("utf-8-sig"))
        except UnicodeDecodeError as exc:
            raise HTTPException(422, "Evaluation files must be UTF-8 text.") from exc
    try:
        result = evaluate_bm25(
            MSMARCO_CHUNKS, parse_queries(data[0]), parse_qrels(data[1]), max_queries=max_queries
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    BENCHMARK_RESULTS.clear()
    BENCHMARK_RESULTS.update(result)
    return result


@app.get("/api/dataset/evaluation")
def get_msmarco_evaluation() -> dict[str, Any]:
    return BENCHMARK_RESULTS or {"available": False, "message": "No ranking evaluation has been run in this session."}


@app.get("/api/queries")
def list_query_history(limit: int = 20) -> dict[str, Any]:
    if not 1 <= limit <= 100:
        raise HTTPException(422, "limit must be between 1 and 100.")
    rows = list(reversed(QUERY_HISTORY[-limit:]))
    return {"count": len(rows), "queries": [
        {"query_id": r["query_id"], "query": r["query"], "corpus": r["corpus"],
         "timestamp": r["timestamp"], "quarantined_count": r["quarantined_count"]}
        for r in rows
    ]}


@app.get("/", response_class=HTMLResponse)
def home() -> str:
    return (WEB / "index.html").read_text(encoding="utf-8")


@app.get("/api/health")
def health() -> dict[str, Any]:
    try:
        device = get_device(Config.load().device)
    except Exception:
        device = "cpu"
    try:
        hardware = gpu_info()
    except Exception as exc:
        hardware = {"available": False, "message": str(exc)}
    return {
        "status": "ok",
        "service": "TrustRAG",
        "version": app.version,
        "device_selected": device,
        "gpu": hardware,
        "documents_loaded": len(DOCUMENTS),
        "timestamp": _utc_now(),
    }


@app.post("/api/documents/scan")
async def scan_document(file: UploadFile = File(...)) -> dict[str, Any]:
    filename, content = await _read_upload(file)
    try:
        if Path(filename).suffix.lower() in {".txt", ".md"}:
            text = content.decode("utf-8-sig", errors="strict")
            title = Path(filename).stem
        else:
            title, text, _ = read_uploaded_document(filename, content)
    except UnicodeDecodeError as exc:
        raise HTTPException(400, "Text file must be UTF-8 encoded.") from exc
    except ValueError as exc:
        # This includes malformed/encrypted/unsupported files; no destructive repair is attempted.
        raise HTTPException(422, str(exc)) from exc
    if len(text.strip()) < 8:
        raise HTTPException(422, "Too little extractable text was found. Scanned-image PDFs need OCR, which is not enabled in this build.")

    report = _scan_text(text)
    scan_id = str(uuid.uuid4())
    digest = hashlib.sha256(content).hexdigest()
    doc_id = str(uuid.uuid4())
    record = {
        "document_id": doc_id,
        "scan_id": scan_id,
        "filename": filename,
        "title": title,
        "sha256": digest,
        "original_bytes": content,
        "original_text": text,
        "cleaned_text": report["cleaned_text"],
        "created_at": _utc_now(),
        **{k: v for k, v in report.items() if k != "cleaned_text"},
    }
    DOCUMENTS[doc_id] = record
    SCANS[scan_id] = record
    return {
        "scan_id": scan_id,
        "document_id": doc_id,
        "filename": filename,
        "sha256": digest,
        "status": record["status"],
        "risk_score": record["risk_score"],
        "total_passages": record["total_passages"],
        "quarantined_count": record["quarantined_count"],
        "retained_count": record["retained_count"],
        "findings": record["findings"],
        "cleaned_text_preview": record["cleaned_text"][:5000],
        "download_url": f"/api/scans/{scan_id}/cleaned.txt",
        "report_url": f"/api/scans/{scan_id}",
        "notice": "This is a heuristic suspicious-content scan, not a guarantee of factual correctness or a malware scan. Flagged passages are quarantined from the cleaned text; review before relying on it.",
    }


@app.get("/api/documents")
def list_documents() -> dict[str, Any]:
    return {"documents": [
        {k: v for k, v in d.items() if k not in {"original_bytes", "original_text", "cleaned_text", "findings"}}
        for d in DOCUMENTS.values()
    ]}


@app.get("/api/scans/{scan_id}")
def get_scan(scan_id: str) -> dict[str, Any]:
    record = SCANS.get(scan_id)
    if not record:
        raise HTTPException(404, "Scan not found. Upload the file again after restarting the server.")
    return {k: v for k, v in record.items() if k not in {"original_bytes", "original_text", "cleaned_text"}}


@app.get("/api/scans/{scan_id}/cleaned.txt")
def download_cleaned(scan_id: str) -> PlainTextResponse:
    record = SCANS.get(scan_id)
    if not record:
        raise HTTPException(404, "Scan not found.")
    name = Path(record["filename"]).stem + "_reviewed_cleaned.txt"
    return PlainTextResponse(
        record["cleaned_text"],
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@app.post("/api/query")
def query_rag(payload: QueryRequest) -> dict[str, Any]:
    query = payload.query.strip()
    if len(query) < 3:
        raise HTTPException(422, "Enter a question with at least 3 characters.")
    if payload.use_msmarco:
        if not MSMARCO_CHUNKS:
            raise HTTPException(422, "MS MARCO is not loaded yet. Open Dataset Lab and load a local collection file first.")
        chunks = MSMARCO_CHUNKS
        corpus_label = f"MS MARCO passage collection ({len(chunks):,} loaded passages)"
    elif payload.use_demo_corpus or not DOCUMENTS:
        chunks = demo_chunks()
        corpus_label = "controlled demo corpus"
    else:
        chunks = []
        for doc in DOCUMENTS.values():
            # Only retained passages enter retrieval. Labels are never supplied as detector features.
            safe_text = doc["cleaned_text"]
            if safe_text:
                chunks.extend(build_chunks([(doc["document_id"], safe_text, doc["filename"])]))
        corpus_label = "uploaded documents (retained passages only)"
    if not chunks:
        raise HTTPException(422, "No retained text is available for retrieval. Upload a readable document or use the demo corpus.")
    try:
        result = TrustRAG(chunks, Config.load()).run(query, heal=payload.heal)
    except Exception as exc:
        # Return a useful local error without leaking stack traces to the browser.
        raise HTTPException(500, f"RAG pipeline failed: {type(exc).__name__}. Check the terminal log for details.") from exc
    evidence = []
    for item in result["evidence"]:
        evidence.append({
            "chunk_id": item.chunk.chunk_id,
            "source": item.chunk.source,
            "text": item.chunk.text,
            "dense_score": round(float(item.dense_score), 4),
            "bm25_score": round(float(item.bm25_score), 4),
            "hybrid_score": round(float(item.hybrid_score), 4),
            "rerank_score": round(float(item.rerank_score), 4),
            "poison_risk": round(float(item.poison_risk), 4),
            "trust_score": round(float(item.trust_score), 4),
            "verification": item.verification,
            "quarantined": bool(item.quarantined),
        })
    response = {
        "query_id": str(uuid.uuid4()),
        "query": query,
        "answer": result["answer"],
        "corpus": corpus_label,
        "evidence": evidence,
        "attributions": result["attributions"],
        "healing_rounds": result["healing_rounds"],
        "trace": result["trace"],
        "quarantined_count": sum(x["quarantined"] for x in evidence),
        "timestamp": _utc_now(),
        "notice": "Scores are prototype heuristics unless learned models are explicitly enabled and verified. Uploaded passage flags indicate suspicious patterns, not definitive proof of falsehood.",
    }
    QUERY_HISTORY.append(response)
    return response


@app.get("/api/experiments/results")
def experiment_results() -> dict[str, Any]:
    path = ROOT / "results" / "rag_experiment.json"
    if not path.exists():
        return {"available": False, "message": "No experiment results file found.", "summary": {}}
    import json
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {"available": True, "summary": data.get("summary", {}), "record_count": len(data.get("records", [])), "source": "local controlled experiment output"}
    except (OSError, json.JSONDecodeError):
        return {"available": False, "message": "Experiment results file is invalid JSON.", "summary": {}}


@app.get("/api/openapi-note")
def openapi_note() -> dict[str, str]:
    return {"docs": "/docs", "redoc": "/redoc", "note": "Interactive API documentation is provided by FastAPI."}
