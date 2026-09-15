---
name: quoting-rule
description: "Inline interpreter scripts lose their backslashes in the Git Bash tool — write a script file instead"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 00000000-0000-4000-8000-000000000001
  modified: 2026-09-01T10:00:00.000Z
---

Inline interpreter scripts passed through the Git Bash tool lose every backslash, which silently corrupted a hash manifest once.

**Why:** Bash consumes the escapes before the interpreter sees them, and nothing reports it.

**How to apply:** anything containing backslashes or nested quotes goes in a script file in the scratchpad, never inline.

Related: [[encoding-gotchas]]
