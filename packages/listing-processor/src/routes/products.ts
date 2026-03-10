// Product routes: list, preview, approve, reject, edit, save-changes, revise-ebay.

import type { FastifyInstance } from 'fastify';
import type { OdooProduct, OdooImage } from '@ld/odoo-sdk';
import { DEFAULT_PRODUCT_FIELDS } from '@ld/odoo-sdk';
import { parseEnrichmentBlob } from '@ld/catalog';
import {
  getDb, getListingProductIds, updateListingFields,
  upsertListing,
} from '../db.js';
import {
  finalizeListingData, listingQualityWarnings, applyListingFormOverrides,
  EBAY_177_ALLOWED_SPECIFICS, type ListingData,
} from '../normalizer.js';
import { productToListing, EBAY_CATEGORY_LAPTOP } from '../field-mapper.js';
import {
  callUploadApi, buildIdempotencyKey, extractNonzeroFees, formatUploadApiError,
  type UploadResponseData,
} from '../upload-client.js';
import { loadEbayAppConfig, loadUploadApiKey } from '../config.js';
import { flash } from '../helpers/flash.js';
import { render } from '../helpers/render.js';
import { getOdoo, getProductImages, getProductImageCounts } from '../helpers/odoo.js';
import {
  getExistingListing, mergeSavedListingData, listingDataFromSavedOnly, sanitizeListingHtml,
} from '../helpers/listing.js';
import { getCategorySpecificOptions, getCategoryAspectMeta } from '../helpers/cache.js';

