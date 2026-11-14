# Trial 3 protocol: lexical-alias-v1

Protocol version 1. Design council b571b50b-8131-4446-90f9-a0fc28288165:
YELLOW, host-reasoned review, not independent evidence.

This prospective shadow trial evaluates the lexical alias selector for Codex
sessions. It never delivers notes. Trial 2 remains a separate historical
experiment with its original receipt and records; it is not rescored.

## Start and stop

`veto lessons trial prepare` creates unconsented Trial 3 settings, copying the
previous project lists. It refuses a running Trial 2 and cannot reset a started
Trial 3. Upgrade/reconnect all clients first. Old binaries do not collect Trial
3; old config writers may drop its settings, stopping collection. Existing
records prevent preparing it again after such loss.

Before activation, record the reviewed commit and SHA-256 hashes of this
protocol, the selector, collector and harvesting code in the owner's private
trial record. Review the protocol and inherited project lists, then run
`veto lessons trial` in your own terminal and type `yes`. This accepts the
displayed trial id and lists, which cannot change after consent. Sharing alone
never starts collection. Material changes to selection or harvesting during
the run invalidate it; no reinterpretation of its observations is allowed.

`veto lessons trial close` withdraws consent and keeps evidence.
`veto lessons trial previous` displays Trial 2. `veto lessons off` deletes
notes and records for all trials, as disclosed by that command.

## Collection rules

The window starts at fresh consent and ends after 70 days or the session
bringing the count to at least 12 selected note occurrences, whichever comes
first. The same note in two sessions counts twice. Collection advances during
session saves within the existing shared 150 ms harvesting budget.

Only Codex sessions beginning inside the window count. Subagents and ignored
projects cannot contribute selections; a nonempty inclusion list restricts
projects further. Read at most 256 KiB of each rollout's opening and use its
first actual request after existing injected-context filtering. Do not skip
continuation commands to find a more favorable request. Store choices, never
request text. Record ignored sessions as skipped without selection.

Use lexical-alias-v1: deterministic BM25, technical alias normalization,
scope/quarantine and disabled-source checks, native-context and stale-status
filtering, deduplication, indivisible notes and a 500 estimated-token cap.
Only notes available and unchanged at the session's start are eligible.
Trial 2 continues using its original selector. Trial 3 rows have `trial_id=3`;
earlier rows never contribute to its counters. Qualifying outcomes are
`selected` and `no_match`; report all other outcomes separately. Archiving
uses existing transcript consent and retention. No collection invokes an AI.

## Assessment

During the run, monitor counts only; do not inspect choices against sessions
or label them. Prior trials and development fixtures are not prospective
evidence. After the window, take the first 12 note occurrences by session start,
session id, then selector rank. Apply this cap before excluding absent session
evidence or notes changed/deleted since selection; never replace exclusions.
Report exclusions and overshoot. Exclude sessions created solely to feed the
trial using an owner list sealed before assessment, and report that count.

Judging is a separate owner-authorized step disclosing the masked notes and
session text to be sent to an AI. Use a fresh Claude Sonnet judge outside all
projects with no tools, MCP servers or development history. Record the exact
model id, sample hash, control seed, prompt hash and scoring-script hash before
running it once. Supply masked session evidence and candidate notes without
revealing selected status. Where an eligible unselected note exists, mix in
one randomly drawn control from that session-start pool. Missing historical
control evidence is a reported limitation, never reconstructed from later
notes. The author labels before seeing judge labels; report agreement and
use the judge's labels for the result.

Ask whether each note was accurate and durable for this work, whether it
could prevent an error, save work or change a decision, and whether stale,
wrong or unauthorized instructions could cause harm. Uncertainty does not
establish truth/usefulness; harm requires a clear case. Submitted labels are
final. All four thresholds must pass: at least 80% real with a 90% Wilson
lower bound of at least 60%; at least six real; at least half of the real
occurrences useful; and none harmful. Insufficient yield fails. Withdrawal
is early termination, not a completed result. Passing only permits considering
a delivery design; it does not authorize delivery or change sharing consent.

Limits include one owner, a small sample, AI judgment, harvest lag and evidence
attrition. Synthetic alias recovery is not an accuracy estimate. Yield may
still be inadequate.
