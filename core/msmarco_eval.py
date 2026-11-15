"""Bounded MS MARCO passage-ranking evaluation.

Reports BM25 ranking metrics only; never interprets relevance as poisoning labels.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Iterable

from core.retrieval import BM25
from core.types import Chunk


def parse_queries(text: str) -> dict[str, str]:
    queries: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.rstrip('\r\n').split('\t', 1)
        if len(parts) != 2:
            continue
        qid, query = (p.strip() for p in parts)
        if qid and query and qid.lower() not in {'qid', 'query_id'}:
            queries[qid] = query
    return queries


def parse_qrels(text: str) -> dict[str, set[str]]:
    """Accept MS MARCO 4-column qrels or compact qid/pid/relevance rows."""
    relevant: dict[str, set[str]] = defaultdict(set)
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) == 4:
            qid, _, pid, relevance = parts
        elif len(parts) == 3:
            qid, pid, relevance = parts
        else:
            continue
        try:
            value = float(relevance)
        except ValueError:
            continue
        if value > 0:
            relevant[qid].add(pid)
    return dict(relevant)


def evaluate_bm25(
    chunks: list[Chunk], queries: dict[str, str], qrels: dict[str, set[str]],
    max_queries: int = 100, k: int = 10
) -> dict:
    """Queries with qrels count in the denominator, even if positives aren't in the sample.

    This prevents inflating the result by silently dropping failures due to sample coverage.
    """
    if not chunks:
        raise ValueError('Load an MS MARCO passage sample before evaluating.')
    selected = [(qid, q) for qid, q in queries.items() if qid in qrels][:max_queries]
    if not selected:
        raise ValueError('No shared query IDs exist between queries and qrels files.')
    bm25 = BM25(chunks)
    pids = [str(c.metadata.get('pid', '')) for c in chunks]
    available = set(pids)
    results = []
    for qid, query in selected:
        scored = [(bm25.score(query, i), i) for i in range(len(chunks))]
        scored.sort(key=lambda row: (-row[0], row[1]))
        top = [(pids[i], float(score)) for score, i in scored[:k]]
        gold = qrels[qid]
        first_rank = next((rank for rank, (pid, _) in enumerate(top, 1) if pid in gold), None)
        results.append({
            'query_id': qid, 'query': query, 'reciprocal_rank': 1 / first_rank if first_rank else 0.0,
            'hit_at_10': first_rank is not None, 'relevant_passages_in_loaded_sample': len(gold & available),
            'ranked_pids': [pid for pid, _ in top],
        })
    count = len(results)
    return {
        'method': 'BM25 (lexical-only baseline)', 'k': k, 'evaluated_queries': count,
        'mrr_at_10': round(sum(r['reciprocal_rank'] for r in results) / count, 6),
        'hit_rate_at_10': round(sum(r['hit_at_10'] for r in results) / count, 6),
        'queries_with_relevant_passage_loaded': sum(r['relevant_passages_in_loaded_sample'] > 0 for r in results),
        'coverage_rate': round(sum(r['relevant_passages_in_loaded_sample'] > 0 for r in results) / count, 6),
        'details': results,
        'notice': ('Calculated against the currently loaded subset, not the complete MS MARCO corpus. '
                   'Missing relevant passages score zero. This is a BM25 retrieval baseline, '
                   'not a poisoning-detection or self-healing benchmark.'),
    }