export default async function (app: FastifyInstance) {

  // ── Products List ──────────────────────────────────────────────────

  app.get<{ Querystring: { page?: string; per_page?: string; filter?: string; status?: string; photos?: string } }>(
    '/products',
    async (req, reply) => {
      const db = getDb();
      const LISTING_STATUSES = ['draft', 'approved', 'rejected', 'uploading', 'uploaded', 'failed'] as const;
      const PER_PAGE_OPTIONS = [50, 100, 200, 500];
      const listingFilterOptions = [
        ['all', 'All'], ['unlisted', 'Unlisted'],
        ...LISTING_STATUSES.map(s => [s, s.charAt(0).toUpperCase() + s.slice(1)]),
      ];

      const emptyState = (extra: Record<string, unknown> = {}) => ({
        products: [], error: extra.error ?? null,
        page: 1, totalPages: 0, total: 0, scanFilter: 'all', photoFilter: 'all',
        countAll: 0, countScanned: 0, countUnscanned: 0, currentScanTotal: 0,
        countWithPhotos: 0, countNoPhotos: 0,
        listedCount: 0, perPage: 100, perPageOptions: PER_PAGE_OPTIONS,
        listingFilter: 'all', listingFilterOptions,
        statusCounts: Object.fromEntries([...LISTING_STATUSES, 'unlisted'].map(s => [s, 0])),
        activeNav: 'products',
        ...extra,
      });

      const odoo = getOdoo();
      if (!odoo) {
        flash(reply, 'error', 'Cannot connect to Odoo');
        reply.type('text/html');
        return render(req, reply, 'products', emptyState({ error: 'Cannot connect to Odoo' }));
      }

      let page = Math.max(parseInt(req.query.page ?? '1', 10) || 1, 1);
      let perPage = parseInt(req.query.per_page ?? '100', 10) || 100;
      if (!PER_PAGE_OPTIONS.includes(perPage)) perPage = 100;
      const scanFilter = ['all', 'scanned', 'unscanned'].includes(req.query.filter ?? '') ? req.query.filter! : 'all';
      const validStatuses = new Set(['all', 'unlisted', ...LISTING_STATUSES]);
      const listingFilter = validStatuses.has(req.query.status ?? '') ? req.query.status! : 'all';
      const photoFilter = ['all', 'has_photos', 'no_photos'].includes(req.query.photos ?? '') ? req.query.photos! : 'all';

      try {
        const scanDomain = (f: string) => {
          if (f === 'scanned') return [['x_processor', '!=', false]] as Array<[string, string, unknown]>;
          if (f === 'unscanned') return [['x_processor', '=', false]] as Array<[string, string, unknown]>;
          return [] as Array<[string, string, unknown]>;
        };

        const MAX_PRODUCTS = 2000;
        const filteredScanTotal = await odoo.searchCount('product.product', scanDomain(scanFilter));
        const fetchLimit = Math.min(filteredScanTotal, MAX_PRODUCTS);
        const resultsCapped = filteredScanTotal > MAX_PRODUCTS;
        const allProducts: OdooProduct[] = [];
        const batchSize = 500;
        for (let offset = 0; offset < fetchLimit; offset += batchSize) {
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

        // Fetch image counts for ALL products (before filtering) to support photo filter
        let allImageCounts = new Map<number, number>();
        try {
          allImageCounts = await getProductImageCounts(odoo, productIds);
        } catch { /* ignore */ }

        const statusCounts: Record<string, number> = Object.fromEntries(
          [...LISTING_STATUSES, 'unlisted'].map(s => [s, 0])
        );

        const enriched = allProducts.map(p => {
          const listing = listingByProductId.get(p.id);
          const listingStatus = listing?.status ?? null;
          const listingId = listing?.id ?? null;
          const hasSpecs = !!p.x_processor;
          const hasEnrichment = !!p.x_ebay_category_id;
          const imageCount = allImageCounts.get(p.id) ?? 0;

          if (listingStatus && listingStatus in statusCounts) {
            statusCounts[listingStatus]!++;
          } else {
            statusCounts.unlisted!++;
          }

          return { ...p, listing_status: listingStatus, listing_id: listingId, has_specs: hasSpecs, has_enrichment: hasEnrichment, image_count: imageCount };
        });

        // Filter by listing status
        let filteredProducts = enriched;
        if (listingFilter === 'unlisted') {
          filteredProducts = enriched.filter(p => !p.listing_status);
        } else if (LISTING_STATUSES.includes(listingFilter as any)) {
          filteredProducts = enriched.filter(p => p.listing_status === listingFilter);
        }

        // Filter by photo status
        if (photoFilter === 'has_photos') {
          filteredProducts = filteredProducts.filter(p => p.image_count > 0);
        } else if (photoFilter === 'no_photos') {
          filteredProducts = filteredProducts.filter(p => p.image_count === 0);
        }

        // Photo counts (computed from the listing-filtered set, before photo filter)
        const listingFiltered = listingFilter === 'unlisted'
          ? enriched.filter(p => !p.listing_status)
          : LISTING_STATUSES.includes(listingFilter as any)
            ? enriched.filter(p => p.listing_status === listingFilter)
            : enriched;
        const countWithPhotos = listingFiltered.filter(p => p.image_count > 0).length;
        const countNoPhotos = listingFiltered.filter(p => p.image_count === 0).length;

        const total = filteredProducts.length;
        const totalPages = Math.ceil(total / perPage) || 0;
        if (totalPages > 0 && page > totalPages) page = totalPages;
        const offset = (page - 1) * perPage;
        const productList = filteredProducts.slice(offset, offset + perPage);

        let listedCount = 0;
        for (const p of productList) {
          if (p.listing_status === 'uploaded') listedCount++;
        }

        reply.type('text/html');
        return render(req, reply, 'products', {
          products: productList, page, totalPages, total,
          scanFilter, photoFilter, countAll, countScanned, countUnscanned,
          countWithPhotos, countNoPhotos,
          currentScanTotal: filteredScanTotal, listedCount,
          perPage, perPageOptions: PER_PAGE_OPTIONS,
          listingFilter, listingFilterOptions, statusCounts,
          activeNav: 'products',
          resultsCapped, cappedTotal: filteredScanTotal,
        });
      } catch (err) {
        flash(reply, 'error', `Odoo error: ${(err as Error).message}`);
        reply.type('text/html');
        return render(req, reply, 'products', emptyState({ error: (err as Error).message, scanFilter, photoFilter, perPage }));
      }
    },
  );

  // ── Preview ────────────────────────────────────────────────────────

  app.get<{ Params: { productId: string } }>('/products/:productId/preview', async (req, reply) => {
    const db = getDb();
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
      const { existing, savedData } = getExistingListing(db, productId);
      let listingData = mergeSavedListingData(productToListing(product, images), savedData);

      const ebayConfig = loadEbayAppConfig();
      const categoryId = String(listingData.category_id ?? EBAY_CATEGORY_LAPTOP);
      const aspectMeta = await getCategoryAspectMeta(categoryId);
      const specificOptions = aspectMeta.options;
      listingData = finalizeListingData(listingData, specificOptions, ebayConfig.default_condition_description, aspectMeta.multiValueNames);
      listingData = sanitizeListingHtml(listingData);
      const qualityWarnings = listingQualityWarnings(listingData);

      const allSpecificNames = new Set([...EBAY_177_ALLOWED_SPECIFICS, ...Object.keys(specificOptions)]);
      const sortedSpecificNames = [...allSpecificNames].sort();

      // Parse enrichment blob for template metadata display
      const enrichment = parseEnrichmentBlob(product.x_ebay_item_specifics);

      reply.type('text/html');
      return render(req, reply, 'preview', {
        product, listing: listingData, images, existing,
        qualityWarnings, ebaySpecificNames: sortedSpecificNames,
        ebaySpecificValueOptions: specificOptions,
        categoryId, enrichment,
        activeNav: 'products',
      });
    } catch (err) {
      flash(reply, 'error', `Error loading product: ${(err as Error).message}`);
      return reply.redirect('/products');
    }
  });

  // ── Approve ────────────────────────────────────────────────────────

  app.post<{ Params: { productId: string } }>('/products/:productId/approve', async (req, reply) => {
    const db = getDb();
    const productId = Number(req.params.productId);
    const odoo = getOdoo();
    if (!odoo) { flash(reply, 'error', 'Cannot connect to Odoo'); return reply.redirect('/products'); }

    try {
      const [product] = await odoo.read<OdooProduct>('product.product', [productId], [...DEFAULT_PRODUCT_FIELDS] as any);
      if (!product) { flash(reply, 'error', 'Product not found'); return reply.redirect('/products'); }

      const images = await getProductImages(odoo, productId);
      const { existing, savedData } = getExistingListing(db, productId);
      let listingData = mergeSavedListingData(productToListing(product, images), savedData);

      const ebayConfig = loadEbayAppConfig();
      const categoryId = String((req.body as Record<string, string>).category_id ?? listingData.category_id ?? EBAY_CATEGORY_LAPTOP);
      const approveMeta = await getCategoryAspectMeta(categoryId);
      listingData = applyListingFormOverrides(
        listingData, req.body as Record<string, string>,
        approveMeta.options, ebayConfig.default_condition_description, approveMeta.multiValueNames,
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

  // ── Reject ─────────────────────────────────────────────────────────

  app.post<{ Params: { productId: string } }>('/products/:productId/reject', async (req, reply) => {
    const db = getDb();
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

    const { existing } = getExistingListing(db, productId);
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

  // ── Edit (save draft) ──────────────────────────────────────────────

  app.post<{ Params: { productId: string } }>('/products/:productId/edit', async (req, reply) => {
    const db = getDb();
    const productId = Number(req.params.productId);
    const odoo = getOdoo();
    if (!odoo) { flash(reply, 'error', 'Cannot connect to Odoo'); return reply.redirect('/products'); }

    try {
      const [product] = await odoo.read<OdooProduct>('product.product', [productId], [...DEFAULT_PRODUCT_FIELDS] as any);
      if (!product) { flash(reply, 'error', 'Product not found'); return reply.redirect('/products'); }

      const images = await getProductImages(odoo, productId);
      const { existing, savedData } = getExistingListing(db, productId);
      let listingData = mergeSavedListingData(productToListing(product, images), savedData);
      const ebayConfig = loadEbayAppConfig();
      const categoryId = String((req.body as Record<string, string>).category_id ?? listingData.category_id ?? EBAY_CATEGORY_LAPTOP);
      const editMeta = await getCategoryAspectMeta(categoryId);
      listingData = finalizeListingData(listingData, undefined, ebayConfig.default_condition_description, editMeta.multiValueNames);

      listingData = applyListingFormOverrides(
        listingData, req.body as Record<string, string>,
        editMeta.options, ebayConfig.default_condition_description, editMeta.multiValueNames,
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

  // ── Save Changes (uploaded listings) ───────────────────────────────

  app.post<{ Params: { productId: string } }>('/products/:productId/save-changes', async (req, reply) => {
    const db = getDb();
    const productId = Number(req.params.productId);
    try {
      const { existing, savedData } = getExistingListing(db, productId);
      if (!existing) { flash(reply, 'error', 'No existing listing found'); return reply.redirect(`/products/${productId}/preview`); }

      let listingData: ListingData | null = null;
      const odoo = getOdoo();
      if (odoo) {
        try {
          const [product] = await odoo.read<OdooProduct>('product.product', [productId], [...DEFAULT_PRODUCT_FIELDS] as any);
          if (product) {
            const images = await getProductImages(odoo, productId);
            listingData = mergeSavedListingData(productToListing(product, images), savedData);
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
      const saveMeta = await getCategoryAspectMeta(categoryId);
      listingData = finalizeListingData(listingData, undefined, ebayConfig.default_condition_description, saveMeta.multiValueNames);
      listingData = applyListingFormOverrides(
        listingData, req.body as Record<string, string>,
        saveMeta.options, ebayConfig.default_condition_description, saveMeta.multiValueNames,
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

  // ── Revise eBay ────────────────────────────────────────────────────

  app.post<{ Params: { productId: string } }>('/products/:productId/revise-ebay', async (req, reply) => {
    const db = getDb();
    const productId = Number(req.params.productId);
    const apiKey = loadUploadApiKey();
    if (!apiKey) { flash(reply, 'error', 'Upload API key not configured'); return reply.redirect(`/products/${productId}/preview`); }

    try {
      const { existing, savedData } = getExistingListing(db, productId);
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
      const reviseMeta = await getCategoryAspectMeta(categoryId);
      listingData = finalizeListingData(listingData, undefined, ebayConfig.default_condition_description, reviseMeta.multiValueNames);
      listingData = applyListingFormOverrides(
        listingData, req.body as Record<string, string>,
        reviseMeta.options, ebayConfig.default_condition_description, reviseMeta.multiValueNames,
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
}
