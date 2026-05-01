import { AgentPlan, WorkerAgentType } from '../types.js';

type DbType = 'rdbms' | 'nosql' | 'timeseries' | 'graph' | 'general';

function detectDbType(task: string, context?: string): DbType {
  const combined = (task + ' ' + (context ?? '')).toLowerCase();
  if (combined.includes('mongo') || combined.includes('document') || combined.includes('dynamodb') || combined.includes('firestore') || combined.includes('nosql')) return 'nosql';
  if (combined.includes('timeseries') || combined.includes('influx') || combined.includes('prometheus') || combined.includes('clickhouse') || combined.includes('time series')) return 'timeseries';
  if (combined.includes('graph') || combined.includes('neo4j') || combined.includes('relationship')) return 'graph';
  if (combined.includes('postgres') || combined.includes('mysql') || combined.includes('sqlite') || combined.includes('sql') || combined.includes('relational')) return 'rdbms';
  return 'general';
}

const dbApproach: Record<DbType, string> = {
  rdbms: 'Design a normalised schema first (3NF), add indexes for every foreign key and frequent filter column, use transactions for multi-table mutations, plan migration scripts with backward compatibility.',
  nosql: 'Design around access patterns — denormalise to serve queries in one round trip. Choose partition keys that distribute load evenly. Model for reads, use references sparingly for writes.',
  timeseries: 'Optimise for append-heavy write patterns. Use time-bucketed partitioning. Compress old data with downsampling. Design queries around time ranges, not individual rows.',
  graph: 'Model entities as nodes and relationships as edges with properties. Index node labels and edge types. Design traversal patterns and bound depth of recursive queries.',
  general: 'Evaluate RDBMS vs NoSQL based on data structure, access patterns, and consistency requirements. Design schema to serve the most frequent query without joins if possible.',
};

export function plan(task: string, context?: string): AgentPlan {
  const dbType = detectDbType(task, context);

  return {
    agent: 'database' as WorkerAgentType,
    task,
    tier: 3,
    approach: dbApproach[dbType],
    steps: [
      'List all entities and their relationships — draw an ER diagram',
      'Identify the top 5 most frequent query patterns (what will be read most?)',
      'Design the schema to serve those queries with minimal joins/lookups',
      'Add primary keys and unique constraints first',
      'Add foreign key constraints for relational integrity',
      'Identify every column used in WHERE, ORDER BY, or JOIN — add indexes',
      'Choose composite index column order by selectivity (most selective first)',
      'Design the migration script: additive changes first (new tables, new nullable columns)',
      'Write seed / fixture data for the development environment',
      'Write query tests that assert on execution plan (EXPLAIN ANALYZE)',
      'Set up connection pooling with appropriate pool size for the workload',
      'Configure statement_timeout and lock_timeout to prevent runaway queries',
      'Plan archival strategy for old data — partitioning or archival table',
      'Document the schema with comments on each table and non-obvious column',
    ],
    checklist: [
      '[ ] Every table has a primary key',
      '[ ] Foreign keys are declared and indexed',
      '[ ] Every JOIN column on the many-side has an index',
      '[ ] Every column used in frequent WHERE clauses has an index',
      '[ ] No SELECT * in production queries — enumerate columns',
      '[ ] Multi-table mutations wrapped in transactions',
      '[ ] Migrations are reversible (down migration written)',
      '[ ] Migration tested on a copy of production data volume',
      '[ ] Connection pool size calculated: connections = (core_count * 2) + effective_spindle_count',
      '[ ] statement_timeout configured to prevent runaway queries',
      '[ ] EXPLAIN ANALYZE run on all slow query candidates',
      '[ ] Sensitive columns (PII, passwords) identified and encrypted at rest',
      '[ ] Backup and point-in-time recovery tested',
      '[ ] Schema documented with table and column comments',
    ],
    pitfalls: [
      'Using SELECT * in application queries — sends unnecessary data over the wire and breaks when columns are added/removed',
      'Forgetting to index foreign keys — causes full table scans on every JOIN',
      'Storing JSON blobs in relational databases to avoid schema work — kills query performance and integrity',
      'Not wrapping multi-step mutations in a transaction — leaves the database in a partially updated state on failure',
      'Using ORM-generated schemas without reviewing the SQL — ORMs frequently generate non-optimal index choices',
      'Choosing UUID as a clustered primary key in PostgreSQL without understanding write amplification from random page splits',
      'Ignoring VACUUM in PostgreSQL — table bloat degrades read performance over time',
      'Testing migrations only on an empty database — schema changes that work on empty DBs may lock production tables for minutes',
    ],
    patterns: [
      'Repository pattern (abstract DB access behind an interface)',
      'Unit of Work pattern (group related DB operations into a transaction)',
      'CQRS (separate read and write models for high-throughput systems)',
      'Event Sourcing (store events, derive state — for audit-heavy domains)',
      'Optimistic locking (version column for concurrent update detection)',
      'Soft delete pattern (deleted_at timestamp instead of hard DELETE)',
      'Temporal tables (track history of row changes)',
    ],
    duration_estimate: '1-2 days',
  };
}
