// Skill: scaffold — generates project scaffold structure for detected project type

export interface SkillInput {
  task: string;
  context?: string;
  options?: Record<string, unknown>;
}

export interface SkillOutput {
  skill: string;
  template?: string;
  checklist: string[];
  patterns: string[];
  gotchas: string[];
  resources: string[];
}

type ProjectType = 'rest-api' | 'full-stack' | 'cli' | 'library' | 'generic';

function detectProjectType(task: string): ProjectType {
  const t = task.toLowerCase();
  if (/\bcli\b|command[\s-]?line|commander|yargs|oclif/.test(t)) return 'cli';
  if (/\blibrary\b|npm\s+package|sdk|module|publishable/.test(t)) return 'library';
  if (/\bfull[\s-]?stack\b|next\.?js|nuxt|remix|frontend\s*\+\s*backend/.test(t)) return 'full-stack';
  if (/\bapi\b|rest(?:ful)?|express|fastify|hono|koa|endpoint/.test(t)) return 'rest-api';
  return 'generic';
}

const TEMPLATES: Record<ProjectType, string> = {
  'rest-api': `
my-api/
├── src/
│   ├── index.ts              # Entry point — creates and starts the server
│   ├── app.ts                # Express/Fastify app factory (no listen call)
│   ├── config/
│   │   └── env.ts            # Typed env validation with zod
│   ├── routes/
│   │   ├── index.ts          # Route aggregator
│   │   └── health.ts         # GET /health — liveness probe
│   ├── controllers/          # HTTP layer: parse request, call service, send response
│   ├── services/             # Business logic — no HTTP types
│   ├── repositories/         # Data access layer — DB queries only
│   ├── middleware/
│   │   ├── auth.ts           # JWT / session verification
│   │   ├── validate.ts       # Zod request schema validation
│   │   └── error-handler.ts  # Centralised error → HTTP response mapping
│   ├── models/               # TypeScript interfaces / Prisma types
│   └── utils/
│       ├── logger.ts         # Pino / Winston structured logger
│       └── errors.ts         # Typed application error classes
├── tests/
│   ├── unit/                 # Service and utility unit tests
│   ├── integration/          # Route-level supertest tests
│   └── fixtures/             # Test data factories
├── .env.example              # Template with all required env keys (no real values)
├── .gitignore
├── .eslintrc.json
├── .prettierrc
├── tsconfig.json
├── jest.config.ts            # Or vitest.config.ts
├── Dockerfile
├── docker-compose.yml
└── package.json
`.trim(),

  'full-stack': `
my-app/
├── apps/
│   ├── web/                  # Frontend (React / Next.js / Astro)
│   │   ├── src/
│   │   │   ├── app/          # Next.js App Router pages
│   │   │   ├── components/   # Shared UI components
│   │   │   ├── hooks/        # Custom React hooks
│   │   │   ├── lib/          # API client, utilities
│   │   │   └── styles/       # Global CSS / Tailwind config
│   │   └── package.json
│   └── api/                  # Backend (Express / Fastify)
│       ├── src/
│       │   ├── routes/
│       │   ├── services/
│       │   └── repositories/
│       └── package.json
├── packages/
│   ├── ui/                   # Shared component library
│   ├── types/                # Shared TypeScript types between frontend and backend
│   └── config/               # Shared ESLint, tsconfig base
├── infra/                    # IaC (Terraform / Pulumi / CDK)
├── .env.example
├── pnpm-workspace.yaml       # Or turbo.json for Turborepo
├── turbo.json
└── package.json
`.trim(),

  cli: `
my-cli/
├── src/
│   ├── index.ts              # Entry point — calls main()
│   ├── cli.ts                # Commander / yargs setup, command registration
│   ├── commands/
│   │   ├── index.ts          # Command exports
│   │   └── init.ts           # Example: "my-cli init" command
│   ├── config/
│   │   ├── loader.ts         # Reads ~/.my-cli/config.json or XDG config
│   │   └── schema.ts         # Zod schema for config validation
│   ├── utils/
│   │   ├── logger.ts         # Chalk-powered coloured console output
│   │   ├── spinner.ts        # Ora spinner wrapper
│   │   └── prompt.ts         # Inquirer / clack prompt helpers
│   └── errors.ts             # CLI-specific error classes with exit codes
├── tests/
│   ├── commands/             # Command unit tests
│   └── integration/          # Full CLI invocation tests via execa
├── bin/
│   └── my-cli.js             # Executable shim (#!/usr/bin/env node)
├── .env.example
├── .gitignore
├── tsconfig.json
├── tsconfig.build.json       # Excludes test files from build output
├── package.json              # "bin" field pointing to dist/index.js
└── README.md
`.trim(),

  library: `
my-library/
├── src/
│   ├── index.ts              # Public API barrel — re-exports only the public surface
│   ├── core/                 # Core implementation modules
│   ├── types/
│   │   └── index.ts          # Exported TypeScript types and interfaces
│   └── utils/                # Internal utilities (not exported)
├── tests/
│   ├── unit/
│   └── snapshots/
├── examples/                 # Runnable usage examples
├── scripts/
│   └── build.ts              # Build script (tsup / rollup / esbuild)
├── .env.example
├── .gitignore
├── .eslintrc.json
├── .prettierrc
├── tsconfig.json
├── tsup.config.ts            # Bundles CJS + ESM + type declarations
├── vitest.config.ts
├── CHANGELOG.md
└── package.json              # "exports", "main", "module", "types" fields
`.trim(),

  generic: `
my-project/
├── src/
│   ├── index.ts              # Entry point
│   └── lib/                  # Core modules
├── tests/
├── .env.example
├── .gitignore
├── tsconfig.json
└── package.json
`.trim(),
};

