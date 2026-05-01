// Skill: auth — JWT + bcrypt + refresh token implementation guide

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
// ── Types (src/models/auth.ts) ────────────────────────────────────────────
export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: 'admin' | 'user';
  failedLoginAttempts: number;
  lockedUntil?: Date | null;
  createdAt: Date;
}

export interface TokenPair {
  accessToken: string;   // short-lived, stateless JWT
  refreshToken: string;  // long-lived, stored in DB
}

// ── Token utilities (src/utils/tokens.ts) ────────────────────────────────
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET!;   // 256-bit random
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!; // separate secret
const ACCESS_TTL = '15m';
const REFRESH_TTL = '7d';

export function signAccessToken(userId: string, role: string): string {
  return jwt.sign({ sub: userId, role }, ACCESS_SECRET, {
    expiresIn: ACCESS_TTL,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): { sub: string; role: string } {
  return jwt.verify(token, ACCESS_SECRET, { algorithms: ['HS256'] }) as { sub: string; role: string };
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex'); // 512 bits of entropy
}

// ── Auth service (src/services/auth.service.ts) ───────────────────────────
import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 12;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 30;

export class AuthService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly tokenRepo: RefreshTokenRepository,
  ) {}

  async register(email: string, password: string): Promise<User> {
    const existing = await this.userRepo.findByEmail(email);
    if (existing) throw new ConflictError('Email already registered');
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    return this.userRepo.create({ email: email.toLowerCase().trim(), passwordHash });
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.userRepo.findByEmail(email.toLowerCase().trim());
    if (!user) throw new UnauthorizedError('Invalid credentials');

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedError('Account locked. Check your email to unlock.');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await this.recordFailedAttempt(user);
      throw new UnauthorizedError('Invalid credentials');
    }

    await this.userRepo.resetFailedAttempts(user.id);
    return this.issueTokenPair(user.id, user.role);
  }

  async refresh(rawRefreshToken: string): Promise<TokenPair> {
    const tokenHash = hashToken(rawRefreshToken);
    const stored = await this.tokenRepo.findByHash(tokenHash);
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }
    // Rotate: revoke old, issue new
    await this.tokenRepo.revoke(stored.id);
    return this.issueTokenPair(stored.userId, stored.role);
  }

  async logout(rawRefreshToken: string): Promise<void> {
    const tokenHash = hashToken(rawRefreshToken);
    const stored = await this.tokenRepo.findByHash(tokenHash);
    if (stored) await this.tokenRepo.revoke(stored.id);
  }

  private async issueTokenPair(userId: string, role: string): Promise<TokenPair> {
    const rawRefreshToken = generateRefreshToken();
    await this.tokenRepo.create({
      userId,
      tokenHash: hashToken(rawRefreshToken),
      role,
      expiresAt: addDays(new Date(), 7),
    });
    return {
      accessToken: signAccessToken(userId, role),
      refreshToken: rawRefreshToken,
    };
  }

  private async recordFailedAttempt(user: User): Promise<void> {
    const attempts = user.failedLoginAttempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      const lockedUntil = addMinutes(new Date(), LOCKOUT_MINUTES);
      await this.userRepo.lockAccount(user.id, lockedUntil);
      // TODO: send unlock email
    } else {
      await this.userRepo.incrementFailedAttempts(user.id);
    }
  }
}

// ── Auth middleware (src/middleware/auth.ts) ───────────────────────────────
import { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }
  try {
    const payload = verifyAccessToken(header.slice(7));
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired access token' });
  }
}

export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.user?.role !== role) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

// ── Auth routes (src/routes/auth.ts) ─────────────────────────────────────
import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true });

const RegisterSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(12).max(128),
});

const LoginSchema = RegisterSchema;

