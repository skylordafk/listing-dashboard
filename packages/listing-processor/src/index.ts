// @ld/listing-processor — Fastify web UI for eBay listing management.
// Port of app.py (Flask) to Fastify 5 + Eta templates.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyFormbody from '@fastify/formbody';
import fastifyCookie from '@fastify/cookie';
import { Eta } from 'eta';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { OdooClient, type OdooProduct, DEFAULT_PRODUCT_FIELDS } from '@ld/odoo-sdk';
import {
  getDb, getListingByProductId, getListingById, getListingsByStatus,
  getStatusCounts, upsertListing, updateListingFields, getListingProductIds,
  type ListingRow,
} from './db.js';
import {
  finalizeListingData, listingQualityWarnings, applyListingFormOverrides,
  normalizeItemSpecifics, EBAY_177_ALLOWED_SPECIFICS, type ListingData,
} from './normalizer.js';
import { productToListing, EBAY_CATEGORY_LAPTOP, type OdooImage } from './field-mapper.js';
import {
  callUploadApi, buildIdempotencyKey, extractNonzeroFees, formatUploadApiError,
  type UploadResponseData,
} from './upload-client.js';
import { ListingAIGenerator, testAiConnection, type CategoryContext } from './ai-generator.js';
import {
  loadAiConfig, saveAiConfig, loadEbayAppConfig, saveEbayAppConfig, loadUploadApiKey,
  UPLOAD_API_URL,
} from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const PORT = Number(process.env.PORT ?? 5050);
const HOST = process.env.HOST ?? '0.0.0.0';

// ── Bootstrap ───────────────────────────────────────────────────────

const db = getDb();
const app = Fastify({ logger: true });

const eta = new Eta({
  views: join(ROOT, 'templates'),
  autoEscape: true,
  cache: process.env.NODE_ENV === 'production',
});

const COOKIE_SECRET = process.env.COOKIE_SECRET ?? randomBytes(32).toString('hex');

await app.register(cors);
await app.register(fastifyFormbody);
await app.register(fastifyCookie, { secret: COOKIE_SECRET });
await app.register(fastifyStatic, {
  root: join(ROOT, 'static'),
  prefix: '/static/',
});

// ── Flash Messages ──────────────────────────────────────────────────

interface FlashMsg { category: string; message: string; }

function setFlash(reply: any, messages: FlashMsg[]): void {
  const existing = getFlashFromCookie(reply.request);
  const all = [...existing, ...messages];
  reply.setCookie('__flash', JSON.stringify(all), {
    path: '/', httpOnly: true, maxAge: 30, signed: true,
  });
}

function flash(reply: any, category: string, message: string): void {
  setFlash(reply, [{ category, message }]);
}

function getFlashFromCookie(request: any): FlashMsg[] {
  try {
    const raw = request.unsignCookie(request.cookies.__flash ?? '');
    if (!raw.valid || !raw.value) return [];
    return JSON.parse(raw.value) as FlashMsg[];
  } catch { return []; }
}

function consumeFlash(request: any, reply: any): FlashMsg[] {
  const messages = getFlashFromCookie(request);
  if (messages.length > 0) {
    reply.clearCookie('__flash', { path: '/' });
  }
  return messages;
}

// ── Render Helper ───────────────────────────────────────────────────

function render(
  request: any,
  reply: any,
  template: string,
  data: Record<string, unknown> = {},
): string {
  const flashes = consumeFlash(request, reply);
  const activeNav = data.activeNav ?? '';
  const tplPath = template.startsWith('./') ? template : `./${template}`;
  return eta.render(tplPath, { ...data, flashes, activeNav });
}

// ── Odoo Helper ─────────────────────────────────────────────────────

function getOdoo(): OdooClient | null {
  try {
    return OdooClient.fromEnv();
  } catch {
    return null;
  }
}

async function getProductImages(odoo: OdooClient, productId: number): Promise<OdooImage[]> {
  return odoo.searchRead<OdooImage>(
    'ir.attachment',
    [
      ['res_model', '=', 'product.template'],
      ['res_id', '=', productId],
      ['mimetype', 'like', 'image/'],
    ],
    { fields: ['id', 'datas', 'name', 'mimetype'] as any },
  );
}

