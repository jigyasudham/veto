# Veto 3.11.0 — release candidate

Trial 3 connects lexical-alias-v1 to prospective shadow collection. Veto
3.10.0 only provided a preview; it could not start Trial 3.

Run `veto lessons trial prepare` after Trial 2 closes or finishes. This retains
Trial 2's evidence and consent receipt, copies the project lists, and prepares
fresh Trial 3 settings without starting collection. Review the
[protocol](TRIAL-3.md) and lists, then run `veto lessons trial` in your own
terminal and type `yes` to start.

Trial 3 remains local and deterministic, stops at 12 chosen note occurrences
or 70 days, and delivers no notes to any AI. It keeps the first-request trigger
and shared save-time budget. Its counters are separate from earlier trials.
`veto lessons trial previous` displays Trial 2; `trial close` preserves evidence
on withdrawal. Preparation cannot reset a started Trial 3.

Upgrade and reconnect every client before activation. Old binaries cannot
collect Trial 3, and their config writes can drop its settings, stopping
collection. Existing Trial 3 rows prevent preparation from silently restarting
it after such loss. No database migration or historical re-scoring occurs.

Preview stays unavailable while a trial runs. Trial 2 keeps its original
selector. Development alias tests do not establish real-world usefulness;
assessment is a separate owner-authorized step after collection ends.

Design council b571b50b-8131-4446-90f9-a0fc28288165: YELLOW, with conditions for
fresh consent, isolation, frozen rules and restart prevention. This was
host-reasoned review, not independent evidence of effectiveness.

Before release: pass the Linux/Windows Node matrix and package checks, run the
release workflow in dry-run mode, and freeze the reviewed protocol/source
hashes before activation. Publication and activation are separate steps.
