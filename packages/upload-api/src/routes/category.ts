import type { FastifyInstance } from 'fastify';
import { EbayClient, EbayTaxonomyClient, EbayApiError, EbayAuthError, loadEbayConfig } from '@ld/ebay-client';
import {
  getDb, getCachedCategorySpecifics, setCachedCategorySpecifics,
} from '../db.js';

const _taxonomyClient = (() => {
  try { return new EbayTaxonomyClient(loadEbayConfig()); }
  catch { return null; }
})();

export default async function (app: FastifyInstance) {
  const db = getDb();

  app.get<{ Params: { categoryId: string }; Querystring: { site_id?: string; refresh?: string } }>(
    '/api/category-specifics/:categoryId',
    async (req, reply) => {
      const { categoryId } = req.params;
      const siteId = req.query.site_id ?? '0';
      const refresh = ['1', 'true', 'yes'].includes(req.query.refresh ?? '');

      // Check cache (24h TTL)
      if (!refresh) {
        const cached = getCachedCategorySpecifics(db, categoryId, siteId);
        if (cached?.fetched_at) {
          try {
            const fetchedAt = new Date(cached.fetched_at.replace('Z', '+00:00'));
            const ageMs = Date.now() - fetchedAt.getTime();
            if (ageMs < 86_400_000) {
              const payload = JSON.parse(cached.payload_json);
              return { ...payload, cached: true, fetched_at: cached.fetched_at };
            }
          } catch { /* stale cache, refetch */ }
        }
      }

      try {
        const ebay = new EbayClient();
        const payload = await ebay.getCategorySpecifics(categoryId, siteId);
        setCachedCategorySpecifics(db, categoryId, siteId, payload);
        return { ...payload, cached: false };
      } catch (err) {
        if (err instanceof EbayAuthError) return reply.code(401).send({ status: 'error', error: err.message, type: 'auth' });
        if (err instanceof EbayApiError) return reply.code(502).send({ status: 'error', error: err.message });
        return reply.code(500).send({ status: 'error', error: (err as Error).message });
      }
    },
  );

  app.get<{ Querystring: { q: string } }>(
    '/api/category-suggestions',
    async (req, reply) => {
      const query = (req.query.q ?? '').trim();
      if (!query) return reply.code(400).send({ error: 'Query parameter q is required' });
      if (!_taxonomyClient) return reply.code(500).send({ error: 'Taxonomy client not configured' });

      try {
        const result = await _taxonomyClient.getCategorySuggestions(query);
        return result;
      } catch (err) {
        if (err instanceof EbayAuthError) return reply.code(401).send({ status: 'error', error: err.message, type: 'auth' });
        if (err instanceof EbayApiError) return reply.code(502).send({ status: 'error', error: err.message });
        return reply.code(500).send({ status: 'error', error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { categoryId: string }; Querystring: { refresh?: string } }>(
    '/api/taxonomy/aspects/:categoryId',
    async (req, reply) => {
      const { categoryId } = req.params;
      const refresh = ['1', 'true', 'yes'].includes(req.query.refresh ?? '');
      if (!_taxonomyClient) return reply.code(500).send({ error: 'Taxonomy client not configured' });

      // Check cache (24h TTL) — reuse existing cache table
      const cacheKey = `taxonomy_${categoryId}`;
      if (!refresh) {
        const cached = getCachedCategorySpecifics(db, cacheKey, '0');
        if (cached?.fetched_at) {
          try {
            const fetchedAt = new Date(cached.fetched_at.replace('Z', '+00:00'));
            const ageMs = Date.now() - fetchedAt.getTime();
            if (ageMs < 86_400_000) {
              return { ...JSON.parse(cached.payload_json), cached: true, fetched_at: cached.fetched_at };
            }
          } catch { /* stale cache, refetch */ }
        }
      }

      try {
        const result = await _taxonomyClient.getItemAspects(categoryId);
        setCachedCategorySpecifics(db, cacheKey, '0', result);
        return { ...result, cached: false };
      } catch (err) {
        if (err instanceof EbayAuthError) return reply.code(401).send({ status: 'error', error: err.message, type: 'auth' });
        if (err instanceof EbayApiError) return reply.code(502).send({ status: 'error', error: err.message });
        return reply.code(500).send({ status: 'error', error: (err as Error).message });
      }
    },
  );
}