async function getProductImageCounts(
  odoo: OdooClient,
  productIds: number[],
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (productIds.length === 0) return result;
  // Batch: fetch all image attachments for these product IDs
  const attachments = await odoo.searchRead<{ res_id: number }>(
    'ir.attachment',
    [
      ['res_model', '=', 'product.template'],
      ['res_id', 'in', productIds],
      ['mimetype', 'like', 'image/'],
    ],
    { fields: ['res_id'] as any },
  );
  for (const att of attachments) {
    result.set(att.res_id, (result.get(att.res_id) ?? 0) + 1);
  }
  return result;
}

// ── Listing Helpers ─────────────────────────────────────────────────

function getExistingListing(productId: number): { existing: ListingRow | undefined; savedData: Record<string, unknown> } {
  const existing = getListingByProductId(db, productId);
  if (!existing) return { existing: undefined, savedData: {} };
  let savedData: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(existing.listing_data ?? '{}');
    if (typeof parsed === 'object' && parsed !== null) savedData = parsed;
  } catch { /* ignore */ }
  return { existing, savedData };
}

function mergeSavedListingData(
  listingData: ListingData,
  savedData: Record<string, unknown>,
): ListingData {
  if (!savedData || Object.keys(savedData).length === 0) return listingData;
  const merged = { ...listingData } as Record<string, unknown>;
  for (const [key, value] of Object.entries(savedData)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value === '') continue;
    merged[key] = value;
  }
  return merged as ListingData;
}

function listingDataFromSavedOnly(
  existing: ListingRow,
  savedData: Record<string, unknown>,
): ListingData {
  const data = { ...savedData } as ListingData;
  if (!data.title) data.title = existing.title ?? 'Untitled Listing';
  if (data.price == null) data.price = existing.price ?? 0;
  data.condition_description ??= '';
  data.description_html ??= '';
  data.item_specifics ??= [];
  return finalizeListingData(data);
}

// ── Category Specifics Cache ────────────────────────────────────────

const _categorySpecCache: Record<string, { fetchedAt: number; value: Record<string, string[]> }> = {};
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function getCategorySpecificOptions(categoryId: string = EBAY_CATEGORY_LAPTOP): Promise<Record<string, string[]>> {
  const cached = _categorySpecCache[categoryId];
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) return cached.value;

  // Try Taxonomy REST API first (richer data), fall back to Trading API
  let result = await callUploadApi(`/api/taxonomy/aspects/${categoryId}`, { method: 'GET', timeout: 25 });
  if (!result.ok) {
    result = await callUploadApi(`/api/category-specifics/${categoryId}`, { method: 'GET', timeout: 25 });
  }
  if (!result.ok) return cached?.value ?? {};

  const data = result.data ?? {};
  const options: Record<string, string[]> = {};
  // Taxonomy API uses 'name', Trading API also uses 'name' — both have 'values' array
  for (const aspect of (data.aspects as Array<{ name: string; values: string[] }>) ?? []) {
    const name = aspect.name?.trim();
    if (!name) continue;
    options[name] = (aspect.values ?? []).map(v => String(v).trim()).filter(Boolean);
  }

  _categorySpecCache[categoryId] = { fetchedAt: Date.now(), value: options };
  return options;
}

// ── Routes: Health ──────────────────────────────────────────────────

app.get('/health', async () => ({
  status: 'ok',
  time: new Date().toISOString(),
}));

// ── Routes: Dashboard ───────────────────────────────────────────────

app.get('/', async (req, reply) => {
  const odoo = getOdoo();
  let odooCount = 0;
  let odooError: string | null = null;
  if (odoo) {
    try {
      odooCount = await odoo.searchCount('product.product', []);
    } catch (err) {
      odooError = (err as Error).message;
    }
  }
  const counts = getStatusCounts(db);
  reply.type('text/html');
  return render(req, reply, 'dashboard', { counts, odooCount, odooError, activeNav: 'dashboard' });
});

// ── Routes: Products ────────────────────────────────────────────────

