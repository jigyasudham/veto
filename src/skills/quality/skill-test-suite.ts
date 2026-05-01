// Skill: test-suite — complete test suite structure guide

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

const TEMPLATE = `
// ── Unit test: ItemService (tests/unit/item.service.test.ts) ──────────────
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ItemService } from '../../src/services/item.service';
import type { ItemRepository } from '../../src/repositories/item.repository';

// Test fixture factory — create minimal valid objects
function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    name: 'Test Item',
    userId: 'user-1',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

describe('ItemService', () => {
  let service: ItemService;
  let repo: ItemRepository;

  beforeEach(() => {
    repo = {
      findById: vi.fn(),
      findAllByUser: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    service = new ItemService(repo);
  });

  // ── Happy path ──────────────────────────────────────────────────────────
  describe('getItem', () => {
    it('returns the item when found and owned by the requesting user', async () => {
      const item = makeItem({ userId: 'user-1' });
      vi.mocked(repo.findById).mockResolvedValue(item);

      const result = await service.getItem('item-1', 'user-1');
      expect(result).toEqual(item);
    });

    // ── Error cases ───────────────────────────────────────────────────────
    it('throws NotFoundError when item does not exist', async () => {
      vi.mocked(repo.findById).mockResolvedValue(null);
      await expect(service.getItem('missing', 'user-1')).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError when item belongs to a different user', async () => {
      const item = makeItem({ userId: 'user-2' });
      vi.mocked(repo.findById).mockResolvedValue(item);
      await expect(service.getItem('item-1', 'user-1')).rejects.toThrow(ForbiddenError);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────
  describe('createItem', () => {
    it('trims whitespace from name before storing', async () => {
      const item = makeItem({ name: 'Trimmed' });
      vi.mocked(repo.create).mockResolvedValue(item);

      await service.createItem('user-1', { name: '  Trimmed  ' });
      expect(repo.create).toHaveBeenCalledWith('user-1', { name: 'Trimmed' });
    });

    it('propagates repository errors', async () => {
      vi.mocked(repo.create).mockRejectedValue(new Error('DB connection failed'));
      await expect(service.createItem('user-1', { name: 'x' })).rejects.toThrow('DB connection failed');
    });
  });
});

// ── Integration test: Items API (tests/integration/items.test.ts) ─────────
import request from 'supertest';
import { createApp } from '../../src/app';
import { signAccessToken } from '../../src/utils/tokens';

describe('Items API', () => {
  let app: Express.Application;
  let authToken: string;

  beforeAll(async () => {
    app = await createApp({ db: testDb });
    authToken = signAccessToken('user-1', 'user');
    await testDb.user.create({ data: { id: 'user-1', email: 'test@example.com', passwordHash: 'x' } });
  });

  afterEach(async () => {
    await testDb.item.deleteMany();
  });

  describe('GET /v1/items', () => {
    it('returns empty list when no items exist', async () => {
      const res = await request(app)
        .get('/v1/items')
        .set('Authorization', \`Bearer \${authToken}\`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('returns only items belonging to the authenticated user', async () => {
      await testDb.item.createMany({
        data: [
          { name: 'My Item', userId: 'user-1' },
          { name: 'Other Item', userId: 'user-2' },
        ],
      });

      const res = await request(app)
        .get('/v1/items')
        .set('Authorization', \`Bearer \${authToken}\`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('My Item');
    });

    it('returns 401 when no token provided', async () => {
      const res = await request(app).get('/v1/items');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /v1/items', () => {
    it('creates an item and returns 201 with Location header', async () => {
      const res = await request(app)
        .post('/v1/items')
        .set('Authorization', \`Bearer \${authToken}\`)
        .send({ name: 'New Item', description: 'A test item' });

      expect(res.status).toBe(201);
      expect(res.headers['location']).toMatch(/\\/v1\\/items\\//);
      expect(res.body.data.name).toBe('New Item');
    });

    it('returns 422 when name is missing', async () => {
      const res = await request(app)
        .post('/v1/items')
        .set('Authorization', \`Bearer \${authToken}\`)
        .send({ description: 'No name' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /v1/items/:id', () => {
    it('returns 403 when requesting another user\\'s item', async () => {
      const item = await testDb.item.create({ data: { name: 'Other', userId: 'user-2' } });

      const res = await request(app)
        .get(\`/v1/items/\${item.id}\`)
        .set('Authorization', \`Bearer \${authToken}\`);

      expect(res.status).toBe(403);
    });

    it('returns 404 when item does not exist', async () => {
      const res = await request(app)
        .get('/v1/items/00000000-0000-0000-0000-000000000000')
        .set('Authorization', \`Bearer \${authToken}\`);

      expect(res.status).toBe(404);
    });
  });
});

// ── E2E test: full user journey (tests/e2e/user-journey.test.ts) ──────────
describe('User journey: register → create item → retrieve → delete', () => {
  let accessToken: string;
  let itemId: string;

  it('registers a new user', async () => {
    const res = await request(app)
      .post('/v1/auth/register')
      .send({ email: 'journey@example.com', password: 'SecurePass123!' });
    expect(res.status).toBe(201);
  });

  it('logs in and receives an access token', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'journey@example.com', password: 'SecurePass123!' });
    expect(res.status).toBe(200);
    accessToken = res.body.data.accessToken;
  });

  it('creates an item', async () => {
    const res = await request(app)
      .post('/v1/items')
      .set('Authorization', \`Bearer \${accessToken}\`)
      .send({ name: 'Journey Item' });
    expect(res.status).toBe(201);
    itemId = res.body.data.id;
  });

  it('retrieves the created item', async () => {
    const res = await request(app)
      .get(\`/v1/items/\${itemId}\`)
      .set('Authorization', \`Bearer \${accessToken}\`);
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Journey Item');
  });

  it('deletes the item', async () => {
    const res = await request(app)
      .delete(\`/v1/items/\${itemId}\`)
      .set('Authorization', \`Bearer \${accessToken}\`);
    expect(res.status).toBe(204);
  });

  it('confirms item is gone after deletion', async () => {
    const res = await request(app)
      .get(\`/v1/items/\${itemId}\`)
      .set('Authorization', \`Bearer \${accessToken}\`);
    expect(res.status).toBe(404);
  });
});
`.trim();

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'test-suite',
    template: TEMPLATE,
    checklist: [
      'Install vitest (or jest) and supertest: npm install -D vitest supertest @types/supertest',
      'Configure vitest.config.ts: coverage provider v8, include src/**/*.ts, threshold 80%',
      'Create tests/ directory with unit/, integration/, and e2e/ subdirectories',
      'Write test fixture factories that create minimal valid objects with optional overrides',
      'Unit tests: test each service method in isolation — mock all dependencies with vi.fn()',
      'Unit test happy path: expected input produces expected output',
      'Unit test error cases: not found, forbidden, validation errors, repository failures',
      'Unit test edge cases: empty strings, boundary values, null/undefined, concurrent calls',
      'Integration tests: use supertest to send HTTP requests to the real Express app',
      'Integration test auth: verify 401 without token, 401 with expired token, 200 with valid token',
      'Integration test authorisation: verify 403 when accessing another user\'s resource',
      'Integration test validation: verify 422 with missing required fields, invalid types, out-of-range values',
      'Integration test pagination: verify page=1&pageSize=2 returns 2 items, meta.total is correct',
      'E2E tests: simulate a complete user journey from registration through full workflow to deletion',
      'Run coverage report: npx vitest run --coverage; verify no critical paths are uncovered',
      'Add CI step: vitest run --coverage --reporter=verbose fails the build if coverage < 80%',
      'Use afterEach to clean up test data; never rely on test execution order',
      'Separate test database or use transactions that are rolled back after each test',
      'Snapshot tests for complex output shapes (e.g., generated reports, API response structure)',
      'Add test for rate-limiting endpoint: 11th request in window should return 429',
    ],
    patterns: [
      'AAA pattern: Arrange → Act → Assert in every test case',
      'Test fixture factory: makeUser(), makeItem() functions with optional overrides',
      'Mock at the boundary: mock repositories in unit tests, use real DB in integration tests',
      'Test pyramid: many unit tests, fewer integration tests, few E2E tests',
      'Describe → nested describe → it hierarchy mirrors the module structure',
    ],
    gotchas: [
      'Testing implementation details instead of behaviour — tests break on every refactor',
      'Sharing mutable state between tests without cleanup — flaky test ordering dependency',
      'Mocking too deep: mocking the DB client instead of the repository causes brittle tests',
      'Not testing error paths — happy-path-only coverage misses the most bug-prone code',
      'Writing assertions on the wrong field — test passes but is not actually verifying the behaviour',
      'Not testing auth in integration tests — security bugs not caught until production',
      'Using setTimeout in tests without fake timers — slow and non-deterministic',
    ],
    resources: [
      'https://vitest.dev/guide/',
      'https://github.com/ladjs/supertest',
      'https://martinfowler.com/articles/practical-test-pyramid.html',
      'https://testing-library.com/docs/ (for React component tests)',
      'https://jestjs.io/docs/expect (matcher reference, compatible with vitest)',
    ],
  };
}
