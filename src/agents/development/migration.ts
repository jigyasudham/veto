import { AgentPlan, WorkerAgentType } from '../types.js';

type MigrationType = 'schema' | 'data' | 'platform' | 'zero-downtime' | 'general';

function detectMigrationType(task: string, context?: string): MigrationType {
  const combined = (task + ' ' + (context ?? '')).toLowerCase();
  if (combined.includes('zero downtime') || combined.includes('blue-green') || combined.includes('rolling') || combined.includes('live migration')) return 'zero-downtime';
  if (combined.includes('data migration') || combined.includes('backfill') || combined.includes('etl') || combined.includes('transform data')) return 'data';
  if (combined.includes('platform') || combined.includes('cloud') || combined.includes('aws') || combined.includes('gcp') || combined.includes('azure') || combined.includes('move')) return 'platform';
  if (combined.includes('schema') || combined.includes('column') || combined.includes('table') || combined.includes('database') || combined.includes('alter')) return 'schema';
  return 'general';
}

const typeApproach: Record<MigrationType, string> = {
  schema: 'Expand-Migrate-Contract pattern: first add new columns as nullable (backward compatible), then backfill, then add constraints, then remove old columns. Each phase is a separate deployment.',
  data: 'Write idempotent backfill scripts that can be re-run safely. Process in batches of 1000-10000 rows to avoid locking. Verify row counts before and after. Keep the original data until verified.',
  platform: 'Run old and new platforms in parallel. Migrate traffic gradually (10% → 50% → 100%). Maintain rollback capability at each step. Verify data consistency between platforms before cutover.',
  'zero-downtime': 'Decouple schema changes from code changes. Make schema additive first. Deploy code that supports both old and new schema. Then migrate schema. Then deploy code that requires new schema only.',
  general: 'Always take a backup before migrating. Test the migration on a staging environment with production-volume data. Plan and rehearse the rollback procedure before starting.',
};

const typeSteps: Record<MigrationType, string[]> = {
  schema: [
    'Take a full database backup and verify it is restorable',
    'Analyse the table size — migrations on large tables require extra care',
    'Write the expansion migration: add new nullable columns or tables (no data changes)',
    'Deploy the expansion migration to staging and verify with EXPLAIN on common queries',
    'Deploy the expansion migration to production — additive changes are safe and fast',
    'Write the application code that writes to both old and new columns simultaneously',
    'Deploy the dual-write code to production',
    'Write the backfill script: UPDATE new_column = derive(old_column) WHERE new_column IS NULL LIMIT 10000',
    'Run the backfill in batches during low-traffic hours, monitoring DB load',
    'Verify: SELECT COUNT(*) WHERE new_column IS NULL — should return 0',
    'Deploy code that reads from new columns only',
    'Write the contract migration: add NOT NULL constraint, create indexes, drop old columns',
    'Deploy the contract migration to production during a maintenance window',
    'Verify application health and run smoke tests',
  ],
  data: [
    'Define the transformation logic and document the expected output for a sample of rows',
    'Write the backfill script as an idempotent operation (re-running it produces the same result)',
    'Test the script on 100 rows in staging and manually verify the output',
    'Measure the script execution time on staging at full data volume',
    'Schedule the production backfill during the lowest-traffic window',
    'Process in batches: use LIMIT + WHERE id > last_processed_id to paginate',
    'Add a progress counter — log every N rows processed',
    'Monitor DB CPU, lock waits, and replication lag during the backfill',
    'Pause the script automatically if replication lag exceeds a threshold',
    'Verify row counts: SELECT COUNT(*) before and after should balance',
    'Spot-check 10-20 randomly selected rows — manual verification of the transformation',
    'Keep the original data in the source columns or a backup table until fully verified',
    'Archive or drop the source data only after a defined hold period (e.g., 30 days)',
  ],
  platform: [
    'Document all dependencies of the current platform (databases, queues, external services)',
    'Set up the new platform environment with identical configuration',
    'Migrate all secrets and configuration to the new platform\'s secrets manager',
    'Deploy the application to the new platform and run full integration tests',
    'Set up a data sync from old to new platform (replication or CDC with Debezium)',
    'Route 5% of production traffic to the new platform and monitor error rates',
    'Compare metrics between old and new platform over 24 hours',
    'Increase traffic to 25%, 50%, 75%, 100% with monitoring gates at each step',
    'When at 100%, stop new writes to the old platform and verify replication caught up',
    'Run a final data consistency check between old and new platform',
    'Update DNS/load balancer to point exclusively to new platform',
    'Keep the old platform running for 7 days as a rollback option',
    'Decommission the old platform after the hold period',
  ],
  'zero-downtime': [
    'Identify all schema changes needed and classify each as additive (safe) or destructive (requires care)',
    'Phase 1 — Expansion: add new tables and nullable columns without removing anything',
    'Deploy Phase 1 migration — no code change needed, old code still works',
    'Phase 2 — Compatibility code: deploy app code that writes to old and new columns, reads from new if available',
    'Verify Phase 2 is working correctly in staging for 24+ hours',
    'Phase 3 — Backfill: run idempotent backfill to populate new columns from old data',
    'Verify backfill completeness: zero rows with NULL in new columns',
    'Phase 4 — New code: deploy app code that reads exclusively from new columns',
    'Monitor for 24 hours — check error rates and data correctness',
    'Phase 5 — Contract: add NOT NULL constraints, create indexes, drop old columns',
    'Verify final state with integration tests and manual spot-checks',
    'Document the completed migration and update the schema documentation',
  ],
  general: [
    'Take a full backup of all data involved in the migration',
    'Verify the backup is restorable by doing a test restore on a separate instance',
    'Write the migration script and test it thoroughly on staging',
    'Test the rollback procedure on staging — confirm you can undo the migration',
    'Calculate the expected execution time at production data volume',
    'Plan the maintenance window if downtime is required',
    'Communicate the migration plan and timeline to stakeholders',
    'Execute the migration and monitor closely',
    'Run smoke tests immediately after migration',
    'Monitor for 24-48 hours before declaring success',
    'Document lessons learned',
  ],
};