const CHECKLISTS: Record<ProjectType, string[]> = {
  'rest-api': [
    'Run: npm init -y && git init && echo "node_modules" > .gitignore',
    'Install TypeScript: npm install -D typescript ts-node @types/node && npx tsc --init',
    'Configure tsconfig.json: strict:true, outDir:dist, rootDir:src, target:ES2022',
    'Install framework: npm install express && npm install -D @types/express',
    'Install security middleware: npm install helmet express-rate-limit cors',
    'Install validation: npm install zod',
    'Install logger: npm install pino && npm install -D pino-pretty',
    'Set up database ORM: npm install prisma && npx prisma init',
    'Configure ESLint and Prettier: npm install -D eslint @typescript-eslint/parser prettier',
    'Install testing: npm install -D vitest supertest @types/supertest',
    'Create .env.example with all required variables; add .env to .gitignore',
    'Write src/app.ts factory and src/index.ts entry point',
    'Add npm scripts: dev (ts-node-dev), build (tsc), start (node dist/index.js), test, lint',
    'Write a Dockerfile with multi-stage build: builder + production runner',
    'Set up GitHub Actions CI: install → lint → test → build on every PR',
    'Add docker-compose.yml for local development with database service',
  ],
  'full-stack': [
    'Initialise monorepo: npm install -D turbo && pnpm init (or use create-turbo)',
    'Create pnpm-workspace.yaml listing apps/* and packages/*',
    'Scaffold frontend: pnpm create next-app apps/web --typescript',
    'Scaffold backend: follow rest-api checklist in apps/api',
    'Create packages/types with shared TypeScript interfaces',
    'Create packages/config with shared tsconfig.base.json and eslint config',
    'Configure Turborepo pipeline in turbo.json: build, test, lint tasks',
    'Set up shared environment: turbo.env or dotenv in each app',
    'Install Tailwind CSS and shadcn/ui in apps/web',
    'Set up API client in apps/web/src/lib/api.ts using fetch with typed responses',
    'Configure CORS in apps/api to allow the web origin in development',
    'Add Prettier and ESLint configs in packages/config; extend in each app',
    'Write GitHub Actions matrix workflow that tests each app independently',
    'Write docker-compose.yml that starts both apps and their dependencies',
  ],
  cli: [
    'npm init -y && git init',
    'Install TypeScript: npm install -D typescript @types/node && npx tsc --init',
    'Install CLI framework: npm install commander && npm install -D @types/commander',
    'Install UX tools: npm install chalk ora inquirer && npm install -D @types/inquirer',
    'Install build tool: npm install -D tsup',
    'Configure package.json: add "bin" field, "files" field, and build/dev scripts',
    'Create bin/my-cli.js shim with #!/usr/bin/env node pointing to dist/index.js',
    'Set "prepublishOnly" script to run build and tests before npm publish',
    'Create src/cli.ts with the Commander program definition',
    'Add at least one example command in src/commands/',
    'Write integration tests using execa to invoke the compiled CLI binary',
    'Set up ESLint and Prettier',
    'Add GitHub Actions workflow: test on push + publish to npm on release tag',
    'Write README.md with installation and usage examples',
  ],
  library: [
    'npm init -y && git init',
    'Install TypeScript and tsup: npm install -D typescript tsup',
    'Configure tsconfig.json with strict:true, declaration:true, declarationMap:true',
    'Configure tsup.config.ts: entry src/index.ts, formats [cjs, esm], dts:true',
    'Set package.json "exports", "main", "module", "types" fields for dual CJS/ESM',
    'Add "files" field to package.json to only publish src + dist, not tests',
    'Install vitest for testing: npm install -D vitest',
    'Install Changesets for versioning: npm install -D @changesets/cli && npx changeset init',
    'Write public API in src/index.ts; keep internal modules unexported',
    'Write tests covering edge cases, error paths, and type narrowing',
    'Add ESLint with @typescript-eslint and prettier',
    'Create examples/ directory with a working usage example',
    'Set up GitHub Actions: test → build → publish on changeset release',
    'Add CHANGELOG.md and seed first version with npx changeset',
  ],
  generic: [
    'npm init -y && git init',
    'Install TypeScript: npm install -D typescript && npx tsc --init',
    'Add strict TypeScript configuration',
    'Set up ESLint and Prettier',
    'Install testing framework (vitest or jest)',
    'Create .env.example and add .env to .gitignore',
    'Add CI workflow (GitHub Actions)',
    'Write README with purpose, setup, and usage',
  ],
};

