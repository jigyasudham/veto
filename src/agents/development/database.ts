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

const dbSteps: Record<DbType, string[]> = {
  rdbms: [
    'List all entities and their relationships — draw an ER diagram',
    'Identify the top 5 most frequent query patterns to design for',
    'Design a normalised schema (3NF) — denormalise only where profiling justifies it',
    'Add primary keys and unique constraints first',
    'Add foreign key constraints with ON DELETE / ON UPDATE rules',
    'Identify every column used in WHERE, ORDER BY, or JOIN — add indexes',
    'Choose composite index column order: most selective column first',
    'Run EXPLAIN ANALYZE on all query candidates — eliminate seq scans on large tables',
    'Design the migration: additive changes first (new tables, nullable columns), then breaking changes',
    'Write down migration: ensure every up migration has a working down migration',
    'Write seed / fixture data for the development environment',
    'Set up connection pooling: pool_size = (cpu_cores × 2) + effective_spindles',
    'Configure statement_timeout and lock_timeout to prevent runaway queries',
    'Plan archival strategy: partition by date or move old rows to an archive table',
    'Document each table and non-obvious column with SQL comments',
  ],
  nosql: [
    'List all read patterns (what queries will the app run most?) — design the schema around them',
    'Choose partition key to distribute writes evenly — avoid hot partitions',
    'Denormalise aggressively to serve each query in one round-trip',
    'Design document structure: embed sub-documents for one-to-few, reference for one-to-many',
    'Choose sort key or secondary index for each filtering / ordering requirement',
    'Plan for write amplification on denormalised data — updates must touch all copies',
    'Design TTL fields for ephemeral data (sessions, tokens, cache entries)',
    'Set up sparse indexes only on fields present in a subset of documents',
    'Write aggregation pipeline queries for reporting use cases',
    'Test throughput under expected partition volume — check for hot-key throttling',
    'Design a document versioning strategy if schema may evolve',
    'Plan backup and point-in-time restore procedure',
  ],
  timeseries: [
    'Define the time resolution: seconds, minutes, hours — choose before schema design',
    'Design the schema with time as the primary partition dimension',
    'Set a data retention policy — define how long raw data is kept before downsampling',
    'Design a downsampling strategy: aggregate raw to 1-min → 1-hour → 1-day buckets',
    'Choose the compression algorithm: time-series data compresses 10–50× with delta encoding',
    'Design queries around time ranges — avoid point queries on individual timestamps',
    'Add secondary indexes only on high-cardinality tag fields used in filter conditions',
    'Plan continuous aggregates or materialised views for dashboards',
    'Test write throughput: time-series DBs can handle 100k+ writes/sec but not random updates',
    'Design an alerting / anomaly detection query alongside the schema',
    'Plan data tiering: hot (SSD) for recent data, cold (object store) for historical',
    'Document metric naming conventions: use consistent unit suffixes (_bytes, _ms, _count)',
  ],
  graph: [
    'Model entities as nodes with labels — keep labels broad (Person, not Manager)',
    'Model relationships as directed edges with descriptive names (FOLLOWS, AUTHORED, BELONGS_TO)',
    'Add properties to both nodes and relationships as needed',
    'Identify the traversal patterns: depth, direction, and filter conditions',
    'Bound recursive traversal depth — unbounded traversals on dense graphs are a DoS vector',
    'Add indexes on node labels and properties used in MATCH / WHERE filters',
    'Add relationship type indexes for frequently traversed edge types',
    'Design queries to avoid Cartesian products — always start from a specific node',
    'Use PROFILE and EXPLAIN to verify the query planner uses indexes, not full graph scans',
    'Test with realistic data volume — graph performance degrades non-linearly with density',
    'Design a data import strategy for bulk loading initial nodes and relationships',
    'Document the graph schema: node labels, edge types, and property meanings',
  ],
  general: [
    'Evaluate RDBMS vs NoSQL based on: data structure, access patterns, consistency needs, team familiarity',
    'List all entities and relationships before choosing a storage model',
    'Design the schema to serve the most frequent query without joins if possible',
    'Define primary identifiers and uniqueness constraints for all entities',
    'Plan indexing strategy based on query patterns, not table structure',
    'Design migrations to be additive and reversible',
    'Set up connection pooling and query timeouts',
    'Plan backup, restore, and disaster recovery procedure',
    'Document the schema before writing application code',
    'Write fixture data for development and testing environments',
  ],
};