app.get<{ Querystring: { page?: string; per_page?: string; filter?: string; status?: string } }>(
  '/products',
  async (req, reply) => {
    const LISTING_STATUSES = ['draft', 'approved', 'rejected', 'uploading', 'uploaded', 'failed'] as const;
    const PER_PAGE_OPTIONS = [50, 100, 200, 500];
    const listingFilterOptions = [
      ['all', 'All'], ['unlisted', 'Unlisted'],
      ...LISTING_STATUSES.map(s => [s, s.charAt(0).toUpperCase() + s.slice(1)]),
    ];

    const odoo = getOdoo();
    if (!odoo) {
      flash(reply, 'error', 'Cannot connect to Odoo');
      reply.type('text/html');
      return render(req, reply, 'products', {
        products: [], error: 'Cannot connect to Odoo',
        page: 1, totalPages: 0, total: 0, scanFilter: 'all',
        countAll: 0, countScanned: 0, countUnscanned: 0, currentScanTotal: 0,
        listedCount: 0, perPage: 100, perPageOptions: PER_PAGE_OPTIONS,
        listingFilter: 'all', listingFilterOptions,
        statusCounts: Object.fromEntries([...LISTING_STATUSES, 'unlisted'].map(s => [s, 0])),
        activeNav: 'products',
      });
    }

    let page = Math.max(parseInt(req.query.page ?? '1', 10) || 1, 1);
    let perPage = parseInt(req.query.per_page ?? '100', 10) || 100;
    if (!PER_PAGE_OPTIONS.includes(perPage)) perPage = 100;
    const scanFilter = ['all', 'scanned', 'unscanned'].includes(req.query.filter ?? '') ? req.query.filter! : 'all';
    const validStatuses = new Set(['all', 'unlisted', ...LISTING_STATUSES]);
    const listingFilter = validStatuses.has(req.query.status ?? '') ? req.query.status! : 'all';

    try {
      const scanDomain = (f: string) => {
        if (f === 'scanned') return [['x_processor', '!=', false]] as Array<[string, string, unknown]>;
        if (f === 'unscanned') return [['x_processor', '=', false]] as Array<[string, string, unknown]>;
        return [] as Array<[string, string, unknown]>;
      };

      const filteredScanTotal = await odoo.searchCount('product.product', scanDomain(scanFilter));
      const allProducts: OdooProduct[] = [];
      const batchSize = 500;
      for (let offset = 0; offset < filteredScanTotal; offset += batchSize) {
        const batch = await odoo.searchRead<OdooProduct>(
          'product.product', scanDomain(scanFilter),
          { fields: [...DEFAULT_PRODUCT_FIELDS] as any, limit: batchSize, offset },
        );
        allProducts.push(...batch);
      }

      const countAll = await odoo.searchCount('product.product', []);
      const countScanned = await odoo.searchCount('product.product', [['x_processor', '!=', false]]);
      const countUnscanned = countAll - countScanned;

      // Lookup listing statuses
      const productIds = allProducts.map(p => p.id);
      const listingByProductId = getListingProductIds(db, productIds);

      const statusCounts: Record<string, number> = Object.fromEntries(
        [...LISTING_STATUSES, 'unlisted'].map(s => [s, 0])
      );

      const enriched = allProducts.map(p => {
        const listing = listingByProductId.get(p.id);
        const listingStatus = listing?.status ?? null;
        const listingId = listing?.id ?? null;
        const hasSpecs = !!p.x_processor;

        if (listingStatus && listingStatus in statusCounts) {
          statusCounts[listingStatus]!++;
        } else {
          statusCounts.unlisted!++;
        }

        return { ...p, listing_status: listingStatus, listing_id: listingId, has_specs: hasSpecs, image_count: 0 };
      });

      // Filter by listing status
      let filteredProducts = enriched;
      if (listingFilter === 'unlisted') {
        filteredProducts = enriched.filter(p => !p.listing_status);
      } else if (LISTING_STATUSES.includes(listingFilter as any)) {
        filteredProducts = enriched.filter(p => p.listing_status === listingFilter);
      }

      const total = filteredProducts.length;
      const totalPages = Math.ceil(total / perPage) || 0;
      if (totalPages > 0 && page > totalPages) page = totalPages;
      const offset = (page - 1) * perPage;
      const productList = filteredProducts.slice(offset, offset + perPage);

      // Get image counts
      try {
        const imageCounts = await getProductImageCounts(odoo, productList.map(p => p.id));
        for (const p of productList) {
          p.image_count = imageCounts.get(p.id) ?? 0;
        }
      } catch { /* ignore */ }

      let listedCount = 0;
      for (const p of productList) {
        if (p.listing_status === 'uploaded') listedCount++;
      }

      reply.type('text/html');
      return render(req, reply, 'products', {
        products: productList, page, totalPages, total,
        scanFilter, countAll, countScanned, countUnscanned,
        currentScanTotal: filteredScanTotal, listedCount,
        perPage, perPageOptions: PER_PAGE_OPTIONS,
        listingFilter, listingFilterOptions, statusCounts,
        activeNav: 'products',
      });
    } catch (err) {
      flash(reply, 'error', `Odoo error: ${(err as Error).message}`);
      reply.type('text/html');
      return render(req, reply, 'products', {
        products: [], error: (err as Error).message,
        page: 1, totalPages: 0, total: 0, scanFilter,
        countAll: 0, countScanned: 0, countUnscanned: 0, currentScanTotal: 0,
        listedCount: 0, perPage, perPageOptions: PER_PAGE_OPTIONS,
        listingFilter, listingFilterOptions,
        statusCounts: Object.fromEntries([...LISTING_STATUSES, 'unlisted'].map(s => [s, 0])),
        activeNav: 'products',
      });
    }
  },
);

