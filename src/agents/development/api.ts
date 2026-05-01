import { AgentPlan, WorkerAgentType } from '../types.js';

type ApiStyle = 'rest' | 'graphql' | 'grpc' | 'general';

function detectApiStyle(task: string, context?: string): ApiStyle {
  const combined = (task + ' ' + (context ?? '')).toLowerCase();
  if (combined.includes('graphql') || combined.includes('query') || combined.includes('mutation') || combined.includes('resolver')) return 'graphql';
  if (combined.includes('grpc') || combined.includes('protobuf') || combined.includes('proto')) return 'grpc';
  if (combined.includes('rest') || combined.includes('http') || combined.includes('endpoint') || combined.includes('route')) return 'rest';
  return 'general';
}

const styleApproach: Record<ApiStyle, string> = {
  rest: 'Design resource-oriented URLs, assign correct HTTP verbs, define request/response DTOs with validation, implement versioning strategy, document with OpenAPI, secure with JWT/OAuth.',
  graphql: 'Define the schema first (SDL-first approach), design resolvers to avoid N+1 (DataLoader), implement mutations with input types, add field-level authorisation, paginate list queries.',
  grpc: 'Write the .proto file first (contract-first), generate server and client stubs, implement unary and streaming RPCs as needed, add interceptors for auth/logging, define error codes.',
  general: 'Choose REST for CRUD resource APIs, GraphQL for flexible client-driven queries, gRPC for high-performance internal services. Design the contract before writing implementation code.',
};

const styleSteps: Record<ApiStyle, string[]> = {
  rest: [
    'Identify the resources (nouns) the API exposes — e.g., /users, /orders, /products',
    'Map CRUD operations to HTTP verbs: GET (read), POST (create), PUT/PATCH (update), DELETE',
    'Design the URL structure: /api/v1/resources/{id}/sub-resources',
    'Define the request body DTO with all required and optional fields',
    'Define the response body DTO — never return the raw DB row',
    'Define error response shape: { code, message, details } for all 4xx/5xx',
    'Choose the pagination strategy: cursor-based for large datasets, offset for small',
    'Implement versioning: URL path versioning (/v1/) or header versioning',
    'Secure the endpoint: add authentication middleware and role-based guards',
    'Add rate limiting to prevent abuse',
    'Write OpenAPI/Swagger annotation for each endpoint',
    'Write integration tests covering happy path and all error conditions',
  ],
  graphql: [
    'Write the GraphQL schema (SDL) before writing any resolver code',
    'Define types for all entities, input types for mutations, and enums for fixed values',
    'Design query fields with pagination arguments (first, after, last, before)',
    'Implement DataLoader for all one-to-many and many-to-many relations to batch DB queries',
    'Implement resolvers using the service layer — no direct DB queries in resolvers',
    'Add field-level authorisation using resolver guards',
    'Add query depth limiting (max depth 10) and query complexity limits',
    'Implement subscriptions only for truly real-time use cases',
    'Add persisted queries for production performance',
    'Write tests using graphql-tester or supertest against the schema',
    'Document each type and field with SDL description strings',
  ],
  grpc: [
    'Write the .proto file defining all messages and services',
    'Generate TypeScript server and client stubs from the proto',
    'Implement each RPC method in the service implementation class',
    'Add server interceptors for authentication, logging, and tracing',
    'Implement unary RPCs for simple request/response patterns',
    'Implement server-streaming for large result sets',
    'Implement bidirectional streaming for real-time communication',
    'Define a standard error model using google.rpc.Status',
    'Add health checking via the gRPC health protocol',
    'Write integration tests using the generated client stubs',
    'Document each service and RPC with proto comments',
  ],
  general: [
    'Choose the API style based on use case (REST/GraphQL/gRPC)',
    'Write the API contract (OpenAPI, SDL, or .proto) before implementation',
    'Define all data types for requests and responses',
    'Design error handling and error response shapes',
    'Plan authentication and authorisation strategy',
    'Design versioning strategy',
    'Add rate limiting and throttling',
    'Write API documentation',
    'Write integration tests',
    'Set up monitoring for error rates and latency',
  ],
};

export function plan(task: string, context?: string): AgentPlan {
  const style = detectApiStyle(task, context);

  return {
    agent: 'api' as WorkerAgentType,
    task,
    tier: 2,
    approach: styleApproach[style],
    steps: styleSteps[style],
    checklist: [
      '[ ] API contract (OpenAPI/SDL/proto) written before implementation',
      '[ ] All request inputs validated and sanitised',
      '[ ] Response DTOs never expose internal DB columns or secrets',
      '[ ] HTTP status codes semantically correct (201 for creation, 422 for validation errors)',
      '[ ] Authentication required on all non-public endpoints',
      '[ ] Authorisation checked — user can only access their own resources',
      '[ ] Rate limiting applied to prevent abuse',
      '[ ] Pagination implemented for all list endpoints',
      '[ ] Error responses follow a consistent shape with error code and message',
      '[ ] Idempotency key supported on create/update endpoints',
      '[ ] API versioning strategy documented and implemented',
      '[ ] CORS configured correctly for the intended client origins',
      '[ ] No internal error details (stack traces) exposed in production responses',
      '[ ] Integration tests cover 200, 400, 401, 403, 404, 422, 500 paths',
      '[ ] API documentation complete and accurate',
    ],
    pitfalls: [
      'Returning 200 OK with an error body — use the correct HTTP status code',
      'Exposing database IDs directly — use UUIDs or opaque tokens to prevent enumeration',
      'Not validating Content-Type — body parsers silently fail on wrong content type',
      'Returning the full DB row in the response — exposes internal fields and breaks encapsulation',
      'Using GET requests for operations with side effects — browsers and caches will replay them',
      'Not implementing idempotency for payment or order endpoints — duplicate requests cause duplicate charges',
      'Omitting pagination on list endpoints — a single request can return millions of rows',
    ],
    patterns: [
      'Command pattern (map HTTP requests to command objects)',
      'DTO pattern (request and response data transfer objects)',
      'Decorator pattern (middleware as route decorators)',
      'Repository pattern (abstract data access from controllers)',
      'API Gateway pattern (single entry point with cross-cutting concerns)',
      'Circuit Breaker pattern (for outbound calls to other services)',
    ],
    duration_estimate: '4-8 hours',
  };
}
