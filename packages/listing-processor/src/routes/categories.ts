// Category API routes.

import type { FastifyInstance } from 'fastify';
import { callUploadApi } from '../upload-client.js';

export default async function (app: FastifyInstance) {

  app.get<{ Querystring: { q: string } }>('/api/categories/suggest', async (req, reply) => {
    const query = (req.query.q ?? '').trim();
    if (!query) return reply.code(400).send({ error: 'Query parameter q is required' });

    const result = await callUploadApi(`/api/category-suggestions?q=${encodeURIComponent(query)}`, { method: 'GET', timeout: 15 });
    if (!result.ok) return reply.code(502).send({ error: result.message ?? 'Category suggestion failed' });
    return result.data;
  });

  app.get<{ Params: { categoryId: string } }>('/api/categories/:categoryId/aspects', async (req, reply) => {
    const { categoryId } = req.params;
    const result = await callUploadApi(`/api/taxonomy/aspects/${categoryId}`, { method: 'GET', timeout: 25 });
    if (!result.ok) return reply.code(502).send({ error: result.message ?? 'Aspect lookup failed' });
    return result.data;
  });
}
