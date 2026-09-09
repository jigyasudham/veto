#!/usr/bin/env node
// The packaged `veto-server` entry point.
//
// This file exists so that starting the server never depends on comparing the
// running module's path against process.argv[1]. npm installs a bin as a symlink
// on macOS and Linux, so any such comparison sees a resolved path on one side and
// the link path on the other, fails, and the process exits 0 without ever
// answering MCP initialize — issue #39. Here there is nothing to compare: being
// run is the whole contract of this module, so it calls main() unconditionally.
//
// src/server.ts stays import-safe for tests, which import callTool from it and
// must not start a stdio transport as a side effect.
import { main } from '../server.js';

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
