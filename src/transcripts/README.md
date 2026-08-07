# Transcript capture + vectorless recall (VERSION-3 item 6, v3.0)

Opt-in, local-only capture of your host CLI's session transcripts, with
identifier-first recall — "never lose a session again." Claude Code only in v3.0;
Codex/Gemini adapters are v3.1, lesson mining is v3.2.

## What it does

At `veto_session_save`, if you've opted in, Veto archives the host transcript and
builds a memory pyramid over it:

- **L0** — the raw transcript, gzipped byte-for-byte and never transformed
  (Rule 0). Recoverable source of truth.
- **L1** — deterministic facts (files, commands, errors, counts, timespan).
- **L2** — the conversation spine (user + assistant text, tool chatter stripped).
- **L3** — the ~1k-token summary `veto_session_save` already writes.

Recall is **vectorless** — no embeddings, no model downloads, no API keys:
a metadata table-of-contents (B1) + a portable BM25 index (B2), with the host AI
as the reranker (B3). Zero new runtime dependencies.

**Why not FTS5?** `node:sqlite` compiles SQLite with *Node's* build flags, and
those vary by Node version — FTS5 exists on some runtimes and not others (PR #28
failed CI with `no such module: fts5` on node 22.13). The index therefore uses
only core SQL: three plain tables (`search_docs`, `search_terms`,
`search_postings`) holding a positionless inverted index, with BM25 scored in
JS (even SQL's `log()` is a compile-time flag) and snippets rebuilt in JS for
returned rows only. One shared tokenizer (`tokenize.ts`) serves both indexing
and queries — identifier-preserving, sub-token expansion instead of stemming,
property-tested for index/query symmetry. Scores are positive-higher-is-better.

## Using it

```
veto transcripts enable          # opt in (off by default); prints what/where/retention
veto transcripts status          # state, archive dir, retention, disk usage
veto transcripts list            # archived sessions
veto transcripts show <id>       # a session's TOC + facts
veto transcripts purge <id> | --project=<dir> | --all
veto transcripts disable         # stop capturing (archives kept until purged)
```

Recall runs through `veto_session_replay` (two calls):

1. `{ query: "npm E404 publish", project_dir }` → a compact table-of-contents +
   top BM25 hits with snippets.
2. `{ expand: { event_id } }` (or `{ source_session_id, from_seq, to_seq }` /
   `{ segment_index }`) → the exact lines, masked, with a provenance citation.

## Safety guarantees

- **Off by default**; nothing is captured until `veto transcripts enable`. Consent
  is versioned; a material change re-prompts.
- **It is a copy, and it outlives the original**: the host CLI's transcript file is
  read, never modified — but Veto's archive is independent of it. Clearing the
  client's own history (or the client rotating its logs) does NOT remove the
  archive; only `veto transcripts purge` or the retention window does. The consent
  disclosure states this explicitly, because it is the non-obvious part.
- **Secrets never transit into an AI context**: detected + masked to
  `REDACTED[sha256:…]` on write into every derived layer AND again on every byte
  range served from L0. Raw L0 stays on disk only; `veto transcripts redact` is the
  escape hatch (v3.0 masks at both ends).
- **Local only**: default archive dir is `%LOCALAPPDATA%` / Application Support /
  `$XDG_DATA_HOME` — never the OneDrive-synced home dir. Cloud-sync paths are
  flagged.
- **Never breaks a save**: capture is best-effort and fully wrapped.
- **veto.db untouched**: all state lives in a sidecar `transcripts.db`, so the VS
  Code HUD read-contract is unaffected. Purge = a true cascade (zero orphan rows).
- Recalled content is wrapped as data-not-instructions; `tool_result` events are
  treated as untrusted.

## Success metric (v3.0)

Recall must surface exact detail a summary cannot. Validated against a real
784-line Claude session (3,010 KB → 1,306 KB L0 archive, 788 events, 23 TOC
phases): a three-word query returned 4 cited BM25 hits, and expanding the top
hit produced the exact source line — masked, attributed to its turn and
timestamp — which the ~1k-token L3 summary could not reconstruct. The
end-to-end suite (`tests/transcripts/e2e.test.ts`) proves the enable→save→recall→
expand path and that a pasted secret never leaks through any stage.

## Layout

| File | Role |
|---|---|
| `config.ts` | opt-in consent/config, platform dir, cloud-sync guard |
| `store.ts` / `schema.ts` | sidecar DB, WAL, additive migrations (v1 archives+map, v2 events, v3 search index) |
| `tokenize.ts` | the shared tokenizer — single source of truth for index + query |
| `mask.ts` | shared secret detection + fingerprint masking |
| `mapping.ts` | session→transcript map (statusline UPSERT) |
| `archive.ts` | L0 gzip capture (dedup, best-effort) |
| `adapters/claude.ts` | Claude JSONL → normalized masked events |
| `ingest.ts` | derive events + index postings (idempotent, watermark, session-mismatch skip) |
| `expand.ts` | mask-on-expansion of L0 (bounds-validated) |
| `pyramid.ts` / `toc.ts` | L1 facts, L2 spine, phase segmentation |
| `search.ts` | portable BM25 query, scored in JS (terms are bound parameters — no query language) |
| `recall.ts` | the two-call loop |
| `manage.ts` | list/show/purge + disk usage |
| `on-save.ts` | save-time capture + inline index + leak count / note |
