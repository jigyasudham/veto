---
name: release-gotchas
description: Release gotchas for the demo service
type: project
---

Collected while shipping the demo service; keep adding to it.

## Console encoding (cp1252)

The Windows console decodes child-process output as cp1252, so UTF-8 arrows in log lines arrive as mojibake. Force UTF-8 output in the child instead.

## Release steps

```bash
npm version patch && git push --follow-tags
```

## Notes

The staging database is reset every Sunday.

## Notes

Version fields are bumped by line number, never by a blanket replace.
