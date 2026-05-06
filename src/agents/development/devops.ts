import { AgentPlan, WorkerAgentType } from '../types.js';

type DeployTarget = 'docker' | 'kubernetes' | 'serverless' | 'paas' | 'general';

function detectTarget(task: string, context?: string): DeployTarget {
  const combined = (task + ' ' + (context ?? '')).toLowerCase();
  if (combined.includes('kubernetes') || combined.includes('k8s') || combined.includes('helm') || combined.includes('pod')) return 'kubernetes';
  if (combined.includes('lambda') || combined.includes('serverless') || combined.includes('cloud function') || combined.includes('faas')) return 'serverless';
  if (combined.includes('heroku') || combined.includes('render') || combined.includes('railway') || combined.includes('fly.io') || combined.includes('paas')) return 'paas';
  if (combined.includes('docker') || combined.includes('container') || combined.includes('compose')) return 'docker';
  return 'general';
}

const targetApproach: Record<DeployTarget, string> = {
  docker: 'Multi-stage Dockerfile to minimise image size, docker-compose for local development with dependent services, GitHub Actions for build-push-deploy pipeline.',
  kubernetes: 'Helm chart per service, resource requests/limits, liveness/readiness probes, HorizontalPodAutoscaler, ConfigMap and Secret management, Ingress with TLS.',
  serverless: 'Serverless Framework or AWS SAM for IaC, per-function IAM roles with least privilege, environment-specific stages, DLQ for failed invocations.',
  paas: 'Environment variables in the platform console (never committed), Procfile or start command, health check route, deployment hooks for migrations.',
  general: 'Containerise with Docker for environment parity. Use a CI/CD pipeline for automated testing and deployment. Manage secrets with a vault, not environment files.',
};

const targetSteps: Record<DeployTarget, string[]> = {
  docker: [
    'Write multi-stage Dockerfile: stage 1 (builder) installs deps and compiles, stage 2 (runtime) copies only the built artefact',
    'Set a non-root USER in the runtime stage',
    'Pin the base image to a specific digest or version tag — never :latest',
    'Add .dockerignore: exclude node_modules, .git, .env, and all secrets',
    'Write docker-compose.yml for local dev with all dependent services (DB, Redis, etc.)',
    'Add healthcheck directives to compose services — app only starts when dependencies are ready',
    'Write the CI pipeline: lint → test → build image → scan image → push to registry → deploy',
    'Scan the image for CVEs in CI with trivy or snyk — fail on critical severity',
    'Store all secrets in a vault or CI secret store — never baked into ENV or COPY',
    'Configure rolling update or blue/green deploy for zero-downtime releases',
    'Add a /health endpoint that checks DB connectivity and returns 200 or 503',
    'Configure structured JSON logging to stdout — let the host collect it',
    'Set log retention policy on the host log driver',
    'Set up alerting on error rate, restart count, and p95 latency',
  ],
  kubernetes: [
    'Write a Helm chart: deployment, service, ingress, configmap, secret templates',
    'Set resource requests and limits on every container (CPU + memory)',
    'Configure liveness probe (is the process alive?) and readiness probe (can it serve traffic?) separately',
    'Configure HorizontalPodAutoscaler: min, max replicas, target CPU utilisation',
    'Store secrets in Kubernetes Secrets or an external vault (Vault, AWS Secrets Manager via CSI driver)',
    'Configure rolling update strategy: maxSurge and maxUnavailable',
    'Set Pod Disruption Budget — prevent all pods from being evicted simultaneously',
    'Configure Ingress with TLS termination and cert-manager for automatic certificate renewal',
    'Set up RBAC: service account with least-privilege role for the application',
    'Configure Network Policies to restrict pod-to-pod communication to what is needed',
    'Set up node affinity or pod anti-affinity to spread pods across availability zones',
    'Configure resource quotas on the namespace to limit blast radius',
    'Set up Prometheus scraping annotations on the deployment',
    'Write a runbook: what to do when a pod crashes, when memory limit is hit, when a cert expires',
  ],
  serverless: [
    'Write the IaC file (serverless.yml, SAM template, or CDK stack) — never configure functions manually',
    'Assign each function a per-function IAM role with minimum required permissions',
    'Configure reserved concurrency to prevent runaway scaling from DoS',
    'Set function timeout to the minimum needed — default 30s is too long for most handlers',
    'Configure a Dead Letter Queue (SQS or SNS) for failed asynchronous invocations',
    'Keep handler code lean — heavy dependencies increase cold start time significantly',
    'Use Lambda Layers or bundled ESM for shared dependencies to reduce bundle size',
    'Store all secrets in AWS SSM Parameter Store or Secrets Manager — never in environment variables committed to source',
    'Set up X-Ray tracing for distributed request tracing across functions',
    'Configure provisioned concurrency for latency-sensitive functions to eliminate cold starts',
    'Set up structured logging to CloudWatch with log retention of 30–90 days',
    'Write integration tests that invoke the real function via the AWS SDK, not just unit tests',
    'Set up alerts on: error rate, throttle rate, duration p95, DLQ message count',
    'Design idempotent handlers — SQS delivers at-least-once, your handler must handle duplicates',
  ],
  paas: [
    'Write a Procfile defining the web and worker process types',
    'Set all configuration via environment variables in the platform dashboard — never committed to source',
    'Add a health check route (/health) returning 200 — the platform uses this to route traffic',
    'Configure the start command or buildpack in app.json / platform config',
    'Set the minimum dyno/instance count to 2 for zero-downtime deploys with rolling restart',
    'Enable the platform database add-on and use connection pooling (PgBouncer for Postgres)',
    'Configure the platform log drain to ship logs to a persistent log service (Papertrail, Datadog)',
    'Set memory and CPU quotas appropriate for the workload tier',
    'Configure autoscaling rules based on request queue depth or response time',
    'Run database migrations as a release phase command — before the new code receives traffic',
    'Set up review apps (Heroku) or preview environments for every pull request',
    'Configure SSL enforce — redirect all HTTP to HTTPS at the platform level',
    'Set up alerts on memory quota, error rate, and response time',
  ],
  general: [
    'Containerise the application with Docker for environment parity',
    'Write the CI/CD pipeline: lint → test → build → deploy',
    'Store all secrets in a vault — never in source code or committed config files',
    'Configure health checks and readiness probes',
    'Use separate environments: development, staging, production',
    'Configure structured logging to stdout',
    'Set up alerting on error rate and latency',
    'Write a deployment runbook',
    'Plan rollback procedure before every release',
    'Test the rollback procedure — untested rollbacks fail when you need them most',
  ],
};