const dbChecklist: Record<DbType, string[]> = {
  rdbms: [
    '[ ] Every table has a primary key',
    '[ ] Foreign keys declared and indexed',
    '[ ] Every JOIN column on the many-side has an index',
    '[ ] Frequent WHERE / ORDER BY columns indexed',
    '[ ] No SELECT * in production queries',
    '[ ] Multi-table mutations wrapped in explicit transactions',
    '[ ] Migrations are reversible — down migration written and tested',
    '[ ] Migration tested on a copy of production data volume',
    '[ ] EXPLAIN ANALYZE run on all slow query candidates',
    '[ ] statement_timeout and lock_timeout configured',
    '[ ] Sensitive columns (PII, passwords) encrypted at rest',
    '[ ] Backup and point-in-time recovery tested',
  ],
  nosql: [
    '[ ] Partition key distributes writes evenly — no hot partitions',
    '[ ] Schema designed around read patterns, not entity structure',
    '[ ] TTL set on ephemeral data (sessions, tokens)',
    '[ ] Secondary indexes defined for filter/sort query patterns',
    '[ ] Write amplification accounted for on denormalised fields',
    '[ ] Throughput limits set (RCU/WCU on DynamoDB; collection limits on MongoDB)',
    '[ ] Aggregation pipelines tested for performance on expected data volume',
    '[ ] Backup and restore procedure documented',
  ],
  timeseries: [
    '[ ] Retention policy defined and configured',
    '[ ] Downsampling/aggregation jobs scheduled',
    '[ ] Write throughput tested at expected ingestion rate',
    '[ ] Queries use time-range filters — no full scans',
    '[ ] Compression enabled',
    '[ ] Data tiering configured (hot/warm/cold)',
    '[ ] Metric naming follows consistent conventions',
    '[ ] Alerting queries validated against sample data',
  ],
  graph: [
    '[ ] Traversal depth bounded in all recursive queries',
    '[ ] Indexes on all node properties used in MATCH/WHERE',
    '[ ] PROFILE/EXPLAIN run on all queries — no full graph scans',
    '[ ] Relationship types named descriptively (verb form)',
    '[ ] Cartesian products eliminated from all queries',
    '[ ] Graph schema documented with node labels, edge types, properties',
    '[ ] Performance tested at realistic data density',
  ],
  general: [
    '[ ] Storage model choice justified by access patterns',
    '[ ] All entity identifiers and uniqueness constraints defined',
    '[ ] Indexing strategy documented',
    '[ ] Migrations reversible',
    '[ ] Connection pooling and timeouts configured',
    '[ ] Backup and restore procedure documented',
  ],
};

const dbPitfalls: Record<DbType, string[]> = {
  rdbms: [
    'Forgetting to index foreign keys — causes full table scans on every JOIN',
    'Using SELECT * — sends unnecessary columns and breaks when schema changes',
    'Not wrapping multi-step mutations in a transaction — leaves DB in partial state on failure',
    'UUID primary keys as clustered index in Postgres/MySQL — random page splits cause write amplification',
    'Testing migrations only on empty DB — schema changes that work on empty can lock production tables for minutes',
    'Ignoring VACUUM in PostgreSQL — table bloat silently degrades read performance over time',
  ],
  nosql: [
    'Choosing a partition key that creates a hot partition — a single popular item throttles the whole table',
    'Designing schema around entities, not access patterns — results in expensive scans',
    'Storing everything in one giant document — updates lock the whole document',
    'Forgetting write amplification on denormalised data — one logical update becomes many physical writes',
    'Using NoSQL for highly relational data with many join patterns — it fights the tool',
  ],
  timeseries: [
    'Storing time-series data in a relational DB — no compression, no time-range index, poor write throughput',
    'Not setting retention policies — storage grows unbounded, DB slows, costs explode',
    'Querying individual timestamps instead of time ranges — defeats time-series index',
    'Not downsampling old data — petabytes of raw data that nobody queries',
    'Choosing a cardinality that is too high (e.g., UUID as a tag) — kills index performance',
  ],
  graph: [
    'Unbounded recursive traversal on a dense graph — returns the entire graph, crashes the DB',
    'Modelling a relational dataset as a graph — forces traversals where a JOIN would be simpler',
    'Not indexing node properties used in MATCH — causes full graph scans',
    'Cartesian products from multiple MATCH clauses without LIMIT — exponential result explosion',
    'Storing too many properties on relationships — use nodes for complex data, edges for simple relationships',
  ],
  general: [
    'Choosing a DB based on hype rather than access patterns',
    'Designing schema before knowing the queries — always start with the access patterns',
    'Not testing with realistic data volumes — schema choices that work at 1k rows fail at 10M',
  ],
};

export function plan(task: string, context?: string): AgentPlan {
  const dbType = detectDbType(task, context);

  return {
    agent: 'database' as WorkerAgentType,
    task,
    tier: 3,
    approach: dbApproach[dbType],
    steps: dbSteps[dbType],
    checklist: dbChecklist[dbType],
    pitfalls: dbPitfalls[dbType],
    patterns: dbType === 'rdbms'
      ? ['Repository pattern', 'Unit of Work', 'CQRS', 'Event Sourcing', 'Optimistic locking', 'Soft delete pattern', 'Temporal tables']
      : dbType === 'nosql'
      ? ['Single-table design (DynamoDB)', 'Document embedding vs referencing', 'Aggregation pipeline pattern', 'Sparse index pattern', 'TTL pattern']
      : dbType === 'timeseries'
      ? ['Retention + downsampling pipeline', 'Continuous aggregates', 'Data tiering pattern', 'Anomaly detection query pattern']
      : dbType === 'graph'
      ? ['Labelled property graph model', 'Bidirectional relationship pattern', 'Subgraph extraction', 'Path-finding algorithms', 'Bounded traversal pattern']
      : ['Repository pattern', 'Query builder pattern', 'Connection pool pattern'],
    duration_estimate: dbType === 'rdbms' ? '1-2 days' : dbType === 'nosql' ? '1-2 days' : '2-3 days',
  };
}
