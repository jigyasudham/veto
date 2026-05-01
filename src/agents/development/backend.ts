import { AgentPlan, WorkerAgentType } from '../types.js';

type BackendStyle = 'monolith' | 'microservice' | 'serverless' | 'general';

function detectStyle(task: string, context?: string): BackendStyle {
  const combined = (task + ' ' + (context ?? '')).toLowerCase();
  if (combined.includes('lambda') || combined.includes('serverless') || combined.includes('function') || combined.includes('faas')) return 'serverless';
  if (combined.includes('microservice') || combined.includes('service mesh') || combined.includes('kubernetes') || combined.includes('k8s')) return 'microservice';
  if (combined.includes('monolith') || combined.includes('mvc') || combined.includes('express') || combined.includes('nestjs') || combined.includes('rails')) return 'monolith';
  return 'general';
}

const styleApproach: Record<BackendStyle, string> = {
  monolith: 'Organise by feature module (not by layer). Each module owns its Controller → Service → Repository stack. Use dependency injection for testability. Enforce module boundaries — no cross-module direct imports.',
  microservice: 'Define the service boundary around a bounded context. Use async messaging for cross-service communication. Implement the Saga pattern for distributed transactions. Each service owns its data store.',
  serverless: 'Design for stateless execution — no in-memory state between invocations. Use environment variables for config. Cold start budget: keep the handler lean. Use SQS/EventBridge for async operations.',
  general: 'Apply Clean Architecture: Controllers → Use Cases → Domain → Infrastructure. Dependencies point inward. The domain layer has no framework imports. Testable by definition.',
};

export function plan(task: string, context?: string): AgentPlan {
  const style = detectStyle(task, context);

  return {
    agent: 'backend' as WorkerAgentType,
    task,
    tier: 3,
    approach: styleApproach[style],
    steps: [
      'Define the domain model: entities, value objects, and aggregate roots',
      'Define use cases (application services) — each use case is a single public method',
      'Design the repository interfaces in the domain layer (no DB imports)',
      'Implement the controller layer: parse request → call use case → format response',
      'Implement the service layer: orchestrate domain objects and repositories',
      'Implement the repository layer: translate domain operations to DB queries',
      'Wire dependency injection container (manual DI or a framework like tsyringe/inversify)',
      'Add authentication middleware: verify JWT/session, attach user to request context',
      'Add authorisation guards: check role/permission on each protected route',
      'Add request validation middleware: validate body/query against schema before reaching controller',
      'Implement structured error handling: domain errors → HTTP errors → error middleware',
      'Add correlation ID middleware: generate and propagate request tracing ID',
      'Add health check endpoint: /health returns 200 with DB and dependency status',
      'Configure graceful shutdown: drain in-flight requests before stopping the process',
      'Write unit tests for each service method with mocked repositories',
      'Write integration tests for each controller route against a test database',
    ],
    checklist: [
      '[ ] Domain layer has zero framework or DB imports',
      '[ ] Each use case / service method has a single responsibility',
      '[ ] All dependencies injected via constructor — no new SomeDependency() in methods',
      '[ ] Repository interfaces defined in domain, implementations in infrastructure',
      '[ ] Authentication middleware applied to all non-public routes',
      '[ ] Authorisation checked inside the use case — not just at the route level',
      '[ ] Request validation runs before the controller method executes',
      '[ ] All async operations wrapped in try/catch with typed error handling',
      '[ ] Structured logging with correlation ID on every log line',
      '[ ] No sensitive data (passwords, tokens) in log output',
      '[ ] Graceful shutdown implemented — SIGTERM drains in-flight requests',
      '[ ] Health endpoint checks real DB connectivity, not just process liveness',
      '[ ] Environment variables validated at startup — fail fast on missing config',
      '[ ] Connection pools sized appropriately for the expected concurrency',
      '[ ] Unit tests cover all service methods',
      '[ ] Integration tests cover all controller routes',
    ],
    pitfalls: [
      'Putting business logic in controllers — controllers should only parse input and format output',
      'Accessing the database directly from controllers — bypasses the service/repository abstraction',
      'Using global state (singletons with mutable fields) — breaks in clustered/concurrent environments',
      'Swallowing exceptions in middleware — downstream handlers receive undefined instead of an error',
      'Not validating environment variables at startup — the service starts, runs for hours, then crashes on first DB access',
      'Building a distributed monolith — microservices that share a DB defeat the purpose of the architecture',
      'Forgetting graceful shutdown — in-flight requests are killed on deploy, causing user-visible errors',
    ],
    patterns: [
      'Clean Architecture (Controllers → Use Cases → Domain → Infrastructure)',
      'Repository pattern (abstract DB access behind an interface)',
      'Dependency Injection (constructor injection for testability)',
      'Middleware chain (Chain of Responsibility for cross-cutting concerns)',
      'Command / Query Responsibility Segregation (CQRS)',
      'Domain Events (decouple side effects from core logic)',
      'Circuit Breaker (for resilient outbound calls)',
      'Saga pattern (coordinate distributed transactions)',
    ],
    duration_estimate: '1-3 days',
  };
}