const PATTERNS_MAP: Record<ProjectType, string[]> = {
  'rest-api': ['Controller → Service → Repository layered architecture', 'Middleware chain for cross-cutting concerns', 'Dependency injection via constructor parameters'],
  'full-stack': ['Turborepo monorepo with shared packages', 'Type-sharing between frontend and backend via shared package', 'API contract-first development'],
  cli: ['Commander subcommand pattern', 'Config file with XDG base directory spec', 'Spinner + prompt UX pattern'],
  library: ['Barrel export pattern (src/index.ts as public API surface)', 'Dual CJS/ESM build with tsup', 'Semantic versioning with Changesets'],
  generic: ['Separation of concerns', 'Environment-based configuration', 'Test-driven development'],
};

const GOTCHAS: Record<ProjectType, string[]> = {
  'rest-api': [
    'Not separating app factory from server listen — makes supertest integration tests impossible',
    'Importing from .ts paths instead of .js in ESM projects — Node requires .js extensions at runtime',
    'Forgetting to handle unhandled promise rejections: process.on("unhandledRejection")',
    'Not setting NODE_ENV=production in Docker — some libraries skip optimisations',
  ],
  'full-stack': [
    'pnpm hoisting rules differ from npm — some packages require explicit workspace installation',
    'Turbo caches outputs — always define "outputs" in turbo.json or caching will miss files',
    'Next.js Server Actions run on the server but are bundled client-side if marked incorrectly',
    'CORS in development must allow the exact origin including port number',
  ],
  cli: [
    'bin script must have chmod +x and #!/usr/bin/env node shebang — otherwise it won\'t run on Unix',
    'Using process.exit() inside async code without await — unhandled async errors go silently',
    'Global config paths differ per OS — use the "env-paths" package for cross-platform XDG dirs',
    'Not handling SIGINT / SIGTERM — CLI leaves terminal in bad state on Ctrl+C',
  ],
  library: [
    'Publishing src/ instead of dist/ — consumers get TypeScript source, not compiled output',
    'Missing "exports" field in package.json — prevents dual CJS/ESM consumers from working',
    'Exporting internal implementation details — breaks semver compatibility on refactors',
    'Not testing the built package locally with "npm link" before publishing',
  ],
  generic: [
    'Committing .env files — always add to .gitignore before the first commit',
    'Missing tsconfig strict mode — allows silent type errors',
    'No CI from the start — technical debt accumulates quickly without automated checks',
  ],
};

const RESOURCES: Record<ProjectType, string[]> = {
  'rest-api': [
    'https://expressjs.com/en/advanced/best-practice-security.html',
    'https://www.prisma.io/docs/getting-started',
    'https://vitest.dev/guide/',
    'https://docs.npmjs.com/cli/v10/configuring-npm/package-json#main',
  ],
  'full-stack': [
    'https://turbo.build/repo/docs',
    'https://nextjs.org/docs',
    'https://pnpm.io/workspaces',
    'https://ui.shadcn.com/docs',
  ],
  cli: [
    'https://www.npmjs.com/package/commander',
    'https://www.npmjs.com/package/ora',
    'https://www.npmjs.com/package/inquirer',
    'https://tsup.egoist.dev/',
  ],
  library: [
    'https://tsup.egoist.dev/',
    'https://github.com/changesets/changesets',
    'https://www.typescriptlang.org/docs/handbook/declaration-files/dts-from-js.html',
    'https://nodejs.org/api/packages.html#package-entry-points',
  ],
  generic: [
    'https://www.typescriptlang.org/docs/handbook/tsconfig-json.html',
    'https://vitest.dev/guide/',
    'https://eslint.org/docs/latest/use/getting-started',
  ],
};

export function run(input: SkillInput): SkillOutput {
  const projectType = detectProjectType(input.task);

  return {
    skill: 'scaffold',
    template: TEMPLATES[projectType],
    checklist: CHECKLISTS[projectType],
    patterns: PATTERNS_MAP[projectType],
    gotchas: GOTCHAS[projectType],
    resources: RESOURCES[projectType],
  };
}
