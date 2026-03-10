// @ld/listing-processor — Fastify web UI for eBay listing management.
// Port of app.py (Flask) to Fastify 5 + Eta templates.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyFormbody from '@fastify/formbody';
import fastifyCookie from '@fastify/cookie';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDb } from './db.js';

// Route plugins
import dashboardRoutes from './routes/dashboard.js';
import productRoutes from './routes/products.js';
import queueRoutes from './routes/queue.js';
import settingsRoutes from './routes/settings.js';
import aiRoutes from './routes/ai.js';
import categoryRoutes from './routes/categories.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const PORT = Number(process.env.PORT ?? 5050);
const HOST = process.env.HOST ?? '0.0.0.0';

// ── Bootstrap ───────────────────────────────────────────────────────

// Ensure DB is initialized early
getDb();

const app = Fastify({ logger: true });

const COOKIE_SECRET = process.env.COOKIE_SECRET;
if (!COOKIE_SECRET) {
  throw new Error('COOKIE_SECRET environment variable must be set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

await app.register(cors, {
  origin: process.env.CORS_ORIGIN ?? false,
});
await app.register(fastifyFormbody);
await app.register(fastifyCookie, { secret: COOKIE_SECRET });
await app.register(fastifyStatic, {
  root: join(ROOT, 'static'),
  prefix: '/static/',
});

// ── Health ──────────────────────────────────────────────────────────

app.get('/health', async () => ({
  status: 'ok',
  time: new Date().toISOString(),
}));

// ── Register Route Plugins ──────────────────────────────────────────

await app.register(dashboardRoutes);
await app.register(productRoutes);
await app.register(queueRoutes);
await app.register(settingsRoutes);
await app.register(aiRoutes);
await app.register(categoryRoutes);

// ── Start ───────────────────────────────────────────────────────────

const address = await app.listen({ port: PORT, host: HOST });
console.log(`\n📦 Listing Processor listening on ${address}`);