const targetChecklist: Record<DeployTarget, string[]> = {
  docker: [
    '[ ] Multi-stage Dockerfile — runtime image has no build tools or source',
    '[ ] Base image pinned to version tag, not :latest',
    '[ ] Container runs as non-root user',
    '[ ] .dockerignore excludes secrets, node_modules, .git',
    '[ ] All secrets from vault or CI secret store — not baked into image',
    '[ ] CI pipeline: lint → test → build → scan → push → deploy',
    '[ ] Image scanned for CVEs in CI',
    '[ ] Rolling update or blue/green deploy configured',
    '[ ] Health endpoint returns 503 when dependencies are unhealthy',
    '[ ] Structured JSON logging to stdout',
    '[ ] Alerts on error rate, restart count, and latency p95',
  ],
  kubernetes: [
    '[ ] Resource requests and limits set on every container',
    '[ ] Liveness and readiness probes configured separately',
    '[ ] HPA configured with sensible min/max replicas',
    '[ ] Secrets in Kubernetes Secrets or external vault — not in ConfigMap',
    '[ ] TLS configured on Ingress with cert-manager',
    '[ ] Pod Disruption Budget prevents all pods from being evicted simultaneously',
    '[ ] RBAC: service account with least-privilege role',
    '[ ] Network Policy restricts pod-to-pod traffic',
    '[ ] Rolling update strategy configured (maxSurge, maxUnavailable)',
    '[ ] Prometheus scraping annotations set',
    '[ ] Runbook written for common failure modes',
  ],
  serverless: [
    '[ ] Every function has its own least-privilege IAM role',
    '[ ] Reserved concurrency set to prevent runaway scaling',
    '[ ] Timeout set to minimum needed — not default 30s',
    '[ ] Dead Letter Queue configured for async invocations',
    '[ ] Handler is idempotent — safe to invoke twice',
    '[ ] Secrets in SSM/Secrets Manager — not environment variables committed to source',
    '[ ] X-Ray tracing enabled',
    '[ ] Log retention set (30–90 days)',
    '[ ] Alerts on error rate, throttle rate, DLQ depth, and duration p95',
    '[ ] Cold start latency profiled for latency-sensitive paths',
  ],
  paas: [
    '[ ] Procfile defines all process types',
    '[ ] All config in environment variables — none committed to source',
    '[ ] Health check route returns 200',
    '[ ] Minimum 2 instances for zero-downtime rolling restart',
    '[ ] Database migrations run as release phase command',
    '[ ] Connection pooling configured for DB add-on',
    '[ ] Log drain configured to persistent log service',
    '[ ] SSL enforce enabled at platform level',
    '[ ] Autoscaling rules configured',
    '[ ] Alerts on memory quota, error rate, and response time',
  ],
  general: [
    '[ ] Application containerised',
    '[ ] CI/CD pipeline: lint → test → build → deploy',
    '[ ] Secrets in vault — not in source or committed config',
    '[ ] Health checks configured',
    '[ ] Separate environments: dev, staging, production',
    '[ ] Structured logging to stdout',
    '[ ] Alerting on error rate and latency',
    '[ ] Deployment runbook written',
    '[ ] Rollback procedure tested',
  ],
};

