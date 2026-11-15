# Implementation phase map

1. **Ingestion:** PDF, DOCX, TXT, Markdown extraction; unsupported/corrupt input errors; source metadata.
2. **Hybrid retrieval:** BM25 + dense embeddings when enabled, TF-IDF fallback, score fusion and reranking fallback.
3. **Poisoning test corpus:** controlled factual, contradictory and indirect-injection examples with labels used only for evaluation.
4. **Suspicious-content detection:** explainable patterns and anomaly signals; not yet a calibrated learned detector.
5. **Trust scoring:** weighted relevance, source, consistency, support and risk signals; inference does not inspect the ground-truth poison label.
6. **Evidence verification:** NLI model is optional; lexical fallback is used in offline mode.
7. **Attribution:** claim-to-source heuristic mapping; needs independently annotated gold references for research-grade scores.
8. **Self-healing:** quarantine, exclude and re-retrieve loop with bounded retries; recovery metric must be validated on known baseline failures.
9. **Grounded response:** extractive answer from retained evidence and safe abstention when no suitable evidence remains. A local LLM hook exists but is not automatically loaded.
10. **Web application:** custom responsive frontend + FastAPI; Streamlit removed.
11. **Evaluation:** controlled experiment runner and metrics output; demo results are not external benchmark evidence.
12. **GPU:** device selection is passed into retrieval; CUDA still depends on installing and verifying CUDA-enabled PyTorch on the target machine.
