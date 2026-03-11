import type { FastifyInstance } from 'fastify';
import { EbayClient, EbayTaxonomyClient, loadEbayConfig } from '@ld/ebay-client';
import { getDb, getFreshCache, setCachedCategorySpecifics } from '../db.js';
import { sendEbayError } from '../helpers/ebay-errors.js';

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

      if (!refresh) {
        const hit = getFreshCache(db, categoryId, siteId);
        if (hit) return hit;
      }

      try {
        const ebay = new EbayClient();
        const payload = await ebay.getCategorySpecifics(categoryId, siteId);
        setCachedCategorySpecifics(db, categoryId, siteId, payload);
        return { ...payload, cached: false };
      } catch (err) {
        return sendEbayError(reply, err);
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
        return sendEbayError(reply, err);
      }
    },
  );

  app.get<{ Params: { categoryId: string }; Querystring: { refresh?: string } }>(
    '/api/taxonomy/aspects/:categoryId',
    async (req, reply) => {
      const { categoryId } = req.params;
      const refresh = ['1', 'true', 'yes'].includes(req.query.refresh ?? '');
      if (!_taxonomyClient) return reply.code(500).send({ error: 'Taxonomy client not configured' });

      const cacheKey = `taxonomy_${categoryId}`;
      if (!refresh) {
        const hit = getFreshCache(db, cacheKey, '0');
        if (hit) return hit;
      }

      try {
        const result = await _taxonomyClient.getItemAspects(categoryId);
        setCachedCategorySpecifics(db, cacheKey, '0', result);
        return { ...result, cached: false };
      } catch (err) {
        return sendEbayError(reply, err);
      }
    },
  );
}
