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

export function plan(task: string, context?: string): AgentPlan {
  const target = detectTarget(task, context);

  return {
    agent: 'devops' as WorkerAgentType,
    task,
    tier: 3,
    approach: targetApproach[target],
    steps: [
      'Write a multi-stage Dockerfile: stage 1 (builder) installs deps and compiles, stage 2 (runtime) copies only the built artefact',
      'Set a non-root USER in the Dockerfile runtime stage',
      'Pin the base image to a specific digest, not :latest',
      'Add .dockerignore to exclude node_modules, .git, and secrets',
      'Write docker-compose.yml for local development with all dependent services (DB, Redis, etc.)',
      'Add health checks to compose services so the app only starts when dependencies are ready',
      'Write the CI pipeline: lint → test → build image → push to registry → deploy',
      'Use separate environment stages: development, staging, production',
      'Store secrets in a vault (AWS Secrets Manager, HashiCorp Vault, GitHub Actions secrets) — never in the repo',
      'Configure rolling deployment or blue/green to achieve zero-downtime deploys',
      'Add liveness probe (is the process alive?) and readiness probe (can it serve traffic?) to the container',
      'Set CPU and memory resource requests and limits',
      'Configure structured logging to stdout — let the orchestrator collect it',
      'Add a /health endpoint that checks DB connectivity and returns 200 or 503',
      'Set up alerting on error rate, latency p95, and pod restart count',
    ],
    checklist: [
      '[ ] Dockerfile is multi-stage — runtime image contains no build tools or source code',
      '[ ] Base image pinned to a specific SHA or version tag, not :latest',
      '[ ] Container runs as a non-root user',
      '[ ] .dockerignore excludes node_modules, .git, .env, and secrets',
      '[ ] All secrets loaded from environment variables or a vault — never baked into the image',
      '[ ] CI pipeline runs lint and tests before building the image',
      '[ ] CI pipeline fails the deploy if tests fail',
      '[ ] Docker image scanned for vulnerabilities (trivy or snyk) in CI',
      '[ ] Deployment uses rolling update or blue/green — no downtime on deploy',
      '[ ] Liveness and readiness probes configured',
      '[ ] Resource requests and limits set on all containers',
      '[ ] Structured JSON logging to stdout',
      '[ ] Log retention policy set (no unlimited growth)',
      '[ ] Health check endpoint returns 503 when dependencies are unhealthy',
      '[ ] Alerts configured for error rate > 1% and p95 latency > SLO',
      '[ ] Runbook written for on-call responders',
    ],
    pitfalls: [
      'Using :latest as the base image tag — breaks reproducibility when the upstream image changes',
      'Running the container as root — a container escape becomes a root host compromise',
      'Baking secrets into the image via ENV or COPY — secrets are visible in docker history',
      'Not adding health checks to compose — the app starts before the database is ready, crashes on first query',
      'Building the full Docker image in CI without layer caching — 10-minute builds for a one-line change',
      'Deploying directly to production without a staging environment test — no safety net',
      'Not setting resource limits — a memory leak can starve all other pods on the node',
      'Using docker-compose in production — lacks self-healing, scheduling, and scaling capabilities',
    ],
    patterns: [
      'Multi-stage Docker build (minimise image size)',
      'Blue/Green deployment (zero-downtime swap)',
      'Canary release (route small percentage to new version)',
      'GitOps (declarative infra state tracked in git, applied by Flux/ArgoCD)',
      'Infrastructure as Code (Terraform, Pulumi, CDK)',
      'Immutable infrastructure (replace, never patch in place)',
      'Twelve-Factor App methodology',
    ],
    duration_estimate: '1-2 days',
  };
}