// ── Routes: Preview ─────────────────────────────────────────────────

app.get<{ Params: { productId: string } }>('/products/:productId/preview', async (req, reply) => {
  const productId = Number(req.params.productId);
  const odoo = getOdoo();
  if (!odoo) {
    flash(reply, 'error', 'Cannot connect to Odoo');
    return reply.redirect('/products');
  }

  try {
    const [product] = await odoo.read<OdooProduct>('product.product', [productId], [...DEFAULT_PRODUCT_FIELDS] as any);
    if (!product) {
      flash(reply, 'error', 'Product not found');
      return reply.redirect('/products');
    }

    const images = await getProductImages(odoo, productId);
    const { existing, savedData } = getExistingListing(productId);
    let listingData = mergeSavedListingData(productToListing(product, images), savedData);

    const categoryId = String(listingData.category_id ?? EBAY_CATEGORY_LAPTOP);
    const specificOptions = await getCategorySpecificOptions(categoryId);
    listingData = finalizeListingData(listingData, specificOptions);
    const qualityWarnings = listingQualityWarnings(listingData);

    const allSpecificNames = new Set([...EBAY_177_ALLOWED_SPECIFICS, ...Object.keys(specificOptions)]);
    const sortedSpecificNames = [...allSpecificNames].sort();

    reply.type('text/html');
    return render(req, reply, 'preview', {
      product, listing: listingData, images, existing,
      qualityWarnings, ebaySpecificNames: sortedSpecificNames,
      ebaySpecificValueOptions: specificOptions,
      categoryId,
      activeNav: 'products',
    });
  } catch (err) {
    flash(reply, 'error', `Error loading product: ${(err as Error).message}`);
    return reply.redirect('/products');
  }
});

// ── Routes: Approve ─────────────────────────────────────────────────

