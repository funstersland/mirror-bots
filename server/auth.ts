import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from './config.ts';
import { db, jwtSecret } from './db.ts';

const COOKIE = 'pb_session';
const MAX_AGE_S = 30 * 24 * 3600;

declare module 'fastify' {
  interface FastifyRequest {
    userId: number;
  }
}

interface UserRow {
  id: number;
  email: string;
  name: string;
  pass_hash: string;
}

const signupBody = z.object({
  name: z.string().trim().min(1).max(60),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
});
const loginBody = z.object({ email: z.string().trim().toLowerCase(), password: z.string() });

function setSession(reply: FastifyReply, userId: number) {
  const token = jwt.sign({ uid: userId }, jwtSecret(), { expiresIn: MAX_AGE_S });
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.production,
    maxAge: MAX_AGE_S,
  });
}

const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, name: u.name });

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[COOKIE];
  try {
    const { uid } = jwt.verify(token ?? '', jwtSecret()) as { uid: number };
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid);
    if (!exists) throw new Error('gone');
    req.userId = uid;
  } catch {
    return reply.code(401).send({ error: 'Not signed in' });
  }
}

export function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/signup', async (req, reply) => {
    if (!config.allowSignup) return reply.code(403).send({ error: 'Sign-ups are closed on this server' });
    const parsed = signupBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter a name, a valid email and a password of 8+ characters' });
    const { name, email, password } = parsed.data;
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      return reply.code(409).send({ error: 'An account with this email already exists' });
    }
    const hash = await bcrypt.hash(password, 11);
    const res = db.prepare('INSERT INTO users(email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)').run(email, name, hash, Date.now());
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(res.lastInsertRowid) as UserRow;
    setSession(reply, user.id);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter your email and password' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(parsed.data.email) as UserRow | undefined;
    const ok = user && (await bcrypt.compare(parsed.data.password, user.pass_hash));
    if (!ok) return reply.code(401).send({ error: 'Wrong email or password' });
    setSession(reply, user.id);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId) as UserRow;
    return { user: publicUser(user), allowSignup: config.allowSignup };
  });

  app.get('/api/auth/config', async () => ({ allowSignup: config.allowSignup }));
}
