import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadApiKey } from './helpers.js';
import { getDb } from './db.js';

// Route plugins
import healthRoutes from './routes/health.js';
import connectionRoutes from './routes/connection.js';
import categoryRoutes from './routes/category.js';
import uploadRoutes from './routes/upload.js';
import verifyRoutes from './routes/verify.js';
import reviseRoutes from './routes/revise.js';
import statusRoutes from './routes/status.js';

const PORT = Number(process.env.PORT ?? 5051);
const HOST = process.env.HOST ?? '0.0.0.0';

// ── Bootstrap ───────────────────────────────────────────────────────

const apiKey = loadApiKey();
getDb(); // ensure DB is initialized before accepting requests
const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.LISTING_PROCESSOR_ORIGIN ?? 'http://localhost:5050',
});

// ── Auth hook ───────────────────────────────────────────────────────

app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  if (req.headers['x-api-key'] !== apiKey) {
    return reply.code(401).send({ error: 'Invalid or missing API key' });
  }
});

// ── Register route plugins ──────────────────────────────────────────

await app.register(healthRoutes);
await app.register(connectionRoutes);
await app.register(categoryRoutes);
await app.register(uploadRoutes);
await app.register(verifyRoutes);
await app.register(reviseRoutes);
await app.register(statusRoutes);

// ── Start ──────────────────────────────────────────────────────────

const address = await app.listen({ port: PORT, host: HOST });
console.log(`\n📦 Upload API listening on ${address}`);
console.log(`🔑 API key loaded (${apiKey.slice(0, 8)}...)\n`);
