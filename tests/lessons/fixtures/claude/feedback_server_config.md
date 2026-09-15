---
name: server-config
description: MCP server entry on Windows must use the .cmd shim
metadata:
  type: feedback
---

On Windows the MCP server entry has to call the shim form, `npx.cmd -y demo-server`, because a bare npx is not resolvable by the host.
