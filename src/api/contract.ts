// The `veto api` contract, version 1 — what an editor extension may rely on.
//
// Council 7bb1073f (YELLOW) settled the shape: a JSON CLI, not MCP tools, so an
// extension gets deterministic data without asking a model to call a tool and
// then parsing its prose. Each response is one JSON envelope on stdout.
//
// VERSIONING. `contract` changes only when something is removed or renamed.
// Within version 1 fields are only ever ADDED, so a reader must ignore fields it
// does not know. The schemas below are the source of truth; the JSON Schema
// files under contracts/api-v1/ are generated from them by tests/api (run it
// with UPDATE_CONTRACTS=1), and that test fails if the two differ.
//
// Mechanical tier (AGENTS.md): deterministic, no LLM, nothing leaves the machine.

import { z } from 'zod';

export const API_CONTRACT = 1;

/** Why a response carries no data, or carries partial data. Every non-ok state comes with a message. */
export const API_STATES = [
  'ok',
  'invalid_request', // the request did not match the command's schema
  'unknown_command',
  'db_mismatch', // the caller named a database other than the one this Veto uses
  'db_missing', // no Veto database exists yet
  'sqlite_unavailable', // this Node cannot load node:sqlite
  'no_archive', // recall: nothing archived for this project
  'no_match', // recall: archives exist, nothing matched
  'not_found', // expand: no such event or segment in this project
  'error',
] as const;
export type ApiState = (typeof API_STATES)[number];

/** A section of a snapshot can be missing or broken on its own; the rest still answers. */
export const SECTION_STATES = ['ok', 'unavailable', 'error'] as const;

/** A section's own fields are absent when its state is not ok. */
const section = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ state: z.enum(SECTION_STATES), message: z.string().optional(), ...z.object(shape).partial().shape });

export const TRANSCRIPT_SOURCES_V1 = ['claude', 'codex', 'gemini', 'antigravity'] as const;