app.post<{ Params: { productId: string } }>('/products/:productId/approve', async (req, reply) => {
  const productId = Number(req.params.productId);
  const odoo = getOdoo();
  if (!odoo) { flash(reply, 'error', 'Cannot connect to Odoo'); return reply.redirect('/products'); }

  try {
    const [product] = await odoo.read<OdooProduct>('product.product', [productId], [...DEFAULT_PRODUCT_FIELDS] as any);
    if (!product) { flash(reply, 'error', 'Product not found'); return reply.redirect('/products'); }

    const images = await getProductImages(odoo, productId);
    const { existing, savedData } = getExistingListing(productId);
    let listingData = mergeSavedListingData(productToListing(product, images), savedData);

    const ebayConfig = loadEbayAppConfig();
    const categoryId = String((req.body as Record<string, string>).category_id ?? listingData.category_id ?? EBAY_CATEGORY_LAPTOP);
    const categoryOptions = await getCategorySpecificOptions(categoryId);
    listingData = applyListingFormOverrides(
      listingData, req.body as Record<string, string>,
      categoryOptions, ebayConfig.default_condition_description,
    );

    const warnings = listingQualityWarnings(listingData);
    for (const w of warnings) flash(reply, 'warning', `Listing quality: ${w}`);

    const now = new Date().toISOString();
    upsertListing(db, productId, product.name, 'approved',
      JSON.stringify(listingData), listingData.title, listingData.price,
      { approved_at: now, notes: null as any, error_message: null as any });

    flash(reply, 'success', `Approved: ${listingData.title}`);
  } catch (err) {
    flash(reply, 'error', `Error approving: ${(err as Error).message}`);
  }

  return reply.redirect('/queue');
});

// ── Routes: Reject ──────────────────────────────────────────────────

app.post<{ Params: { productId: string } }>('/products/:productId/reject', async (req, reply) => {
  const productId = Number(req.params.productId);
  const form = req.body as Record<string, string>;
  const notes = form.notes ?? '';

  const odoo = getOdoo();
  let product: OdooProduct | null = null;
  if (odoo) {
    try {
      const results = await odoo.read<OdooProduct>('product.product', [productId], [...DEFAULT_PRODUCT_FIELDS] as any);
      product = results[0] ?? null;
    } catch { /* ignore */ }
  }

  const { existing } = getExistingListing(productId);
  if (existing) {
    updateListingFields(db, existing.id, { status: 'rejected', notes });
  } else {
    const listingData = product ? productToListing(product, []) : { title: 'Unknown', price: 0, item_specifics: [], description_html: '' } as ListingData;
    upsertListing(db, productId, product?.name ?? 'Unknown', 'rejected',
      JSON.stringify(listingData), listingData.title, listingData.price, { notes });
  }

  flash(reply, 'warning', 'Listing rejected');
  return reply.redirect('/products');
});

// ── Routes: Edit (save draft) ───────────────────────────────────────

app.post<{ Params: { productId: string } }>('/products/:productId/edit', async (req, reply) => {
  const productId = Number(req.params.productId);
  const odoo = getOdoo();
  if (!odoo) { flash(reply, 'error', 'Cannot connect to Odoo'); return reply.redirect('/products'); }

  try {
    const [product] = await odoo.read<OdooProduct>('product.product', [productId], [...DEFAULT_PRODUCT_FIELDS] as any);
    if (!product) { flash(reply, 'error', 'Product not found'); return reply.redirect('/products'); }

    const images = await getProductImages(odoo, productId);
    const { existing, savedData } = getExistingListing(productId);
    let listingData = mergeSavedListingData(productToListing(product, images), savedData);
    listingData = finalizeListingData(listingData);

    const ebayConfig = loadEbayAppConfig();
    const categoryId = String((req.body as Record<string, string>).category_id ?? listingData.category_id ?? EBAY_CATEGORY_LAPTOP);
    const categoryOptions = await getCategorySpecificOptions(categoryId);
    listingData = applyListingFormOverrides(
      listingData, req.body as Record<string, string>,
      categoryOptions, ebayConfig.default_condition_description,
    );

    const warnings = listingQualityWarnings(listingData);
    for (const w of warnings) flash(reply, 'warning', `Listing quality: ${w}`);

    upsertListing(db, productId, product.name, 'draft',
      JSON.stringify(listingData), listingData.title, listingData.price);

    flash(reply, 'info', 'Listing saved as draft');
  } catch (err) {
    flash(reply, 'error', `Error saving: ${(err as Error).message}`);
  }

  return reply.redirect(`/products/${productId}/preview`);
});

// ── Routes: Save Changes (uploaded listings) ────────────────────────

