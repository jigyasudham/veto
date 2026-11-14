# Offline note-selection experiment

This is a deterministic research helper, not an MCP tool, agent, CLI command,
or production selector. It is outside `src`, excluded from the TypeScript build
and npm package, and has no database, configuration, host-file or network access.
Its only inputs are explicitly supplied fixtures. Do not feed it trial 2 data.

Run: `npx vitest run experiments/lesson-selection/selector.test.ts`

## What is implemented

- Exclusive note-level counts for time, scope, disabled source, native context
  and staleness exclusions; candidate-level counts for matching, budget,
  duplicates and selection. These two count groups have different denominators
  when a note contains several units.
- A small explicit alias map, symmetric in queries and notes. Synonyms collapse
  to one concept so they cannot inflate the two-term gate.
- Independently authored lesson units with parent identity and scope retained.
  No automatic sentence cutting: a condition or exception must not be separated
  from its advice. Notes without explicit units remain indivisible.
- A proposed `await_task` result for narrow continuation-only requests. No host
  hook or follow-up collection is implemented.
- A lexical comparison mode (`improved = false`). This is NOT a full replacement
  for the production baseline: source discovery, entry-version conflict handling,
  eligibility metadata derivation and database behavior are outside this fixture
  model. Run the real frozen selector for any eventual effectiveness comparison.

## Evaluation and next gate

Synthetic tests demonstrate mechanisms and boundary behavior, not real-world
precision or usefulness. Do not infer that these changes would fix a real
trial's no-match sessions. Its actual bottleneck needs separate measurement.

After a trial closes and its outcome or early termination is recorded:

1. Implement counts at the production selector's exact rejection points, with
   no query/note text in diagnostics. Keep the old selector version reproducible.
2. Use a separate development corpus to compare the real baseline, aliases only,
   authored units only, and the combined variant. Preserve as-of snapshots.
3. Label relevant note/session pairs and deliberate no-match cases. Report
   selected-note precision, relevant-note recall, false-selection rate on negative
   cases, session yield, budget usage and harmful selections. A higher yield alone
   does not pass. Include ambiguous aliases, negations and stale/conflicting notes.
4. Freeze the chosen design, acceptance thresholds and a separate held-out set
   before evaluation. Any prospective trial needs a new preregistration; trial 2
   must never be rescored as evidence for a changed selector.
5. Only consider semantic retrieval if the lexical variants still miss differently
   worded relevant notes. Review tier, privacy, latency and council requirements
   before introducing model-backed behavior.

This module is not integrated into the runtime. A separate count-only candidate
is described in `../../RELEASE-NOTES.md`; it is tested against the actual frozen
selector. The unit-splitting and request-deferral experiments remain offline.
