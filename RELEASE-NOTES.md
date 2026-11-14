# Veto 3.10.0 — release candidate

Run `veto lessons trial close` to withdraw trial consent without deleting notes
or recorded evidence. Sharing consent remains intact. Status and the API
distinguish owner closure from completion under the trial's original rules.
Closure is idempotent and does not start another trial or score the old one.

The revoked consent also stops selection by 3.9.0 clients. Older clients cannot
display closure and may offer to start again. Upgrade all clients before using
trial controls again. An already executing old collector may finish its current
pass; close clients before withdrawal if an exact concurrent cutoff is required.
The new collector rechecks withdrawal during a pass. `lessons off` still deletes
notes and trial records; use `trial close` to retain them.

## Candidate selection

`veto lessons preview <query>` evaluates `lexical-alias-v1` for the current
project and a Codex target. It reports counts and estimated tokens, never note
text, IDs, query text, or project paths. It neither harvests nor records a trial
choice. Sharing consent and project exclusions still apply. Preview is refused
while trial 2 runs.

The candidate normalizes technical aliases (`pwsh`/`PowerShell`,
`powershell.exe`/`PowerShell`, `utf-8`/`utf8`, `utf_8`/`utf8`, `node.js`/`nodejs`).
Aliases count as one concept toward the existing relevance gate. Diagnostics
separate temporal exclusions, disabled sources, native context, stale status,
scope restrictions, insufficient matches, superseded copies, duplicates and
budget rejection. Notes remain indivisible; the total budget stays at 500
estimated tokens. Eligibility counters are exclusive; eligible rows are then
partitioned by ranking/budget counters. Do not sum both stages together.

Trial 2 retains its original selector. No automatic splitting, changed request
trigger, semantic model, note delivery, or trial 3 is enabled. The offline
experiment remains outside the npm package. A new prospective trial needs a
separately approved, frozen protocol and explicit opt-in.

## Evidence and approval

Design council `310416ec-9113-4ad1-9179-30607f21cfaf`: GREEN with conditions.
This is host-reasoned council review, not independent external review or proof
of effectiveness.

The synthetic development comparison runs the actual frozen selector and the
candidate on identical isolated notes: baseline selects 1 of 4 deliberately
constructed positive queries; candidate selects 4 of 4; both abstain on 6
unrelated queries. These are development fixtures, not held-out accuracy
estimates. Real-world effectiveness has not been established.

## Release procedure

1. Merge prerequisite replay-boundary/retention work and this change after the
   Linux/Windows Node matrix, package checks and model-pin checks pass.
2. Run the release workflow with `dry_run: true` against the reviewed commit.
3. After release approval, publish that commit through the existing OIDC npm
   workflow; verify npm installation, GitHub release, Smithery and MCP registry
   at the same version. Keep registry credentials out of files and PRs.
4. Install the release and restart each client's Veto server. Verify backend
   version as well as `veto --version` before any new trial.

Rollback needs no data migration: candidate preview is explicit and trial 2
still uses the original selector. Keep the closure receipt when rolling back to
3.9.0: consent remains revoked, but old config writers can drop the optional
closure timestamp and the old UI does not understand withdrawal.