app.post<{ Params: { productId: string } }>('/products/:productId/save-changes', async (req, reply) => {
  const productId = Number(req.params.productId);
  try {
    const { existing, savedData } = getExistingListing(productId);
    if (!existing) { flash(reply, 'error', 'No existing listing found'); return reply.redirect(`/products/${productId}/preview`); }

    let listingData: ListingData | null = null;
    const odoo = getOdoo();
    if (odoo) {
      try {
        const [product] = await odoo.read<OdooProduct>('product.product', [productId], [...DEFAULT_PRODUCT_FIELDS] as any);
        if (product) {
          const images = await getProductImages(odoo, productId);
          listingData = mergeSavedListingData(productToListing(product, images), savedData);
          listingData = finalizeListingData(listingData);
        }
      } catch (err) {
        console.warn(`save-changes: Odoo fetch failed for product ${productId}:`, err);
      }
    }

    if (!listingData) {
      listingData = listingDataFromSavedOnly(existing, savedData);
      flash(reply, 'warning', 'Odoo unavailable; saved changes using existing listing data');
    }

    const ebayConfig = loadEbayAppConfig();
    const categoryId = String((req.body as Record<string, string>).category_id ?? listingData.category_id ?? EBAY_CATEGORY_LAPTOP);
    const categoryOptions = await getCategorySpecificOptions(categoryId);
    listingData = applyListingFormOverrides(
      listingData, req.body as Record<string, string>,
      categoryOptions, ebayConfig.default_condition_description,
    );

    const warnings = listingQualityWarnings(listingData);
    for (const w of warnings) flash(reply, 'warning', `Listing quality: ${w}`);

    updateListingFields(db, existing.id, {
      listing_data: JSON.stringify(listingData),
      title: listingData.title,
      price: listingData.price,
    });

    flash(reply, 'info', 'Changes saved');
  } catch (err) {
    flash(reply, 'error', `Error saving: ${(err as Error).message}`);
  }

  return reply.redirect(`/products/${productId}/preview`);
});

// ── Routes: Revise eBay ─────────────────────────────────────────────

app.post<{ Params: { productId: string } }>('/products/:productId/revise-ebay', async (req, reply) => {
  const productId = Number(req.params.productId);
  const apiKey = loadUploadApiKey();
  if (!apiKey) { flash(reply, 'error', 'Upload API key not configured'); return reply.redirect(`/products/${productId}/preview`); }

  try {
    const { existing, savedData } = getExistingListing(productId);
    if (!existing) { flash(reply, 'error', 'No existing listing found'); return reply.redirect(`/products/${productId}/preview`); }
    if (existing.status !== 'uploaded' || !existing.ebay_item_id) {
      flash(reply, 'error', 'Listing is not live on eBay');
      return reply.redirect(`/products/${productId}/preview`);
    }

    let listingData: ListingData | null = null;
    const odoo = getOdoo();
    if (odoo) {
      try {
        const [product] = await odoo.read<OdooProduct>('product.product', [productId], [...DEFAULT_PRODUCT_FIELDS] as any);
        if (product) {
          const images = await getProductImages(odoo, productId);
          listingData = mergeSavedListingData(productToListing(product, images), savedData);
          listingData = finalizeListingData(listingData);
        }
      } catch (err) {
        console.warn(`revise-ebay: Odoo fetch failed for product ${productId}:`, err);
      }
    }

    if (!listingData) {
      listingData = listingDataFromSavedOnly(existing, savedData);
      flash(reply, 'warning', 'Odoo unavailable; revising using existing listing data');
    }

    const ebayConfig = loadEbayAppConfig();
    const categoryId = String((req.body as Record<string, string>).category_id ?? listingData.category_id ?? EBAY_CATEGORY_LAPTOP);
    const categoryOptions = await getCategorySpecificOptions(categoryId);
    listingData = applyListingFormOverrides(
      listingData, req.body as Record<string, string>,
      categoryOptions, ebayConfig.default_condition_description,
    );

    const warnings = listingQualityWarnings(listingData);
    for (const w of warnings) flash(reply, 'warning', `Listing quality: ${w}`);

    updateListingFields(db, existing.id, {
      listing_data: JSON.stringify(listingData),
      title: listingData.title,
      price: listingData.price,
    });

    const revisePayload = {
      title: listingData.title,
      description_html: listingData.description_html,
      price: listingData.price,
    };
    const idempotencyKey = buildIdempotencyKey('revise', existing.id, JSON.stringify(revisePayload));
    const result = await callUploadApi(`/api/revise/${existing.id}`, {
      payload: revisePayload, timeout: 60, retries: 1, retryOn5xx: true, idempotencyKey,
    });

    if (!result.ok) {
      flash(reply, 'error', formatUploadApiError(result, 'Revise'));
      return reply.redirect(`/products/${productId}/preview`);
    }

    const data = result.data as UploadResponseData;
    if (data.status === 'success') {
      const revised = data.revised_fields ?? [];
      flash(reply, 'success', `✅ eBay listing revised! Updated: ${revised.join(', ')}`);
    } else {
      flash(reply, 'error', `Revise failed: ${data.error ?? 'Unknown error'}`);
    }
  } catch (err) {
    flash(reply, 'error', `Revise error: ${(err as Error).message}`);
  }

  return reply.redirect(`/products/${productId}/preview`);
});

