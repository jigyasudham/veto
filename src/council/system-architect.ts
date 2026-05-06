// System Architect — scalability, failure modes, structural integrity
import type { AgentVote } from './types.js';

const BLOCK_RULES: Array<{ pattern: RegExp; reason: string; recommendation: string }> = [
  {
    pattern: /\bdrop\s+table\b/i,
    reason: 'DROP TABLE is irreversible. No rollback possible after execution.',
    recommendation: 'Write a down-migration. Verify backup. Test on staging. Run in maintenance window.',
  },
  {
    pattern: /\btruncate\b/i,
    reason: 'TRUNCATE deletes all rows instantly — no transaction, no rollback.',
    recommendation: 'Use DELETE with WHERE in a transaction. Backup first. Verify on staging.',
  },
  {
    pattern: /\bdelete\s+from\b(?!.*where)/i,
    reason: 'DELETE without WHERE clause wipes the entire table.',
    recommendation: 'Always add a WHERE clause. Wrap in transaction. Test on staging.',
  },
  {
    pattern: /sqlite.{0,50}(concurrent|multi.?user|high.?traffic|production|scale)/i,
    reason: 'SQLite serializes writes — breaks at >10 concurrent writers.',
    recommendation: 'Use PostgreSQL for multi-user or high-traffic applications.',
  },
  {
    pattern: /(payment|billing|charge|transfer|transaction).{0,40}no.{0,15}(transaction|rollback|atomic)/i,
    reason: 'Financial operations without database transactions risk data inconsistency.',
    recommendation: 'Wrap all financial mutations in explicit BEGIN/COMMIT/ROLLBACK transactions.',
  },
  {
    pattern: /store.{0,20}(password|credit.?card|ssn|social.?security).{0,20}plain/i,
    reason: 'Storing sensitive data in plaintext is a catastrophic data breach risk.',
    recommendation: 'Hash passwords (bcrypt). Encrypt PII at rest (AES-256). Never store raw card data.',
  },
];

const WARN_RULES: Array<{ pattern: RegExp; concern: string; recommendation: string }> = [
  {
    pattern: /select\s+\*/i,
    concern: 'SELECT * fetches all columns — wasted memory and network on large tables.',
    recommendation: 'Select only needed columns explicitly.',
  },
  {
    pattern: /\bfor\b.{0,80}(query|select|db\.|\.find|\.get|fetch)/i,
    concern: 'Query inside a loop creates N+1 problem — DB gets hammered at scale.',
    recommendation: 'Batch the query outside the loop using IN clause or JOIN.',
  },
  {
    pattern: /no.{0,15}index\b/i,
    concern: 'Missing index on search/filter columns causes full table scans.',
    recommendation: 'Add indexes on FK columns and any WHERE/ORDER BY columns.',
  },
  {
    pattern: /synchronous|blocking.{0,20}(i\/o|read|write|call)/i,
    concern: 'Synchronous I/O blocks the Node.js event loop under concurrent load.',
    recommendation: 'Use async/await with fs.promises, not fs.readFileSync.',
  },
  {
    pattern: /no.{0,15}cache\b/i,
    concern: 'No caching on repeated reads hammers the database unnecessarily.',
    recommendation: 'Cache hot read paths with Redis or in-memory TTL cache.',
  },
  {
    pattern: /no.{0,15}(timeout|time.?out)\b/i,
    concern: 'External calls without timeout hang indefinitely when the dependency fails.',
    recommendation: 'Set explicit timeouts (3-5s for APIs). Add retry with exponential backoff.',
  },
  {
    pattern: /single.{0,25}(point|server|node|instance).{0,25}(fail|crash|down)/i,
    concern: 'Single point of failure with no redundancy — one crash = full outage.',
    recommendation: 'Add health checks. Consider redundancy or graceful degradation.',
  },
  {
    pattern: /no.{0,15}(migration|schema.?version)/i,
    concern: 'Database changes without versioned migrations cannot be safely rolled back.',
    recommendation: 'Use a migration tool (Knex, Prisma migrate, Flyway).',
  },
  {
    pattern: /global\s+(state|variable|singleton)/i,
    concern: 'Global mutable state causes unpredictable behavior under concurrent requests.',
    recommendation: 'Scope state to request context. Use dependency injection.',
  },
  {
    pattern: /\bregex\b.{0,30}(user.?input|unvalidated|untrusted)/i,
    concern: 'Complex regex on untrusted input can cause ReDoS (catastrophic backtracking).',
    recommendation: 'Use simple regex patterns. Set timeout on regex evaluation for user input.',
  },
];

const TRIVIAL = /^(rename|fix typo|reorder|reformat|format|update comment|add comment)\b/i;

