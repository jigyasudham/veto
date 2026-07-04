# Smithery Publishing Runbook

Veto is listed on Smithery as **`jigyasudham/veto`** (https://smithery.ai/servers/jigyasudham/veto).
(The original `jigyasudham123/veto` listing was deleted 2026-07-04; the `jigyasudham` namespace was claimed via `smithery namespace create jigyasudham` under the same account.)

Smithery distributes local stdio servers as **MCPB bundles** — a self-contained zip (built `dist/` + production `node_modules` + `manifest.json`) that clients download and run with their own Node. Unlike the npm/MCP-registry channels, the bundle does **not** auto-update via `@latest`; every release needs a re-publish.

## Per-release steps

```powershell
# 1. Stage: built dist + production deps + manifest
$stage = Join-Path $env:TEMP 'veto-mcpb'
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory $stage | Out-Null
npm run build
Copy-Item -Recurse dist $stage\dist
Copy-Item package.json, package-lock.json, LICENSE, README.md $stage
Set-Location $stage; npm ci --omit=dev; Set-Location -

# 2. Manifest: copy the template and keep its "version" in lockstep with package.json
Copy-Item mcpb.manifest.json $stage\manifest.json   # bump "version" first!

# 3. Pack (validates the manifest) and publish
npx -y @anthropic-ai/mcpb pack $stage veto-<version>.mcpb
smithery mcp publish .\veto-<version>.mcpb -n jigyasudham/veto
```

Auth: `smithery auth whoami` / `smithery auth login` (browser OAuth). Namespace is `jigyasudham` (`smithery namespace show` to confirm the CLI context).

Sanity check before publishing: pipe an `initialize` request into `node $stage/dist/server.js` and confirm `serverInfo` shows the new version.

Notes:
- `mcpb.manifest.json` (repo root) is the template; the packed bundle needs it named `manifest.json` at the bundle root.
- The `compact` user_config maps to `VETO_COMPACT` (`isCompactMode()` accepts `"true"`/`"false"`).
- `*.mcpb` artifacts are gitignored and excluded from npm by the `files` allowlist.