// ── Routes: Queue ───────────────────────────────────────────────────

app.get<{ Querystring: { status?: string } }>('/queue', async (req, reply) => {
  const statusFilter = req.query.status ?? 'approved';
  const listings = getListingsByStatus(db, statusFilter);
  const statusCounts = getStatusCounts(db);

  reply.type('text/html');
  return render(req, reply, 'queue', {
    listings, statusFilter, statusCounts, activeNav: 'queue',
  });
});

// ── Routes: Verify Listing ──────────────────────────────────────────

app.post<{ Params: { listingId: string } }>('/listing/:listingId/verify', async (req, reply) => {
  const listingId = Number(req.params.listingId);
  const apiKey = loadUploadApiKey();
  if (!apiKey) { flash(reply, 'error', 'Upload API key not configured'); return reply.redirect('/queue'); }

  try {
    const result = await callUploadApi(`/api/verify/${listingId}`, {
      timeout: 120, retries: 1, retryOn5xx: true,
    });

    if (!result.ok) {
      flash(reply, 'error', formatUploadApiError(result, 'Verify'));
      return reply.redirect('/queue');
    }

    const data = result.data!;
    if (data.status === 'success') {
      const fees = extractNonzeroFees((data.fees as unknown[]) ?? []);
      if (fees.length > 0) {
        const feeParts = fees.map(f => `${f.name}: $${f.amount.toFixed(2)}`);
        flash(reply, 'success', `eBay validation passed. Fees: ${feeParts.join(', ')}`);
      } else {
        flash(reply, 'success', 'eBay validation passed (no fees).');
      }
      const warnings = (data.warnings as Array<{ code: string; message: string }>) ?? [];
      for (const w of warnings) {
        flash(reply, 'warning', `eBay warning [${w.code}]: ${w.message}`);
      }
    } else {
      flash(reply, 'error', `eBay validation failed: ${data.error ?? 'Unknown error'}`);
    }
  } catch (err) {
    flash(reply, 'error', `Verify error: ${(err as Error).message}`);
  }

  return reply.redirect('/queue');
});

// ── Routes: Upload Listing ──────────────────────────────────────────