export function createAuthRouter(service: AuthService): Router {
  const router = Router();
  router.use(authLimiter);

  router.post('/register', validate(RegisterSchema), async (req, res) => {
    const user = await service.register(req.body.email, req.body.password);
    res.status(201).json({ data: { id: user.id, email: user.email } });
  });

  router.post('/login', validate(LoginSchema), async (req, res) => {
    const tokens = await service.login(req.body.email, req.body.password);
    res
      .cookie('refreshToken', tokens.refreshToken, {
        httpOnly: true, secure: true, sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000,
      })
      .json({ data: { accessToken: tokens.accessToken } });
  });

  router.post('/refresh', async (req, res) => {
    const raw = req.cookies?.refreshToken;
    if (!raw) { res.status(401).json({ error: 'No refresh token' }); return; }
    const tokens = await service.refresh(raw);
    res
      .cookie('refreshToken', tokens.refreshToken, {
        httpOnly: true, secure: true, sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000,
      })
      .json({ data: { accessToken: tokens.accessToken } });
  });

  router.post('/logout', async (req, res) => {
    const raw = req.cookies?.refreshToken;
    if (raw) await service.logout(raw);
    res.clearCookie('refreshToken').status(204).send();
  });

  return router;
}
`.trim();

export function run(input: SkillInput): SkillOutput {
  return {
    skill: 'auth',
    template: TEMPLATE,
    checklist: [
      'Install: npm install bcrypt jsonwebtoken cookie-parser express-rate-limit && npm install -D @types/bcrypt @types/jsonwebtoken @types/cookie-parser',
      'Generate two separate 256-bit secrets: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET via crypto.randomBytes(32).toString("hex")',
      'Store both secrets in environment variables; never hardcode them',
      'Implement User model with passwordHash (never password), failedLoginAttempts, lockedUntil fields',
      'Implement RefreshToken model with userId, tokenHash (SHA-256 of raw token), expiresAt, revokedAt',
      'Set bcrypt cost factor to 12; adjust up if server can handle the latency',
      'Set access token TTL to 15 minutes; set refresh token TTL to 7 days',
      'Always call jwt.verify with explicit { algorithms: ["HS256"] } — never allow alg negotiation',
      'Implement refresh token rotation: revoke old token, issue new token on every /refresh call',
      'Store the SHA-256 hash of the refresh token in DB, never the raw value',
      'Deliver access token in response body; deliver refresh token in httpOnly Secure SameSite=Strict cookie',
      'Apply express-rate-limit (10 req/15 min) to all auth endpoints',
      'Implement account lockout: after 5 failures, lock for 30 minutes and send unlock email',
      'Normalise email input: .toLowerCase().trim() before lookup or storage',
      'Return identical error messages for invalid credentials regardless of whether user exists (prevents enumeration)',
      'Implement /logout that revokes refresh token from DB and clears cookie',
      'Implement password reset: generate a single-use HMAC token, send via email, expire in 1 hour',
      'Log every auth event (login success/fail, logout, token refresh, lockout) with userId, IP, user-agent',
      'Write unit tests for AuthService mocking repositories',
      'Write integration tests: register → login → refresh → logout → verify refresh fails after logout',
    ],
    patterns: [
      'Stateless access token + stateful refresh token hybrid',
      'Refresh token rotation with database revocation',
      'httpOnly cookie for refresh token (XSS-safe delivery)',
      'Hash-before-store for refresh tokens (never store raw token)',
      'Rate limiter middleware applied at router level, not per-route',
    ],
    gotchas: [
      'Not rotating refresh tokens on use — a stolen refresh token can be used indefinitely',
      'Accepting jwt.verify without specifying algorithms — "alg":"none" bypass attack',
      'Storing refresh tokens in localStorage — immediately exposed to any XSS vulnerability',
      'Using a short bcrypt salt rounds (< 10) — trivial brute force offline after DB leak',
      'Reusing the same secret for access and refresh tokens — compromise of one breaks both',
      'Not invalidating access tokens on logout — they remain valid until expiry (15 min window)',
      'Not sending identical error messages for bad username vs bad password — enables enumeration',
    ],
    resources: [
      'https://www.npmjs.com/package/jsonwebtoken',
      'https://www.npmjs.com/package/bcrypt',
      'https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html',
      'https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html',
      'https://datatracker.ietf.org/doc/html/rfc6749 (OAuth 2.0)',
    ],
  };
}
