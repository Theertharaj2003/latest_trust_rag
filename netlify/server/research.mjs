// Deterministic CPU implementation of the Python prototype's fallback workflow.
// These scores are transparent heuristics, not learned poisoning or NLI models.
export class InputError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}
const round = (n, places = 6) => Number(n.toFixed(places));
export const tokens = text => text.toLowerCase().match(/[a-z0-9_]+/g) || [];
const words = text => new Set(tokens(text));
const overlap = (a, b) => [...a].filter(t => b.has(t)).length / Math.max(1, a.size);
const patterns = {
  instruction_override: /\b(ignore|disregard|override|forget)\b.{0,80}\b(previous|prior|system|developer|user|all)\b.{0,40}\b(instruction|prompt|rules?|messages?)\b/i,
  secret_exfiltration: /\b(reveal|print|expose|leak|exfiltrate)\b.{0,60}\b(secret|hidden prompt|credentials?|api key|password|system prompt)\b/i,
  role_manipulation: /\b(you are now|act as|new system prompt|highest priority instruction)\b/i,
  tool_abuse: /\b(run this command|execute this code|send .* to|open this url)\b/i,
};
export function scanText(text) {
  const safe = [];
  const findings = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map((line, i) => {
    const signals = Object.entries(patterns).filter(([, re]) => re.test(line)).map(([name]) => name);
    const strongCount = signals.length;
    if ((line.match(/https?:\/\//gi) || []).length >= 3) signals.push('url_burst');
    if ((line.match(/[A-Z]{8,}/g) || []).length >= 3) signals.push('uppercase_anomaly');
    if (line.length > 1200) signals.push('oversized_passage');
    if (/\b(always|never|only|completely false|ignore the evidence|regardless of evidence)\b/i.test(line) && /evidence|answer|source|fact|truth/i.test(line)) signals.push('absolute_or_evidence_override_language');
    const suspicious = strongCount > 0 || signals.length >= 2;
    if (!suspicious) safe.push(line);
    return {
      line: i + 1, text: line.slice(0, 1600), signals,
      risk_score: round(Math.min(.99, .12 + .42 * strongCount + .12 * (signals.length - strongCount)), 3),
      status: suspicious ? 'quarantined' : 'retained',
      explanation: suspicious ? 'Instruction-like or anomalous content; excluded from the cleaned copy for review.' : 'No configured high-risk pattern matched; this does not prove factual correctness.',
    };
  });
  const quarantined = findings.filter(f => f.status === 'quarantined').length;
  return {
    findings, cleaned_text: safe.join('\n\n'), total_passages: findings.length,
    quarantined_count: quarantined, retained_count: findings.length - quarantined,
    risk_score: round(findings.reduce((n, f) => n + f.risk_score, 0) / Math.max(1, findings.length), 3),
    status: quarantined ? 'review_required' : 'no_configured_signals_found',
  };
}

export function chunkDocument(id, text, source) {
  const all = text.split(/\s+/).filter(Boolean), out = [];
  for (let start = 0; start < all.length; start += 95) {
    out.push({ document_id: id, chunk_id: `${id}_c${out.length + 1}`, text: all.slice(start, start + 120).join(' '), source, source_reliability: .8 });
    if (start + 120 >= all.length) break;
  }
  return out;
}
const demoRows = [
  ['rag', 'Retrieval-Augmented Generation combines a retrieval component with a language model. The retrieval corpus can contain documents, web pages, or enterprise records.'],
  ['security', 'Knowledge poisoning occurs when malicious or misleading content is inserted into a retrieval corpus so that a RAG system retrieves manipulated evidence.'],
  ['healing', 'A self-healing RAG workflow can quarantine suspicious passages, re-retrieve alternatives, verify replacement evidence, and regenerate the answer. It should abstain when verified evidence is insufficient.'],
  ['trust', 'Trust-aware RAG assigns different trust levels to evidence using relevance, source reliability, consistency, evidence support, and poisoning risk.'],
  ['verify', 'Evidence verification checks whether retrieved passages support a claim. Contradictory evidence should reduce trust and may trigger recovery.'],
  ['attr', 'Source attribution maps answer claims to supporting evidence passages so that users can inspect the provenance of important statements.'],
];
export const demoChunks = () => demoRows.map(([id, text]) => ({ document_id: `doc_${id}_001`, chunk_id: `doc_${id}_001_c1`, text, source: `doc_${id}_001.txt`, source_reliability: .8 }));

export class BM25 {
  constructor(chunks) {
    this.docs = chunks.map(c => tokens(c.text));
    this.tf = this.docs.map(doc => {
      const tf = new Map();
      for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1);
      return tf;
    });
    this.df = new Map();
    for (const tf of this.tf) for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.avg = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, chunks.length);
  }
  score(query, i) {
    return tokens(query).reduce((score, t) => {
      const f = this.tf[i].get(t) || 0;
      if (!f) return score;
      const idf = Math.log(1 + (this.docs.length - this.df.get(t) + .5) / (this.df.get(t) + .5));
      return score + idf * f * 2.5 / (f + 1.5 * (.25 + .75 * this.docs[i].length / Math.max(1, this.avg)));
    }, 0);
  }
}
// TF-IDF cosine with unigrams and bigrams; no neural embedding model is loaded.
const stop = new Set('a an the is are was were be been being and or of for to in on at by with from it this that what how does do can'.split(' '));
function tfidfTerms(text) {
  const ts = tokens(text).filter(t => !stop.has(t) && t.length > 1);
  return [...ts, ...ts.slice(1).map((t, i) => `${ts[i]} ${t}`)];
}
function cosineScores(chunks, query) {
  const docs = chunks.map(c => tfidfTerms(c.text)), df = new Map();
  for (const doc of docs) for (const t of new Set(doc)) df.set(t, (df.get(t) || 0) + 1);
  const vector = terms => {
    const v = new Map();
    for (const t of terms) if (df.has(t)) v.set(t, (v.get(t) || 0) + 1);
    for (const [t, n] of v) v.set(t, n * (Math.log((1 + docs.length) / (1 + df.get(t))) + 1));
    const norm = Math.hypot(...v.values()) || 1;
    return new Map([...v].map(([t, n]) => [t, n / norm]));
  };
  const q = vector(tfidfTerms(query));
  return docs.map(doc => { const v = vector(doc); return [...q].reduce((n, [t, w]) => n + w * (v.get(t) || 0), 0); });
}
export function lexicalNli(premise, hypothesis) {
  const p = words(premise), h = words(hypothesis);
  const neg = new Set(['not', 'never', 'no', 'false', 'cannot', 'without']);
  if (overlap(h, p) <= .55) return 'neutral';
  const hasNeg = set => [...set].some(t => neg.has(t));
  return hasNeg(p) !== hasNeg(h) ? 'contradiction' : 'entailment';
}
const normalize = vals => {
  const lo = Math.min(...vals), hi = Math.max(...vals);
  // A zero score must never become perfect relevance for an unrelated query.
  return vals.map(n => hi - lo < 1e-9 ? (hi > 0 ? 1 : 0) : (n - lo) / (hi - lo));
};
export function runQuery(chunks, query, heal = true) {
  if (!chunks.length) throw new InputError('No retained text is available. Upload a document or select the demo corpus.');
  const bm = new BM25(chunks), rawB = chunks.map((_, i) => bm.score(query, i)), rawD = cosineScores(chunks, query);
  const b = normalize(rawB), d = normalize(rawD), q = words(query), excluded = new Set(), trace = [];
  let evidence = [], trusted = [];
  for (let roundNo = 0; roundNo <= 2; roundNo++) {
    evidence = chunks.map((c, i) => ({ ...c, dense_score: d[i], bm25_score: b[i], hybrid_score: .65 * d[i] + .35 * b[i], rerank_score: overlap(q, words(c.text)) }))
      .filter(e => !excluded.has(e.chunk_id) && e.hybrid_score > 0)
      .sort((a, b) => b.hybrid_score - a.hybrid_score).slice(0, 8)
      .sort((a, b) => b.rerank_score - a.rerank_score).slice(0, 6);
    for (const e of evidence) {
      const triggers = ['ignore the user', 'system instruction', 'highest-priority', 'reveal hidden', 'contradictory evidence', 'never uses external evidence', 'always relies only'];
      const patternRisk = Math.min(1, triggers.filter(p => e.text.toLowerCase().includes(p)).length * .22);
      const scannerRisk = scanText(e.text).quarantined_count ? .8 : 0;
      e.poison_risk = Math.max(patternRisk, scannerRisk, e.dense_score < .15 && e.bm25_score < .15 ? .25 : 0, e.source_reliability < .5 ? .35 : 0);
      const consistency = evidence.some(o => o !== e && o.hybrid_score > .4) ? 1 : .5;
      e.trust_score = .3 * (.55 * e.hybrid_score + .45 * e.rerank_score) + .2 * e.source_reliability + .2 * consistency + .2 * Math.max(e.rerank_score, e.dense_score) - .1 * e.poison_risk;
      e.verification = lexicalNli(e.text, query);
      e.quarantined = e.poison_risk >= .55 || e.trust_score < .55 || e.verification === 'contradiction';
    }
    trusted = evidence.filter(e => !e.quarantined);
    if (trusted.length || !heal || roundNo === 2 || !evidence.length) break;
    const ids = evidence.filter(e => e.quarantined).map(e => e.chunk_id);
    ids.forEach(id => excluded.add(id));
    trace.push({ round: roundNo + 1, action: 're-retrieve', quarantined: ids });
  }
  const answer = trusted.length ? trusted.slice(0, 3).map(e => /[.!?]$/.test(e.text.trim()) ? e.text.trim() : `${e.text.trim()}.`).join(' ') : 'Insufficient verified evidence to answer this question safely.';
  const attributions = trusted.length ? answer.split(/(?<=[.!?])\s+/).filter(Boolean).map(claim => {
    const ranked = trusted.map(e => ({ e, verification: lexicalNli(e.text, claim), score: overlap(words(claim), words(e.text)) + (lexicalNli(e.text, claim) === 'entailment' ? .4 : 0) })).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    return { claim, chunk_id: best.e.chunk_id, source: best.e.source, verification: best.verification, score: round(Math.min(1, best.score)) };
  }) : [];
  return { answer, evidence: evidence.map(e => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === 'number' ? round(v, 4) : v]))), attributions, healing_rounds: trace.length, trace, quarantined_count: evidence.filter(e => e.quarantined).length };
}