app.post<{ Params: { listingId: string } }>('/listing/:listingId/upload', async (req, reply) => {
  const listingId = Number(req.params.listingId);
  const apiKey = loadUploadApiKey();
  if (!apiKey) { flash(reply, 'error', 'Upload API key not configured'); return reply.redirect('/queue'); }

  try {
    const listing = getListingById(db, listingId);
    const fingerprint = listing?.listing_data ?? String(listingId);
    const idempotencyKey = buildIdempotencyKey('upload', listingId, fingerprint);

    const result = await callUploadApi(`/api/upload/${listingId}`, {
      timeout: 180, retries: 0, retryOn5xx: false, idempotencyKey,
    });

    if (!result.ok) {
      flash(reply, 'error', formatUploadApiError(result, 'Upload'));
      return reply.redirect('/queue');
    }

    const data = result.data as UploadResponseData;
    if (data.status === 'success') {
      const ebayItemId = data.ebay_item_id;
      if (!ebayItemId) {
        updateListingFields(db, listingId, {
          status: 'failed',
          error_message: 'Upload reported success but returned no eBay item ID',
        });
        flash(reply, 'error', 'Upload API reported success but did not return an eBay item ID. Check upload-api logs.');
        return reply.redirect('/queue');
      }
      updateListingFields(db, listingId, {
        status: 'uploaded',
        ebay_item_id: ebayItemId,
        uploaded_at: new Date().toISOString(),
      });
      flash(reply, 'success', `✅ Listed on eBay! Item ID: ${ebayItemId}`);

      const fees = extractNonzeroFees(data.fees ?? []);
      if (fees.length > 0) {
        flash(reply, 'info', `Fees: ${fees.map(f => `${f.name}: $${f.amount.toFixed(2)}`).join(', ')}`);
      }
      const warnings = data.warnings ?? [];
      for (const w of warnings) flash(reply, 'warning', `eBay warning [${w.code}]: ${w.message}`);
    } else {
      const errorMsg = String(data.error ?? 'Unknown error').slice(0, 500);
      updateListingFields(db, listingId, { status: 'failed', error_message: errorMsg });
      flash(reply, 'error', `Upload failed: ${errorMsg}`);
    }
  } catch (err) {
    flash(reply, 'error', `Upload error: ${(err as Error).message}`);
  }

  return reply.redirect('/queue');
});

// ── Routes: Settings ────────────────────────────────────────────────

app.get('/settings', async (req, reply) => {
  const config = loadAiConfig();
  const ebayConfig = loadEbayAppConfig();
  const apiKey = config.openai_api_key ?? '';
  const apiKeyMasked = apiKey.length > 12
    ? apiKey.slice(0, 8) + '...' + apiKey.slice(-4)
    : (apiKey ? '***' : 'Not configured');

  reply.type('text/html');
  return render(req, reply, 'settings', {
    config, ebayConfig, apiKeyMasked, isConfigured: !!apiKey,
    activeNav: 'settings',
  });
});

app.post('/settings/save', async (req, reply) => {
  const form = req.body as Record<string, string>;
  const config = loadAiConfig();

  if (form.openai_api_key) config.openai_api_key = form.openai_api_key;
  config.model = form.model ?? 'gpt-4o-mini';
  config.condition_notes = form.condition_notes ?? config.condition_notes;
  config.shipping_info = form.shipping_info ?? config.shipping_info;
  config.returns_policy = form.returns_policy ?? config.returns_policy;
  config.use_structured_output = 'use_structured_output' in form;
  if (form.title_system_prompt) config.title_system_prompt = form.title_system_prompt;
  if (form.description_system_prompt) config.description_system_prompt = form.description_system_prompt;

  saveAiConfig(config);

  const ebayConfig = loadEbayAppConfig();
  if (form.postal_code) ebayConfig.postal_code = form.postal_code;
  if (form.location) ebayConfig.location = form.location;
  ebayConfig.default_condition_description = form.default_condition_description ?? ebayConfig.default_condition_description ?? '';
  if (!ebayConfig.business_policies) ebayConfig.business_policies = {};
  ebayConfig.business_policies.payment_policy_id = form.payment_policy_id ?? '';
  ebayConfig.business_policies.return_policy_id = form.return_policy_id ?? '';
  ebayConfig.business_policies.shipping_policy_id = form.shipping_policy_id ?? '';
  saveEbayAppConfig(ebayConfig);

  flash(reply, 'success', 'Settings saved successfully!');
  return reply.redirect('/settings');
});

// ── Routes: AI API ──────────────────────────────────────────────────

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

// ── Category Context Builder ─────────────────────────────────────────

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


// ── Routes: Category API ────────────────────────────────────────────

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

// ── Start ───────────────────────────────────────────────────────────

const address = await app.listen({ port: PORT, host: HOST });
console.log(`\n📦 Listing Processor listening on ${address}`);
