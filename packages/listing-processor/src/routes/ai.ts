// AI API routes.

import type { FastifyInstance } from 'fastify';
import type { OdooProduct, OdooImage } from '@ld/odoo-sdk';
import { DEFAULT_PRODUCT_FIELDS } from '@ld/odoo-sdk';
import { ListingAIGenerator, testAiConnection, type CategoryContext } from '../ai-generator.js';
import { loadAiConfig, saveAiConfig } from '../config.js';
import { callUploadApi } from '../upload-client.js';
import { getOdoo, getProductImages } from '../helpers/odoo.js';

/** Known category name overrides. */
const CATEGORY_NAMES: Record<string, string> = {
  '177': 'Laptops & Netbooks',
  '179': 'PC Desktops & All-In-Ones',
};

/** Max aspect values to pass to the AI prompt per aspect. */
const MAX_ASPECT_VALUES = 15;

/**
 * Fetch full aspect metadata from the Upload API and build a CategoryContext.
 * Returns undefined if the fetch fails or category_id is not provided.
 */
async function buildCategoryContext(categoryId: string): Promise<CategoryContext | undefined> {
  try {
    const result = await callUploadApi(`/api/taxonomy/aspects/${categoryId}`, { method: 'GET', timeout: 25 });
    if (!result.ok || !result.data) return undefined;

    const data = result.data as { categoryName?: string; aspects?: Array<{ name: string; required?: boolean; usage?: string; values?: string[] }> };
    const aspects = data.aspects ?? [];

    const categoryName = CATEGORY_NAMES[categoryId] ?? data.categoryName ?? `Category ${categoryId}`;
    const requiredAspects: string[] = [];
    const recommendedAspects: string[] = [];
    const aspectValues: Record<string, string[]> = {};

    for (const aspect of aspects) {
      const name = aspect.name?.trim();
      if (!name) continue;

      // Collect values (cap to avoid token bloat)
      const vals = (aspect.values ?? []).map(v => String(v).trim()).filter(Boolean);
      if (vals.length > 0) {
        aspectValues[name] = vals.slice(0, MAX_ASPECT_VALUES);
      }

      // Classify by requirement level
      if (aspect.required === true || aspect.usage === 'REQUIRED') {
        requiredAspects.push(name);
      } else if (aspect.usage === 'RECOMMENDED') {
        recommendedAspects.push(name);
      }
    }

    return { categoryId, categoryName, requiredAspects, recommendedAspects, aspectValues };
  } catch (err) {
    console.warn(`Failed to build category context for ${categoryId}:`, err);
    return undefined;
  }
}

export default async function (app: FastifyInstance) {

  app.get('/api/ai/status', async () => {
    const config = loadAiConfig();
    return { configured: !!config.openai_api_key, model: config.model ?? 'gpt-4o-mini' };
  });

  app.post('/api/ai/test', async (req) => {
    const data = (req.body as Record<string, unknown>) ?? {};
    return testAiConnection(data.api_key as string | undefined);
  });

  app.get('/api/ai/config', async () => {
    const config = loadAiConfig();
    const result = { ...config } as Record<string, unknown>;
    if (config.openai_api_key) {
      const key = config.openai_api_key;
      result.openai_api_key_masked = key.length > 12 ? key.slice(0, 8) + '...' + key.slice(-4) : '***';
      delete result.openai_api_key;
    }
    return result;
  });

  app.post('/api/ai/config', async (req) => {
    const data = (req.body as Record<string, unknown>) ?? {};
    const config = loadAiConfig();
    const allowedFields = ['openai_api_key', 'model', 'title_system_prompt',
      'description_system_prompt', 'condition_notes', 'shipping_info', 'returns_policy'];
    for (const field of allowedFields) {
      if (field in data) (config as Record<string, unknown>)[field] = data[field];
    }
    saveAiConfig(config);
    return { status: 'ok', message: 'Configuration updated' };
  });

  app.post('/api/ai/generate-titles', async (req, reply) => {
    const data = (req.body as Record<string, unknown>) ?? {};
    const productId = Number(data.product_id);
    const count = Number(data.count ?? 5);
    const categoryId = data.category_id ? String(data.category_id) : undefined;
    if (!productId) return reply.code(400).send({ error: 'product_id required' });

    try {
      const gen = new ListingAIGenerator();
      if (!gen.isConfigured) return reply.code(400).send({ error: 'OpenAI API key not configured' });

      const odoo = getOdoo();
      if (!odoo) return reply.code(500).send({ error: 'Odoo connection failed' });

      const [product] = await odoo.read<OdooProduct>('product.product', [productId], [...DEFAULT_PRODUCT_FIELDS] as any);
      if (!product) return reply.code(404).send({ error: `Product ${productId} not found` });

      // Build category context if category_id provided
      let categoryContext: CategoryContext | undefined;
      if (categoryId) {
        categoryContext = await buildCategoryContext(categoryId);
      }

      const titles = await gen.generateTitles(product, count, undefined, categoryContext);
      return { status: 'ok', product_id: productId, titles };
    } catch (err) {
      console.error('AI title generation failed:', err);
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.post('/api/ai/generate-description', async (req, reply) => {
    const data = (req.body as Record<string, unknown>) ?? {};
    const productId = Number(data.product_id);
    const categoryId = data.category_id ? String(data.category_id) : undefined;
    if (!productId) return reply.code(400).send({ error: 'product_id required' });

    try {
      const gen = new ListingAIGenerator();
      if (!gen.isConfigured) return reply.code(400).send({ error: 'OpenAI API key not configured' });

      const odoo = getOdoo();
      if (!odoo) return reply.code(500).send({ error: 'Odoo connection failed' });

      const [product] = await odoo.read<OdooProduct>('product.product', [productId], [...DEFAULT_PRODUCT_FIELDS] as any);
      if (!product) return reply.code(404).send({ error: `Product ${productId} not found` });

      // Build category context if category_id provided
      let categoryContext: CategoryContext | undefined;
      if (categoryId) {
        categoryContext = await buildCategoryContext(categoryId);
      }

      let images: OdooImage[] = [];
      try { images = await getProductImages(odoo, productId); } catch { /* ignore */ }

      const description = await gen.generateDescription(product, {
        systemPrompt: data.system_prompt as string | undefined,
        conditionNotes: data.condition_notes as string | undefined,
        shippingInfo: data.shipping_info as string | undefined,
        returnsPolicy: data.returns_policy as string | undefined,
        images,
        categoryContext,
      });

      if (!description || description.trim().length < 50) {
        return reply.code(500).send({ error: 'AI returned an empty description. This is an intermittent issue — please try again.' });
      }

      return { status: 'ok', product_id: productId, description_html: description };
    } catch (err) {
      console.error('AI description generation failed:', err);
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
