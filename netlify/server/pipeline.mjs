export const tokens = text => text.toLowerCase().match(/\b[a-z0-9_]+\b/g) || [];
const overlap = (a, b) => { const x = new Set(tokens(a)), y = new Set(tokens(b)); return [...x].filter(t => y.has(t)).length / Math.max(1, x.size); };
const round = x => Math.round(x * 1000000) / 1000000;

export function scanText(text) {
  const patterns = {
    instruction_override: /\b(ignore|disregard|override|forget)\b.{0,80}\b(previous|prior|system|developer|user|all)\b.{0,40}\b(instructions?|prompts?|rules?|messages?)\b/i,
    secret_exfiltration: /\b(reveal|print|expose|leak|exfiltrate)\b.{0,60}\b(secrets?|hidden prompts?|credentials?|api keys?|passwords?|system prompts?)\b/i,
    role_manipulation: /\b(you are now|act as|new system prompt|highest priority instruction)\b/i,
    tool_abuse: /\b(run this command|execute this code|send .* to|open this url)\b/i,
  };
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const findings = lines.map((line, i) => {
    const signals = Object.entries(patterns).filter(([, re]) => re.test(line)).map(([key]) => key);
    const strong = signals.length;
    if ((line.match(/https?:\/\//g) || []).length >= 3) signals.push('url_burst');
    if ((line.match(/[A-Z]{8,}/g) || []).length >= 3) signals.push('uppercase_anomaly');
    if (line.length > 1200) signals.push('oversized_passage');
    if (/\b(always|never|only|completely false|ignore the evidence|regardless of evidence)\b/i.test(line) && /evidence|answer|source|fact|truth/i.test(line)) signals.push('absolute_or_evidence_override_language');
    const suspicious = strong > 0 || signals.length >= 2;
    return { line: i + 1, text: line.slice(0, 1600), risk_score: round(Math.min(.99, .12 + .42 * strong + .12 * (signals.length - strong))), status: suspicious ? 'quarantined' : 'retained', signals,
      explanation: suspicious ? 'Contains instruction-like or anomalous content; excluded from the cleaned copy for review.' : 'No configured high-risk pattern matched; this does not prove the passage is factually correct.' };
  });
  const quarantined_count = findings.filter(f => f.status === 'quarantined').length;
  return { findings, cleaned_text: lines.filter((_, i) => findings[i].status === 'retained').join('\n\n'), total_passages: findings.length, quarantined_count, retained_count: findings.length - quarantined_count, risk_score: round(findings.reduce((s, f) => s + f.risk_score, 0) / Math.max(1, findings.length)), status: quarantined_count ? 'review_required' : 'no_configured_signals_found' };
}

export function chunksFromDocuments(documents) {
  return documents.flatMap(doc => {
    const words = doc.cleaned_text.split(/\s+/).filter(Boolean), chunks = [];
    for (let i = 0; i < words.length; i += 95) {
      chunks.push({ chunk_id: `${doc.document_id}_c${chunks.length + 1}`, text: words.slice(i, i + 120).join(' '), source: doc.filename, source_reliability: .8 });
      if (i + 120 >= words.length) break;
    }
    return chunks;
  });
}
export const demoChunks = [
  ['rag', 'Retrieval-Augmented Generation combines a retrieval component with a language model. The retrieval corpus can contain documents, web pages, or enterprise records.'],
  ['security', 'Knowledge poisoning occurs when malicious or misleading content is inserted into a retrieval corpus so that a RAG system retrieves manipulated evidence.'],
  ['healing', 'A self-healing RAG workflow can quarantine suspicious passages, re-retrieve alternatives, verify replacement evidence, and regenerate the answer. It should abstain when verified evidence is insufficient.'],
  ['trust', 'Trust-aware RAG assigns different trust levels to evidence using relevance, source reliability, consistency, evidence support, and poisoning risk.'],
  ['verify', 'Evidence verification checks whether retrieved passages support a claim. Contradictory evidence should reduce trust and may trigger recovery.'],
  ['attr', 'Source attribution maps answer claims to supporting evidence passages so that users can inspect the provenance of important statements.'],
].map(([id, text]) => ({ chunk_id: `doc_${id}_001_c1`, text, source: `doc_${id}_001.txt`, source_reliability: .8 }));

export class RetrievalIndex {
  constructor(chunks) {
    this.chunks = chunks;
    this.docs = chunks.map(c => tokens(c.text));
    this.tf = this.docs.map(t => { const m = new Map(); for (const w of t) m.set(w, (m.get(w) || 0) + 1); return m; });
    this.df = new Map();
    for (const tf of this.tf) for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.avg = this.docs.reduce((s, t) => s + t.length, 0) / Math.max(1, chunks.length);
    this.idf = t => Math.log((1 + chunks.length) / (1 + (this.df.get(t) || 0))) + 1;
    this.norms = this.tf.map(tf => Math.sqrt([...tf].reduce((s, [t, f]) => s + (f * this.idf(t)) ** 2, 0)));
  }
  scores(query) {
    const terms = tokens(query), qtf = new Map();
    for (const t of terms) if (this.df.has(t)) qtf.set(t, (qtf.get(t) || 0) + 1);
    const qnorm = Math.sqrt([...qtf].reduce((s, [t, f]) => s + (f * this.idf(t)) ** 2, 0));
    return this.chunks.map((chunk, i) => {
      const tf = this.tf[i]; let bm25_score = 0, dense_score = 0;
      for (const t of terms) {
        const f = tf.get(t) || 0;
        if (f) bm25_score += Math.log(1 + (this.chunks.length - this.df.get(t) + .5) / (this.df.get(t) + .5)) * f * 2.5 / (f + 1.5 * (.25 + .75 * this.docs[i].length / Math.max(1, this.avg)));
      }
      for (const [t, f] of qtf) dense_score += f * (tf.get(t) || 0) * this.idf(t) ** 2;
      dense_score /= (qnorm * this.norms[i]) || 1;
      return { ...chunk, bm25_score, dense_score };
    });
  }
}
export function lexicalNli(premise, claim) {
  if (overlap(claim, premise) <= .55) return 'neutral';
  const neg = /\b(not|never|no|false|cannot|without)\b/i;
  return neg.test(premise) !== neg.test(claim) ? 'contradiction' : 'entailment';
}
export function queryPipeline(query, chunks, heal = true) {
  const scores = new RetrievalIndex(chunks).scores(query), excluded = new Set(), trace = [];
  let evidence = [], healing_rounds = 0;
  for (let iteration = 0; iteration <= 2; iteration++) {
    const candidates = new Map();
    for (const field of ['dense_score', 'bm25_score']) {
      const top = [...scores].sort((a,b) => b[field] - a[field]).slice(0, 24).filter(e => !excluded.has(e.chunk_id));
      const lo = Math.min(...top.map(e => e[field])), hi = Math.max(...top.map(e => e[field]));
      for (const row of top) {
        const e = candidates.get(row.chunk_id) || { ...row, dense_score: 0, bm25_score: 0 };
        e[field] = hi - lo < 1e-9 ? 1 : (row[field] - lo) / (hi - lo); candidates.set(e.chunk_id, e);
      }
    }
    evidence = [...candidates.values()].map(e => ({ ...e, hybrid_score: .65 * e.dense_score + .35 * e.bm25_score, rerank_score: overlap(query, e.text) })).sort((a,b) => b.hybrid_score - a.hybrid_score).slice(0,8).sort((a,b) => b.rerank_score - a.rerank_score).slice(0,6);
    for (const e of evidence) {
      const patterns = ['ignore the user','system instruction','highest-priority','reveal hidden','contradictory evidence','never uses external evidence','always relies only'];
      e.poison_risk = Math.max(Math.min(1, patterns.filter(p => e.text.toLowerCase().includes(p)).length * .22), e.dense_score < .15 && e.bm25_score < .15 ? .25 : 0, e.source_reliability < .5 ? .35 : 0);
      e.trust_score = .3 * (.55 * e.hybrid_score + .45 * e.rerank_score) + .2 * e.source_reliability + .2 * (evidence.some(x => x !== e && x.hybrid_score > .4) ? 1 : .5) + .2 * Math.max(e.rerank_score, e.dense_score) - .1 * e.poison_risk;
      e.verification = lexicalNli(e.text, query);
      e.quarantined = e.poison_risk >= .55 || e.trust_score < .55 || e.verification === 'contradiction';
    }
    if (evidence.some(e => !e.quarantined) || !heal || iteration === 2) break;
    for (const e of evidence) excluded.add(e.chunk_id);
    healing_rounds++;
    trace.push({ round: iteration + 1, quarantined: evidence.map(e => e.chunk_id), action: 're-retrieve' });
  }
  const trusted = evidence.filter(e => !e.quarantined);
  const answer = trusted.slice(0,3).map(e => /[.!?]$/.test(e.text) ? e.text : e.text + '.').join(' ') || 'Insufficient verified evidence to answer this question safely.';
  const attributions = trusted.length ? answer.split(/(?<=[.!?])\s+/).map(claim => {
    const best = trusted.map(e => ({ e, verification: lexicalNli(e.text, claim), value: overlap(claim, e.text) + (lexicalNli(e.text, claim) === 'entailment' ? .4 : 0) })).sort((a,b) => b.value - a.value)[0];
    return { claim, chunk_id: best.e.chunk_id, source: best.e.source, verification: best.verification, score: Math.min(1, best.value) };
  }) : [];
  return { answer, evidence, attributions, healing_rounds, trace, quarantined_count: evidence.filter(e => e.quarantined).length };
}

export function parsePassages(text, limit) {
  const chunks = [], seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const tab = line.indexOf('\t'); if (tab < 0) continue;
    const pid = line.slice(0, tab).trim(), passage = line.slice(tab + 1).trim();
    if (!pid || !passage || seen.has(pid) || (/^(pid|passage_id|id)$/i.test(pid) && /^(passage|text)$/i.test(passage))) continue;
    seen.add(pid); chunks.push({ pid, chunk_id: `msmarco-p-${pid}`, text: passage, source: `MS MARCO passage ${pid}`, source_reliability: .8 });
    if (chunks.length >= limit) break;
  }
  return chunks;
}
export function evaluate(chunks, queryText, qrelText, limit) {
  const queries = new Map(), qrels = new Map();
  for (const line of queryText.split(/\r?\n/)) { const i = line.indexOf('\t'); if (i > 0) queries.set(line.slice(0,i).trim(), line.slice(i+1).trim()); }
  for (const line of qrelText.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/); if (![3,4].includes(p.length)) continue;
    const [qid, pid, relevance] = p.length === 4 ? [p[0],p[2],p[3]] : p;
    if (Number(relevance) > 0) { if (!qrels.has(qid)) qrels.set(qid,new Set()); qrels.get(qid).add(pid); }
  }
  const selected = [...queries].filter(([id]) => qrels.has(id)).slice(0,limit);
  if (!selected.length) throw new Error('No shared query IDs exist between queries and qrels files.');
  const index = new RetrievalIndex(chunks), available = new Set(chunks.map(c => c.pid));
  const details = selected.map(([query_id, query]) => {
    const top = index.scores(query).sort((a,b) => b.bm25_score - a.bm25_score).slice(0,10), gold = qrels.get(query_id), rank = top.findIndex(c => gold.has(c.pid));
    return { query_id, query, reciprocal_rank: rank < 0 ? 0 : 1/(rank+1), hit_at_10: rank >= 0, relevant_passages_in_loaded_sample: [...gold].filter(p => available.has(p)).length, ranked_pids: top.map(c => c.pid) };
  });
  const count = details.length, covered = details.filter(r => r.relevant_passages_in_loaded_sample > 0).length;
  return { method: 'BM25 (lexical-only baseline)', k: 10, evaluated_queries: count, mrr_at_10: round(details.reduce((s,r) => s+r.reciprocal_rank,0)/count), hit_rate_at_10: round(details.filter(r => r.hit_at_10).length/count), queries_with_relevant_passage_loaded: covered, coverage_rate: round(covered/count), details, notice: 'Calculated against the loaded subset. Missing relevant passages score zero. This is a BM25 retrieval baseline, not a poisoning-detection or self-healing benchmark.' };
}