const TOPIC_INSIGHTS: Array<{ pattern: RegExp; concern: string; recommendation: string }> = [
  {
    pattern: /mcp|stdio|transport|protocol|server/i,
    concern: 'stdio MCP transport processes one message at a time per connection. If any handler blocks the event loop (e.g. sync SQLite writes, CPU-heavy regex), all tool calls queue behind it.',
    recommendation: 'Keep all MCP handlers async. Move any CPU-intensive work off the main handler with setImmediate or worker threads. Benchmark handler latency under concurrent tool calls.',
  },
  {
    pattern: /sqlite|database|db|persist|schema/i,
    concern: 'SQLite WAL mode serialises writes but allows concurrent reads. Multiple MCP connections sharing one DB file without connection pooling can cause SQLITE_BUSY errors under load.',
    recommendation: 'Use a single shared DB connection with WAL mode. For high-write scenarios, batch writes in transactions. Add busy_timeout pragma to handle lock contention gracefully.',
  },
  {
    pattern: /agent|worker|executor|parallel/i,
    concern: 'A growing agent registry with a single switch-case dispatcher becomes a maintenance liability. Every new agent type requires editing the central switch.',
    recommendation: 'Consider a registry pattern: agents register themselves at import time. The executor resolves by key, not by switch-case. New agents require no changes to the executor.',
  },
  {
    pattern: /llm|model|ai.?call|external.?api|fetch|http/i,
    concern: 'LLM calls introduce an external dependency with variable latency (2–30s) and failure modes. The server must handle timeout, rate limit, and model error without crashing the MCP connection.',
    recommendation: 'Wrap every external call in a circuit breaker. Set explicit timeouts. Cache responses where idempotency allows. Return a structured degraded response on failure, never throw.',
  },
  {
    pattern: /version|package\.json|semver/i,
    concern: 'Multiple hardcoded version strings across server.ts, cli.ts, and adapter files create a drift problem that gets worse with each release.',
    recommendation: 'Single source: read version from package.json at startup. Export it from one shared module. All other files import it.',
  },
  {
    pattern: /plugin|extensi|loader|dynamic.?import/i,
    concern: 'Dynamic plugin loading from user directories creates a security boundary: any code in ~/.veto/agents/ runs with full server privileges. There is currently no sandboxing.',
    recommendation: 'Validate plugin exports schema before loading. Consider running plugins in a restricted vm.Script context. Log all plugin load events to the audit trail.',
  },
  {
    pattern: /vscode|extension|ide|ui|frontend/i,
    concern: 'VS Code extension + MCP server creates a distributed architecture: the extension communicates with the server via MCP protocol, not direct function calls. Version compatibility between extension and server must be managed explicitly.',
    recommendation: 'Define a minimum server version requirement in the extension. On connect, call veto_status and verify server version meets the minimum. Show a clear upgrade prompt if not.',
  },
  {
    pattern: /phase|roadmap|migrat|upgrade/i,
    concern: 'Schema migrations that run inline in the DB constructor (as currently implemented) are safe for additive changes but risky for destructive ones. There is no migration version tracking.',
    recommendation: 'Add a schema_version table. Record each migration with a unique ID. Before running a migration, check if it has already been applied. This prevents re-running on restart.',
  },
];

export function analyze(task: string): AgentVote {
  if (TRIVIAL.test(task.trim())) {
    return { verdict: 'approve', reason: 'Trivial change — no architectural concerns.', concerns: [] };
  }

  const blocks: Array<{ reason: string; recommendation: string }> = [];
  const concerns: string[] = [];
  const recommendations: string[] = [];

  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(task)) {
      blocks.push({ reason: rule.reason, recommendation: rule.recommendation });
    }
  }
  for (const rule of WARN_RULES) {
    if (rule.pattern.test(task)) {
      concerns.push(rule.concern);
      recommendations.push(rule.recommendation);
    }
  }

  if (blocks.length > 0) {
    return {
      verdict: 'block',
      reason: blocks[0].reason,
      concerns: blocks.slice(1).map(b => b.reason),
      recommendation: blocks.map(b => b.recommendation).join(' | '),
    };
  }

  if (concerns.length > 0) {
    return {
      verdict: 'warn',
      reason: `${concerns.length} structural concern${concerns.length > 1 ? 's' : ''} — review before building.`,
      concerns,
      recommendation: recommendations[0],
    };
  }

  const matched = TOPIC_INSIGHTS.filter(t => t.pattern.test(task));
  if (matched.length > 0) {
    const top = matched.slice(0, 2);
    return {
      verdict: 'warn',
      reason: top[0].concern,
      concerns: top.slice(1).map(t => t.concern),
      recommendation: top.map(t => t.recommendation).join(' | '),
    };
  }

  return { verdict: 'approve', reason: 'Architecture looks sound. No structural concerns identified.', concerns: [] };
}