export function parsePassages(text, maxRecords = 10000) {
  const rows = new Map();
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const pid = line.slice(0, tab).trim(), passage = line.slice(tab + 1).trim();
    if (!pid || !passage || (/^(pid|passage_id|id)$/i.test(pid) && /^(passage|text)$/i.test(passage))) continue;
    if (pid.length > 200 || passage.length > 20000) throw new InputError('A dataset row is too long (ID: 200 characters; passage: 20,000).');
    rows.set(pid, { document_id: `msmarco-${pid}`, chunk_id: `msmarco-p-${pid}`, text: passage, source: `MS MARCO passage ${pid}`, source_reliability: .8, metadata: { dataset: 'MS MARCO', pid } });
    if (rows.size >= maxRecords) break;
  }
  if (!rows.size) throw new InputError('No valid pid<TAB>passage records were found.');
  return [...rows.values()];
}
export function evaluate(chunks, queriesText, qrelsText, maxQueries = 50) {
  const queries = new Map(), qrels = new Map();
  for (const line of queriesText.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const id = line.slice(0, tab).trim(), query = line.slice(tab + 1).trim();
    if (id && query && !/^(qid|query_id)$/i.test(id)) queries.set(id, query);
  }
  for (const line of qrelsText.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (![3, 4].includes(p.length)) continue;
    const [id, pid, rel] = p.length === 4 ? [p[0], p[2], p[3]] : p;
    if (Number(rel) > 0) { if (!qrels.has(id)) qrels.set(id, new Set()); qrels.get(id).add(pid); }
  }
  const selected = [...queries].filter(([id]) => qrels.has(id)).slice(0, maxQueries);
  if (!selected.length) throw new InputError('No shared query IDs exist between queries and positive qrels.');
  if (selected.some(([, q]) => tokens(q).length > 100)) throw new InputError('Evaluation queries must contain at most 100 terms.');
  const bm = new BM25(chunks), available = new Set(chunks.map(c => c.metadata.pid));
  const details = selected.map(([id, query]) => {
    const ranked = chunks.map((c, i) => ({ pid: c.metadata.pid, score: bm.score(query, i) })).sort((a, b) => b.score - a.score).slice(0, 10);
    const gold = qrels.get(id), rank = ranked.findIndex(row => gold.has(row.pid));
    return { query_id: id, query, reciprocal_rank: rank < 0 ? 0 : 1 / (rank + 1), hit_at_10: rank >= 0, relevant_passages_in_loaded_sample: [...gold].filter(pid => available.has(pid)).length, ranked_pids: ranked.map(r => r.pid) };
  });
  return {
    method: 'BM25 (lexical-only baseline)', k: 10, evaluated_queries: details.length,
    mrr_at_10: round(details.reduce((n, r) => n + r.reciprocal_rank, 0) / details.length),
    hit_rate_at_10: round(details.filter(r => r.hit_at_10).length / details.length),
    queries_with_relevant_passage_loaded: details.filter(r => r.relevant_passages_in_loaded_sample > 0).length,
    coverage_rate: round(details.filter(r => r.relevant_passages_in_loaded_sample > 0).length / details.length), details,
    notice: 'Calculated against the uploaded subset, not the complete MS MARCO corpus. Missing relevant passages score zero. This is a BM25 baseline, not a poisoning-detection or self-healing benchmark.',
  };
}