export function plan(task: string, context?: string): AgentPlan {
  const migrationType = detectMigrationType(task, context);

  return {
    agent: 'migration' as WorkerAgentType,
    task,
    tier: 3,
    approach: typeApproach[migrationType],
    steps: typeSteps[migrationType],
    checklist: [
      '[ ] Full backup taken and restore tested before starting',
      '[ ] Migration tested on staging with production data volume',
      '[ ] Rollback procedure written, tested, and rehearsed',
      '[ ] Execution time estimated at production scale',
      '[ ] Stakeholders notified of migration plan and timeline',
      '[ ] Backfill script is idempotent — safe to re-run on failure',
      '[ ] Backfill processes in batches — no single query that locks the whole table',
      '[ ] Replication lag monitored during migration',
      '[ ] Row counts verified before and after migration',
      '[ ] Smoke tests pass immediately after migration',
      '[ ] Application metrics (error rate, latency) normal after migration',
      '[ ] Old data retained for a defined hold period before deletion',
      '[ ] Schema documentation updated',
      '[ ] Post-migration review scheduled for 48 hours after cutover',
    ],
    pitfalls: [
      'Running ALTER TABLE on a large table without ALGORITHM=INPLACE or pg_rewrite — locks the table for minutes and causes downtime',
      'Not testing the rollback — every migration plan needs a verified rollback procedure',
      'Backfilling without batching — a single UPDATE affecting millions of rows holds a table lock for minutes',
      'Migrating production without staging validation — staging exists for this purpose',
      'Not monitoring replication lag during the migration — a lagging replica causes stale reads',
      'Removing the old columns before the application is fully migrated to the new columns',
      'Skipping the data verification step — corrupted data may not surface for days',
      'Under-estimating the time at production data volume — test with realistic row counts',
    ],
    patterns: [
      'Expand-Migrate-Contract pattern (safe schema evolution)',
      'Dual-write pattern (write to old and new during transition)',
      'Strangler Fig pattern (gradually replace old system with new)',
      'Blue/Green deployment (parallel environments for zero-downtime cutover)',
      'Change Data Capture (CDC) for live platform migrations',
      'Idempotent migration scripts (safe to re-run)',
      'Feature flag gating (roll out new schema reading gradually)',
    ],
    duration_estimate: '2-5 days',
  };
}