const targetPitfalls: Record<DeployTarget, string[]> = {
  docker: [
    'Using :latest — breaks reproducibility when upstream image is updated silently',
    'Running as root — a container escape becomes a full host compromise',
    'Baking secrets via ENV in Dockerfile — visible in docker history and image layers',
    'No health check in compose — app starts and crashes before the DB is ready',
    'No layer caching in CI — rebuilds all layers on every push, 10× slower builds',
    'Using docker-compose in production — no self-healing, no scheduling, no HA',
  ],
  kubernetes: [
    'Not setting resource limits — a memory leak starves other pods on the node',
    'Liveness probe that checks external dependencies — a DB outage kills healthy pods',
    'No Pod Disruption Budget — a cluster upgrade evicts all replicas simultaneously',
    'Secrets in ConfigMap — ConfigMaps are not encrypted at rest by default',
    'No Network Policy — lateral movement inside the cluster is unrestricted',
    'Targeting :latest in image tags — rolling updates become non-deterministic',
  ],
  serverless: [
    'Default 30s timeout — slow functions hold concurrency and cost 10× more',
    'No DLQ — failed async invocations disappear silently with no retry',
    'Shared IAM role across functions — one compromised function gets all permissions',
    'Non-idempotent handler — SQS at-least-once delivery causes duplicate side effects',
    'Large deployment package — each extra MB adds cold start latency',
    'Initialising DB connections inside the handler — a new connection per invocation exhausts pool',
  ],
  paas: [
    'One dyno — a restart causes visible downtime for all users',
    'DB migrations running on app start (not release phase) — migration runs on every dyno simultaneously',
    'No connection pooler — direct DB connections exhausted under concurrent load',
    'Secrets in Procfile or app.json committed to source',
    'No log drain — logs are lost after platform retention window (typically 1 week)',
  ],
  general: [
    'Deploying to production without staging — every release is a live experiment',
    'Untested rollback procedure — the first time it runs is during an incident',
    'Secrets in source control — leaked via git history even after deletion',
    'No health checks — platform routes traffic to crashed instances',
  ],
};

export function plan(task: string, context?: string): AgentPlan {
  const target = detectTarget(task, context);

  return {
    agent: 'devops' as WorkerAgentType,
    task,
    tier: 3,
    approach: targetApproach[target],
    steps: targetSteps[target],
    checklist: targetChecklist[target],
    pitfalls: targetPitfalls[target],
    patterns: target === 'kubernetes'
      ? ['GitOps (Flux/ArgoCD)', 'Helm chart pattern', 'Sidecar pattern', 'Init container pattern', 'Blue/Green deployment', 'Canary release']
      : target === 'serverless'
      ? ['Hexagonal architecture for testable handlers', 'Idempotent consumer pattern', 'Saga pattern (Step Functions)', 'Fan-out/fan-in pattern', 'Lambda Layers for shared code']
      : target === 'paas'
      ? ['Twelve-Factor App', 'Release phase migrations', 'Review apps pattern', 'Add-on per environment pattern']
      : ['Multi-stage Docker build', 'Blue/Green deployment', 'GitOps', 'Infrastructure as Code', 'Immutable infrastructure', 'Twelve-Factor App'],
    duration_estimate: target === 'kubernetes' ? '2-3 days' : '1-2 days',
  };
}
