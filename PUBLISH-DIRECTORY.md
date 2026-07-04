# Veto Publish Directory

Every place a Veto release goes, what format each channel takes, what it requires, and the
order to do it in. Companion runbook: [SMITHERY.md](./SMITHERY.md) for the Smithery bundle steps.

## Pre-release checklist (before touching any channel)

1. **Version lockstep — 4 fields, all identical:**
   - `package.json` → `version`
   - `server.json` → `version` (top level)
   - `server.json` → `packages[0].version`
   - `mcpb.manifest.json` → `version`
   (`src/server/runtime.ts` reads `VERSION` from package.json at runtime — no code edit needed.)
2. `README.md` → add a `### <version>` block under `## Release Notes`.
3. `npm run build` clean, full test suite green (`npm test`).
4. Smoke test: pipe an `initialize` request into `node dist/server.js` and confirm
   `serverInfo.version` shows the new version.
5. PR to `main` (never commit release bumps straight to main), merge, then tag `v<version>`
   on the merge commit.

## Channels (publish in this order)

### 1. GitHub — source of truth
- **What**: merged PR on `main`, annotated tag `v<version>`, GitHub Release marked Latest.
- **Format**: git tag + Release notes (mirror the README release-notes block).
- **Requirements**: `gh` CLI authenticated; repo `github.com/jigyasudham/veto`.
- **Command**: `gh release create v<version> --title "v<version>" --notes "..."`.

### 2. npm — must go FIRST of the package channels
- **What**: `@jigyasudham/veto` on registry.npmjs.org.
- **Format**: npm tarball; the `files` allowlist (`dist/`, `server.json`) keeps it ~0.5 MB —
  never remove that allowlist (2.5.0–2.7.2 accidentally shipped the whole working dir).
- **Requirements**:
  - npm account `jigyasudham`, logged in. **Gotcha:** npm masks an expired session as
    `E404 PUT` — if publish 404s, run `npm whoami`; a 401 means re-login via `npm login`
    (web flow), not a missing package.
  - `package.json` must keep the top-level `"mcpName": "io.github.jigyasudham/veto"` —
    the MCP registry proves npm ownership by reading it off the published npm metadata.
- **Command**: `npm publish --access public`.
- **Why first**: the MCP registry validates against the npm-published metadata, so npm must
  already have the new version.

### 3. Official MCP Registry — after npm
- **What**: `io.github.jigyasudham/veto` on registry.modelcontextprotocol.io.
- **Format**: `server.json` (schema 2025-12-11) pushed by `mcp-publisher`.
- **Requirements**: `mcp-publisher` binary (installed at `~/.local/bin/mcp-publisher.exe`,
  on PATH). **Gotcha:** the auth JWT (`~/.config/mcp-publisher/token.json`) expires in ~12
  days — run `mcp-publisher login github` before each publish.
- **Commands**: `mcp-publisher login github` (if token stale) → `mcp-publisher publish`.
- **Verify**: registry search for `jigyasudham` shows the new version with `isLatest: true`.

### 4. Smithery — manual re-publish EVERY release
- **What**: `jigyasudham/veto` on smithery.ai (namespace `jigyasudham`, claimed
  2026-07-04 via `smithery namespace create`; the old `jigyasudham123` listing is deleted).
- **Format**: **MCPB bundle** (`.mcpb` zip: `manifest.json` + built `dist/` + production
  `node_modules`). Bundles do NOT auto-update from npm — skipping this step leaves Smithery
  users on the old version.
- **Requirements**: `smithery` CLI logged in (`smithery auth whoami`); bump
  `mcpb.manifest.json` version BEFORE packing; full steps in [SMITHERY.md](./SMITHERY.md).
- **Commands** (abridged): stage dist + prod deps + manifest →
  `npx -y @anthropic-ai/mcpb pack <stage> veto-<version>.mcpb` →
  `smithery mcp publish .\veto-<version>.mcpb -n jigyasudham/veto`.
- `*.mcpb` artifacts are gitignored and excluded from npm.

### 5. Glama — automatic, verify only
- **What**: glama.ai listing, auto-tracked from GitHub/npm.
- **Requirements**: none per release. It builds with its own debian/pnpm builder (not our
  Dockerfile); "build failed" emails have been false alarms before — check the dashboard
  before reacting.

### One-time listings (not per-release)
- **awesome-mcp-servers**: PR punkpeye/awesome-mcp-servers#8994 (submitted 2026-06-30,
  awaiting maintainer merge). No action per release.

## Post-release verification

- `npm view @jigyasudham/veto version` → new version.
- MCP registry: `curl "https://registry.modelcontextprotocol.io/v0/servers?search=jigyasudham"`
  → new version, `isLatest: true`.
- Smithery: server page shows the new bundle under Releases; capability scan populates
  (if "No capabilities found" appears, check the Logs tab, then Smithery support).
- GitHub Release shows as Latest; tag points at the right commit.
- Clients on the pinned `npx … @latest` config pick up the npm release on next restart —
  nothing to do; the global CLI needs `npm i -g @jigyasudham/veto@latest`.