export const envelopeSchema = z.object({
  contract: z.literal(API_CONTRACT),
  command: z.string(),
  backend_version: z.string(),
  generated_at: z.string(),
  state: z.enum(API_STATES),
  /** One line a person can read; present whenever state is not ok. */
  message: z.string().optional(),
  /** What the user can do about it, usually a command to run. */
  next_action: z.string().optional(),
  data: z.unknown().optional(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

// ── version ──────────────────────────────────────────────────────────────────

export const versionDataSchema = z.object({
  contract: z.literal(API_CONTRACT),
  backend_version: z.string(),
  commands: z.array(z.string()),
  /** Request input: JSON on stdin with --stdin; flags are for people at a terminal. */
  request_via: z.array(z.enum(['stdin', 'flags'])),
  transcript_sources: z.array(z.enum(TRANSCRIPT_SOURCES_V1)),
  node_version: z.string(),
  sqlite_ok: z.boolean(),
  /** The real path of the CLI that answered, so a caller can run `node <cli_path>` with no shell. */
  cli_path: z.string(),
});

// ── snapshot ─────────────────────────────────────────────────────────────────

export const snapshotRequestSchema = z.object({
  project: z.string().min(1).max(1024),
  /** The database the caller reads; refused with db_mismatch when it is not this Veto's. */
  db: z.string().max(1024).optional(),
}).strict();

export const snapshotDataSchema = z.object({
  /** `key` is what Veto compares folders by: case and slash direction are folded on Windows only. */
  project: z.object({ dir: z.string(), key: z.string() }),
  database: section({
    schema_version: z.number(),
    expected_schema_version: z.number(),
    /** The database was written by a newer Veto than this one. */
    newer_than_backend: z.boolean(),
  }),
  transcripts: section({
    capture: z.enum(['enabled', 'disabled', 'reconsent_required']),
    /** Owner decision: archives kept after capture is turned off stay searchable, labelled. */
    recall_permitted: z.boolean(),
    archives_in_project: z.number(),
    archives_all_projects: z.number(),
    by_source_in_project: z.record(z.string(), z.number()),
    last_archived_at: z.string().nullable(),
  }),
  lessons: section({
    sharing: z.enum(['on', 'off', 'reconsent_required']),
    /** Every count here is across all projects, not this one. */
    scope: z.literal('all_projects'),
    notes: z.number(),
    by_host: z.record(z.string(), z.number()),
    any_project: z.number(),
    held: z.number(),
    unresolved_folders: z.number(),
    excluded_projects: z.number(),
    disabled_hosts: z.array(z.object({ host: z.string(), reason: z.string() })),
  }),
  trial: section({
    mode: z.literal('shadow'),
    started_at: z.string(),
    ends_at: z.string(),
    qualifying: z.number(),
    target: z.number(),
    complete: z.boolean(),
    outcomes: z.record(z.string(), z.number()),
    drift: z.boolean(),
  }),
});

// ── recall ───────────────────────────────────────────────────────────────────

export const recallSearchRequestSchema = z.object({
  project: z.string().min(1).max(1024),
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(10),
  source: z.enum(TRANSCRIPT_SOURCES_V1).optional(),
  db: z.string().max(1024).optional(),
}).strict();

const captureLabel = z.enum(['enabled', 'disabled', 'reconsent_required']);

export const recallSearchDataSchema = z.object({
  /** When capture is not enabled, results come from archives kept from before. */
  capture: captureLabel,
  disclaimer: z.string(),
  retrieval: z.object({ lexical: z.literal(true), semantic: z.string().nullable() }),
  archives_searched: z.number(),
  elapsed_ms: z.number(),
  hits: z.array(z.object({
    event_id: z.string(),
    archive_id: z.string(),
    source: z.string(),
    source_session_id: z.string(),
    seq: z.number(),
    kind: z.string(),
    ts: z.string().nullable(),
    snippet: z.string(),
    score: z.number(),
  })),
  /** The segments of the chats that matched (up to 3 chats), for recall expand's segment_index. */
  segments: z.array(z.object({
    archive_id: z.string(),
    index: z.number(),
    title: z.string(),
    first_ts: z.string().nullable(),
    last_ts: z.string().nullable(),
    user_messages: z.number(),
    tool_calls: z.number(),
  })),
});

export const recallExpandRequestSchema = z.union([
  z.object({ project: z.string().min(1).max(1024), event_id: z.string().min(1).max(64), db: z.string().max(1024).optional() }).strict(),
  z.object({
    project: z.string().min(1).max(1024), archive_id: z.string().min(1).max(64),
    segment_index: z.number().int().min(0).max(10_000), db: z.string().max(1024).optional(),
  }).strict(),
]);

export const recallExpandDataSchema = z.object({
  capture: captureLabel,
  disclaimer: z.string(),
  source: z.string(),
  source_session_id: z.string(),
  from_seq: z.number().nullable(),
  to_seq: z.number().nullable(),
  provenance: z.string().nullable(),
  text: z.string(),
  truncated: z.boolean(),
  secrets_redacted: z.number(),
});

// ── diagnostics ──────────────────────────────────────────────────────────────

export const DIAGNOSTIC_CHECKS = ['host_cli', 'probe'] as const;

export const diagnosticsRequestSchema = z.object({
  /** Slow checks, run only when named: ask each app's own CLI, launch the configured server. */
  checks: z.array(z.enum(DIAGNOSTIC_CHECKS)).max(2).default([]),
  db: z.string().max(1024).optional(),
}).strict();

export const diagnosticsDataSchema = z.object({
  backend: z.object({ version: z.string(), contract: z.literal(API_CONTRACT), node_version: z.string(), sqlite_ok: z.boolean() }),
  database: section({
    schema_version: z.number(),
    expected_schema_version: z.number(),
    newer_than_backend: z.boolean(),
  }),
  checked: z.object({ host_cli: z.boolean(), probe: z.boolean() }),
  /** Veto does not sign in to anything; whether each app is signed in is not something it can see. */
  authentication: z.literal('not_checked'),
  hosts: z.array(z.object({
    id: z.string(),
    name: z.string(),
    installed: z.boolean(),
    registration: z.string(),
    source: z.string(),
    level: z.enum(['ok', 'warn', 'fail', 'absent']),
    headline: z.string(),
    details: z.array(z.string()),
    fix: z.string().nullable(),
    probe: z.object({ ok: z.boolean(), ms: z.number().nullable(), server_version: z.string().nullable(), tools: z.number().nullable() }).nullable(),
    last_start: z.object({
      client: z.string(), at: z.string(), veto_version: z.string(), node_version: z.string(), sqlite_ok: z.boolean(),
    }).nullable(),
  })),
});

/** Every schema published under contracts/api-v1/, by file name. */
export const PUBLISHED_SCHEMAS = {
  'envelope': envelopeSchema,
  'version.data': versionDataSchema,
  'snapshot.request': snapshotRequestSchema,
  'snapshot.data': snapshotDataSchema,
  'recall-search.request': recallSearchRequestSchema,
  'recall-search.data': recallSearchDataSchema,
  'recall-expand.request': recallExpandRequestSchema,
  'recall-expand.data': recallExpandDataSchema,
  'diagnostics.request': diagnosticsRequestSchema,
  'diagnostics.data': diagnosticsDataSchema,
} as const;
