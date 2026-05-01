// Skill: crud — complete CRUD implementation guide

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
// ── 1. Model (src/models/item.ts) ─────────────────────────────────────────
export interface Item {
  id: string;
  name: string;
  description?: string;
  userId: string;       // ownership field — always include
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateItemInput {
  name: string;
  description?: string;
}

export interface UpdateItemInput {
  name?: string;
  description?: string;
}

// ── 2. Repository (src/repositories/item.repository.ts) ──────────────────
export interface ItemRepository {
  findById(id: string): Promise<Item | null>;
  findAllByUser(userId: string): Promise<Item[]>;
  create(userId: string, input: CreateItemInput): Promise<Item>;
  update(id: string, input: UpdateItemInput): Promise<Item>;
  delete(id: string): Promise<void>;
}

// PrismaItemRepository implements ItemRepository
export class PrismaItemRepository implements ItemRepository {
  constructor(private readonly db: PrismaClient) {}

  async findById(id: string): Promise<Item | null> {
    return this.db.item.findUnique({ where: { id } });
  }

  async findAllByUser(userId: string): Promise<Item[]> {
    return this.db.item.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  async create(userId: string, input: CreateItemInput): Promise<Item> {
    return this.db.item.create({ data: { ...input, userId } });
  }

  async update(id: string, input: UpdateItemInput): Promise<Item> {
    return this.db.item.update({ where: { id }, data: input });
  }

  async delete(id: string): Promise<void> {
    await this.db.item.delete({ where: { id } });
  }
}

// ── 3. Service (src/services/item.service.ts) ────────────────────────────
export class ItemService {
  constructor(private readonly repo: ItemRepository) {}

  async getItem(id: string, requestingUserId: string): Promise<Item> {
    const item = await this.repo.findById(id);
    if (!item) throw new NotFoundError('Item not found');
    if (item.userId !== requestingUserId) throw new ForbiddenError('Access denied');
    return item;
  }

  async listItems(userId: string): Promise<Item[]> {
    return this.repo.findAllByUser(userId);
  }

  async createItem(userId: string, input: CreateItemInput): Promise<Item> {
    return this.repo.create(userId, input);
  }

  async updateItem(id: string, input: UpdateItemInput, requestingUserId: string): Promise<Item> {
    await this.getItem(id, requestingUserId); // throws if not found or not owned
    return this.repo.update(id, input);
  }

  async deleteItem(id: string, requestingUserId: string): Promise<void> {
    await this.getItem(id, requestingUserId); // ownership check
    return this.repo.delete(id);
  }
}

// ── 4. Controller (src/controllers/item.controller.ts) ───────────────────
export class ItemController {
  constructor(private readonly service: ItemService) {}

  // GET /items
  list = async (req: Request, res: Response): Promise<void> => {
    const items = await this.service.listItems(req.user.id);
    res.json({ data: items });
  };

  // GET /items/:id
  get = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.getItem(req.params.id, req.user.id);
    res.json({ data: item });
  };

  // POST /items
  create = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.createItem(req.user.id, req.body);
    res.status(201).json({ data: item });
  };

  // PATCH /items/:id
  update = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.updateItem(req.params.id, req.body, req.user.id);
    res.json({ data: item });
  };

  // DELETE /items/:id
  delete = async (req: Request, res: Response): Promise<void> => {
    await this.service.deleteItem(req.params.id, req.user.id);
    res.status(204).send();
  };
}

// ── 5. Routes (src/routes/items.ts) ─────────────────────────────────────
import { Router } from 'express';
import { z } from 'zod';

const CreateItemSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

const UpdateItemSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
}).refine(obj => Object.keys(obj).length > 0, { message: 'At least one field required' });

export function createItemRouter(controller: ItemController): Router {
  const router = Router();
  router.get('/', controller.list);
  router.get('/:id', controller.get);
  router.post('/', validate(CreateItemSchema), controller.create);
  router.patch('/:id', validate(UpdateItemSchema), controller.update);
  router.delete('/:id', controller.delete);
  return router;
}
`.trim();

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'crud',
    template: TEMPLATE,
    checklist: [
      'Define TypeScript model interface with id, ownership field (userId), createdAt, updatedAt',
      'Define separate CreateInput and UpdateInput types (no id, no userId, all update fields optional)',
      'Create repository interface — program to the interface, not the implementation',
      'Implement repository with Prisma/Drizzle/raw queries; keep DB logic isolated here',
      'Implement service layer: all ownership and business rule checks happen here',
      'Add service method getById that always checks ownership before returning data',
      'Implement controller: parse request → call service → format response; no DB access',
      'Create Zod schemas for create and update request bodies',
      'Add validate middleware that runs Zod schema and returns 400 on failure',
      'Register routes: GET / (list), GET /:id, POST / (create), PATCH /:id, DELETE /:id',
      'Mount routes behind auth middleware so req.user is always populated',
      'Add 204 No Content for successful DELETE (no body)',
      'Add 201 Created with Location header for successful POST',
      'Write unit tests for service layer (mock the repository)',
      'Write integration tests covering happy path, 404, 403 (wrong user), 400 (bad input)',
      'Add pagination to the list endpoint: limit/offset or cursor-based',
      'Add filtering and sorting parameters to the list endpoint',
      'Document all endpoints with JSDoc or OpenAPI comments',
    ],
    patterns: [
      'Controller → Service → Repository three-layer architecture',
      'Repository pattern: data access is behind an interface for testability',
      'Ownership check in every service read/write operation (prevents IDOR)',
      'Zod schema validation at the route boundary',
      'Error-first service methods: throw typed errors, not returning null for auth failures',
    ],
    gotchas: [
      'Forgetting ownership check in the service — returns any user\'s data via IDOR',
      'Putting DB queries directly in controllers — bypasses repository layer and breaks tests',
      'Not returning 404 before 403 — leaks resource existence to unauthorised users (use 404 for both)',
      'Updating with empty body — add a Zod refine check that at least one field is present for PATCH',
      'Not invalidating caches after update/delete — stale data returned to other users',
      'Using findMany without a userId filter on list — returns all users\' data',
    ],
    resources: [
      'https://www.prisma.io/docs/concepts/components/prisma-client/crud',
      'https://zod.dev/',
      'https://owasp.org/www-project-api-security/ (API4:2023 Broken Object Level Authorization)',
      'https://expressjs.com/en/guide/routing.html',
    ],
  };
}
