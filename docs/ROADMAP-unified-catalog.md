# Roadmap: Unified Catalog Contract

> Bridging `intake-station` and `listing-dashboard` with a shared product contract.
>
> Created: 2026-03-10
> Status: **Phases 1-2 complete. Phase 3+ pending.**

---

## Problem Statement

Two systems handle different phases of the same pipeline:

```
Photos → [intake-station] → Enriched Product → [listing-dashboard] → eBay Listing
```

But they don't share a contract. intake-station writes `x_ebay_category_id` and
`x_ebay_item_specifics` to Odoo; listing-dashboard ignores both and hardcodes
category `177` (Laptops) and condition `3000` (Used). Each project defines its own
eBay taxonomy types, its own Odoo field lists, and its own normalization logic.

The result: work done in intake is discarded by listing-dashboard, the system only
works for laptops, and extending to new product categories requires changes in
multiple places with no compile-time safety net.

## Design Decisions (Agreed)

1. **Photos are the source of truth.** Everything else (specs, category, condition,
   title, description) is derived from photos via AI analysis and eBay Taxonomy API.

2. **Odoo is a storage layer, not the schema authority.** The shared contract defines
   the shape; Odoo is where it's persisted. If Odoo were replaced, the contract
   would not change.

3. **Two-layer product model:**
   - **Universal fields** — same for every item regardless of category (photos, SKU,
     brand, title, description, category ID, condition, price, cost)
   - **Dynamic item specifics** — an array of `{ name, value }` pairs where valid
     names/values are determined at runtime by eBay's Taxonomy API for the resolved
     category. Not a fixed struct.

4. **intake-station is the source of truth for enrichment** (category resolution,
   aspect discovery, aspect filling). listing-dashboard is the source of truth for
   **review and upload** (human approval, final edits, eBay API interaction).

5. **Incremental migration.** listing-dashboard's existing hardcoded laptop logic
   remains as a fallback. New items enriched by intake-station get the dynamic path.
   The hardcoded path is removed only once the dynamic path is proven reliable.

## The Shared Contract: `@ld/catalog`

A new workspace package at `lib/catalog/` containing **only** types, constants, and
field definitions. No business logic, no API calls, no runtime dependencies.

**Status:** Package created, builds cleanly, wired into all consumers. Located at `lib/catalog/`.

### What's In It

```
lib/catalog/src/
  product.ts        — EnrichedProduct, ItemSpecific, SpecificSource, EbayConditionId
  odoo-fields.ts    — canonical Odoo field name lists (enrichment + listing lifecycle)
  index.ts          — re-exports
```

See `lib/catalog/src/product.ts` and `lib/catalog/src/odoo-fields.ts` for the
actual type definitions. The key types are summarized here for reference.

### Core Types Summary

- **`EnrichedProduct`** — universal fields every item needs (sku, brand, title,
  description_html, ebay_category_id, condition_id, price, item_specifics array,
  enrichment_completeness)
- **`ItemSpecific`** — `{ name, value, source? }` where `value` is `string | string[]`
  and `source` tracks provenance (system_script / ai_vision / ai_research / manual / odoo_field)
- **`EbayConditionId`** — union of valid eBay condition IDs (1000, 2000, 2500, 3000, 7000)
- **`CONDITION_LABEL_TO_ID`** — maps intake-station's condition labels
  (new/like_new/good/fair/parts) to eBay numeric IDs

---

## Existing Code: What Lives Where

Understanding what already exists is critical to avoiding reimplementation and
knowing exactly what to port, merge, or delete.

### Duplicated Across Both Projects

| Concept | intake-station | listing-dashboard | Resolution |
|---------|---------------|-------------------|------------|
| **TaxonomyAspect type** | `src/ebay-taxonomy.ts:47-55` | `lib/ebay/src/taxonomy.ts:21-29` | Move to `@ld/catalog` or keep in `lib/ebay` (both are identical) |
| **CategorySuggestion type** | `src/ebay-taxonomy.ts:40-45` | `lib/ebay/src/taxonomy.ts:9-14` | Same — identical definitions |
| **EbayTaxonomyClient** | `src/ebay-taxonomy.ts:67-161` | `lib/ebay/src/taxonomy.ts:47-198` | listing-dashboard's version is more robust (has timeouts). intake-station should import `@ld/ebay-client` |
| **eBay OAuth token cache** | `src/ebay-taxonomy.ts:59` | `lib/ebay/src/taxonomy.ts:39` | Comes with the client consolidation |
| **Condition ID constants** | Implicit in `x_condition` values | `field-mapper.ts:14-17` (magic numbers) | `@ld/catalog` EBAY_CONDITIONS + CONDITION_LABEL_TO_ID |
| **ItemSpecific type** | N/A (uses `Record<string,string>`) | Both `normalizer.ts:228-231` AND `lib/ebay/src/types.ts:48-51` | `@ld/catalog` ItemSpecific (already created) |

### intake-station Has, listing-dashboard Needs

| Capability | intake-station location | What listing-dashboard should do |
|------------|------------------------|----------------------------------|
| **Dynamic category resolution** | `enricher.ts:62-128` — keyword scoring + phrase expansion against Taxonomy API suggestions | Read `x_ebay_category_id` from Odoo instead of hardcoding `177` |
| **Aspect discovery per category** | `enricher.ts:132-142` — fetches required/recommended aspects with 24h cache | Already has this in `lib/ebay/src/taxonomy.ts` but doesn't use it for field mapping |
| **AI aspect filling** | `enricher.ts:146-239` — builds constrained prompt, calls OpenAI, validates against SELECTION_ONLY lists | Read `x_ebay_item_specifics` from Odoo instead of the rigid `field-mapper.ts` |
| **Fuzzy value matching** | `enricher.ts:243-277` — 5-tier matching (exact → normalized → containment → word-overlap ≥60%) | listing-dashboard has `value-matcher.ts` for laptops only; intake-station's is category-agnostic |
| **Enrichment completeness tracking** | `enricher.ts:391-404` — counts required/recommended filled vs total | listing-dashboard has quality warnings but no structured completeness data |
| **Odoo chatter notes** | `enricher.ts:336-369` — posts HTML enrichment summary to product record | Not needed in listing-dashboard |

### listing-dashboard Has, Should Keep

| Capability | Location | Notes |
|------------|----------|-------|
| **Review UI** | `listing-processor/` templates + routes | Core value — human approval before eBay upload |
| **eBay Trading API** (AddItem, ReviseItem, image upload) | `lib/ebay/src/client.ts` | intake-station doesn't need this |
| **SQLite listing lifecycle** | `listing-processor/src/db.ts`, `upload-api/src/db.ts` | draft → approved → uploading → uploaded/failed |
| **AI title/description generation** | `listing-processor/src/ai-generator.ts` | Uses gpt-4o-mini structured output; keep this |
| **Upload API** with idempotency | `upload-api/` | Stateless eBay upload service; keep as-is |
| **Business policies** (shipping, returns) | `lib/ebay/src/client.ts` XML builder | Currently hardcoded per listing; keep |

### listing-dashboard Has, Should Eventually Remove

| Capability | Location | Why |
|------------|----------|-----|
| **Hardcoded category 177** | `field-mapper.ts:12`, `lib/ebay/src/client.ts:203` | Replaced by dynamic `x_ebay_category_id` |
| **Hardcoded condition 3000** | `field-mapper.ts:14`, `lib/ebay/src/client.ts:205` | Replaced by `CONDITION_LABEL_TO_ID` mapping |
| **Laptop-specific field mapper** | `field-mapper.ts:111-173` — maps 20 Odoo fields to laptop-specific eBay aspects | Replaced by dynamic `x_ebay_item_specifics` |
| **Laptop-specific value maps** | `field-mapper.ts:19-42` — RAM_DISPLAY, STORAGE_TYPE_DISPLAY, etc. | Only needed for laptop fallback path |
| **EBAY_177_ALLOWED_SPECIFICS** | `normalizer.ts` — hardcoded allowed values for category 177 | Replaced by Taxonomy API dynamic lookup |
| **Laptop-specific title builder** | `field-mapper.ts:64-107` — Brand+Model+CPU+RAM+Storage+Screen template | AI-generated titles from intake-station or listing-processor's ai-generator |
| **Laptop-specific description builder** | `field-mapper.ts:177-224` — hardcoded HTML table template | AI-generated descriptions |

### intake-station's Enrichment Blob (x_ebay_item_specifics)

This is the JSON structure intake-station currently writes to Odoo. listing-dashboard
Phase 2 must parse this format:

```json
{
  "category": {
    "id": "177",
    "name": "Laptops & Netbooks",
    "breadcrumb": ["Computers/Tablets & Networking", "Laptops & Netbooks"]
  },
  "specifics": {
    "Brand": "Dell",
    "Processor": "Intel Core i7-1165G7",
    "RAM Size": "16 GB",
    "SSD Capacity": "512 GB",
    "Screen Size": "14 in",
    "Operating System": "None",
    "GPU": "Intel Iris Xe Graphics",
    "Color": "Black"
  },
  "requiredUnfilled": ["MPN"],
  "completeness": {
    "required": { "filled": 5, "total": 6 },
    "recommended": { "filled": 8, "total": 14 }
  },
  "enrichedAt": "2026-03-10T00:00:00.000Z"
}
```

Key notes:
- `specifics` is `Record<string, string>` — flat key-value, no multi-value yet
- Values have already been fuzzy-matched against eBay's SELECTION_ONLY lists
- `requiredUnfilled` lists aspect names eBay requires but AI couldn't confidently fill
- `completeness` gives a quick health check without re-counting

---

## Implementation Phases

### Phase 1: Wire `@ld/catalog` into listing-dashboard (no behavior change)

**Goal:** Replace duplicate type definitions with imports from `@ld/catalog`.
No behavior changes — pure refactor.

**Status:** Complete. PR #47 reviewed and merged.

**Tasks:**
- [x] Add `"@ld/catalog": "workspace:*"` to `packages/listing-processor/package.json`
- [x] Add `"@ld/catalog": "workspace:*"` to `packages/upload-api/package.json`
- [x] Add `"@ld/catalog": "workspace:*"` to `lib/ebay/package.json`
- [x] In `lib/ebay/src/types.ts`: re-export `ItemSpecific` from `@ld/catalog`,
      add `LegacyItemSpecific` interface preserving `{ Name, Value }` shape
- [x] In `packages/listing-processor/src/normalizer.ts`: re-export catalog's
      `ItemSpecific`, rename local interface to `LegacyItemSpecific`
- [x] In `packages/listing-processor/src/field-mapper.ts`: replace magic number
      condition constants with `String(EBAY_CONDITIONS.*)` from `@ld/catalog`
- [x] In `lib/ebay/src/client.ts`: replace hardcoded `'3000'` fallback with
      `EBAY_CONDITIONS.used`
- [x] Verify `pnpm build` passes with zero type errors
- [x] PR #47 created and reviewed

**Quality gate:** `pnpm build` passes. No runtime behavior changes. Grep for
remaining magic numbers `1000`, `2000`, `2500`, `3000`, `7000` in non-template
TypeScript files — they should reference `EBAY_CONDITIONS` or `CONDITION_LABEL_TO_ID`.

**Risk:** None. Pure refactor.

**Note on ItemSpecific shape:** The current `ItemSpecific` in listing-dashboard uses
`{ Name: string; Value: string }` (capital N/V, single value only). The catalog
defines `{ name: string; value: string | string[]; source?: SpecificSource }`.
Phase 1 should keep the existing shape and add an adapter/alias — the migration to
lowercase + multi-value happens in Phase 2 when the enrichment data flows in.

### Phase 2: listing-dashboard reads intake-station's enrichment

**Goal:** When a product has been enriched by intake-station (`x_ebay_category_id`
and `x_ebay_item_specifics` are populated in Odoo), listing-dashboard uses that
enrichment instead of hardcoded defaults. Falls back to existing logic for
un-enriched products.

**Status:** Complete. PR #48 reviewed and merged.

**Tasks:**
- [x] Add `x_ebay_category_id` (string) and `x_ebay_item_specifics` (string/JSON)
      to `lib/odoo/src/schema.ts` field list and `OdooProduct` type
- [x] `parseEnrichmentBlob()` already implemented in `@ld/catalog` (Phase 1)
- [x] In `field-mapper.ts` / `productToListing()`:
  - `product.x_ebay_category_id || EBAY_CATEGORY_LAPTOP` — uses enrichment category or falls back
- [x] In `field-mapper.ts` / `buildEnrichedItemSpecifics()`:
  - Calls `parseEnrichmentBlob()`, converts `Record<string, string>` to `LegacyItemSpecific[]`
  - Falls back to `buildItemSpecifics()` via `??` operator when enrichment is null
- [x] In `field-mapper.ts` / condition assignment:
  - Checks `product.x_condition`, maps via `CONDITION_LABEL_TO_ID`, falls back to `EBAY_CONDITION_USED`
- [x] Updated preview template with "Enrichment" panel:
  - Category name + breadcrumb, completeness indicator, requiredUnfilled list, enrichedAt timestamp
  - "Not enriched" fallback message for un-enriched products
- [x] Verify `pnpm build` passes
- [x] PR #48 created and reviewed

**Quality gate:**
- A product WITH `x_ebay_category_id` set in Odoo uses that category (not 177)
- A product WITHOUT `x_ebay_category_id` still uses 177 (no regression)
- A product with malformed `x_ebay_item_specifics` JSON falls back gracefully
  (no crash, uses hardcoded mapper, logs a warning)
- The preview UI visually distinguishes enriched vs un-enriched listings

**Risk:** Low. Every code path has a fallback to existing behavior.

### Phase 3: intake-station imports `@ld/catalog`

**Goal:** intake-station uses shared types and the shared eBay taxonomy client
instead of its own local copies. Eliminates the duplicate implementations.

**Tasks:**
- [ ] Add `@ld/catalog` as dependency in intake-station:
      `"@ld/catalog": "file:../listing-dashboard/lib/catalog"`
- [ ] Evaluate also depending on `@ld/ebay-client` for the `EbayTaxonomyClient`:
  - listing-dashboard's version (lib/ebay/src/taxonomy.ts) has timeouts (30s),
    proper error types (`EbayApiError`, `EbayAuthError`), and accepts config
    via constructor instead of reading files directly
  - intake-station's version (src/ebay-taxonomy.ts) lacks timeouts and hardcodes
    config file loading
  - **Decision needed:** Import `@ld/ebay-client`'s taxonomy client, or keep
    separate? Importing it means intake-station depends on the full ebay lib
    (which includes Trading API code it doesn't need). Could extract taxonomy
    into its own package, but that's more packages to maintain.
- [ ] Replace local `EnrichmentResult` (enricher.ts:29-42) with a type that
      extends or maps to `EnrichedProduct` from catalog
- [ ] Replace local `TaxonomyAspect` (ebay-taxonomy.ts:47-55) with import from
      `@ld/ebay-client` or `@ld/catalog` (identical shape)
- [ ] Ensure the `x_ebay_item_specifics` blob written to Odoo (enricher.ts:315-326)
      conforms to the shape that Phase 2's parser expects
- [ ] Run intake-station's enrichment on 5+ real products across different categories
      and verify the blob parses correctly in listing-dashboard

**Quality gate:**
- intake-station builds with `@ld/catalog` types
- Enriching a product in intake-station → opening it in listing-dashboard's
  review UI shows the correct category, specifics, and condition
- No duplicate type definitions remain across both repos (grep for
  `interface TaxonomyAspect`, `interface CategorySuggestion`, etc.)

**Risk:** Low. intake-station's output format already matches the contract closely.
The main work is replacing imports and updating the enrichment blob structure.

### Phase 4: Remove hardcoded laptop logic

**Goal:** listing-dashboard no longer hardcodes category `177` or laptop-specific
field mappings. All products go through the dynamic enrichment path.

**Prerequisite:** At least 20 products across 3+ different eBay categories have been
successfully enriched by intake-station and uploaded via listing-dashboard without
manual category/specifics corrections.

**Tasks:**
- [ ] Remove `EBAY_CATEGORY_LAPTOP` constant (`field-mapper.ts:12`)
- [ ] Remove `EBAY_CONDITION_*` constants (`field-mapper.ts:14-17`) — use catalog
- [ ] Remove laptop-specific display maps (`field-mapper.ts:19-42`):
      `STORAGE_TYPE_DISPLAY`, `RAM_DISPLAY`, `GRAPHICS_TYPE_DISPLAY`, `LAPTOP_TYPE_DISPLAY`
- [ ] Remove `buildItemSpecifics()` function (`field-mapper.ts:111-173`) —
      replaced by dynamic specifics from enrichment blob
- [ ] Remove `buildTitle()` function (`field-mapper.ts:64-107`) —
      replaced by AI-generated title from intake or ai-generator.ts
- [ ] Remove `buildDescription()` function (`field-mapper.ts:177-224`) —
      replaced by AI-generated description
- [ ] Remove `EBAY_177_ALLOWED_SPECIFICS` and laptop-specific normalization
      in `normalizer.ts`
- [ ] `productToListing()` now requires enrichment data — error if
      `x_ebay_category_id` is missing (no silent fallback to 177)
- [ ] Update UI to make enrichment status visible in the products list
      (which products are enriched vs need intake processing)
- [ ] Remove `cleanProcessorString` from `value-matcher.ts` if no longer called
- [ ] Verify `pnpm build` passes

**Quality gate:**
- `pnpm build` passes
- No references to category `177` remain in TypeScript source (templates OK
  if used as a display label)
- No hardcoded eBay aspect names (e.g. "Hard Drive Capacity", "RAM Size") remain
  in `field-mapper.ts` — all specifics come from the enrichment blob or Taxonomy API
- An un-enriched product shows a clear UI message directing the operator to
  run it through intake-station first, not a broken listing

**Risk:** Medium. This removes the safety net. Only do this after Phase 2+3 are
stable in production for at least a couple weeks.

### Phase 5 (Future): Extended capabilities

These are out of scope for the initial integration but the architecture supports them:

- **Lot bundling** — multiple `EnrichedProduct` items grouped into a single listing
- **Per-item shipping policies** — condition/category-driven policy selection
- **Pricing intelligence** — cost-based pricing suggestions, market data integration
- **Inventory sync** — Odoo `qty_available` → eBay quantity, multi-channel awareness
- **Re-enrichment** — re-run intake on existing products with updated photos
- **Title/description quality scoring** — AI-driven quality checks before upload
- **Shared taxonomy client** — extract `EbayTaxonomyClient` into its own package
  so both repos can depend on a lightweight client without pulling in Trading API code

---

## Architecture After Integration

```
┌─────────────────────┐     ┌──────────────────────┐
│   intake-station    │     │  listing-dashboard    │
│                     │     │                       │
│  Photos → AI vision │     │  Review UI (5050)     │
│  → Category resolve │     │  Upload API (5051)    │
│  → Aspect discover  │     │  → eBay Trading API   │
│  → AI aspect fill   │     │  → eBay picture svc   │
│  → Fuzzy validate   │     │  AI title/desc gen    │
│  → Store to Odoo    │     │  Listing lifecycle    │
└────────┬────────────┘     └───────────┬───────────┘
         │                              │
         │    ┌────────────────┐        │
         └───►│  @ld/catalog   │◄───────┘
              │                │
              │  Types only:   │
              │  EnrichedProduct│
              │  ItemSpecific  │
              │  Conditions    │
              │  Odoo fields   │
              │  Blob parser   │
              └───────┬────────┘
                      │
              ┌───────▼────────┐
              │     Odoo       │
              │  (storage only)│
              │                │
              │  Key fields:   │
              │  x_ebay_category_id     │
              │  x_ebay_item_specifics  │
              │  x_condition            │
              │  attachments (photos)   │
              └────────────────┘
```

## Principles

1. **The contract is declarative.** Types and constants only. No logic to break.
   The one exception is the blob parser, which is a pure function (JSON in, typed
   object out, no side effects).
2. **Build for what intake-station can produce today.** Don't design for hypothetical
   categories until real items flow through.
3. **Fallback everywhere.** Every new capability has a fallback to existing behavior.
   Nothing breaks if intake-station hasn't enriched a product yet.
4. **One PR per phase.** Each phase is independently mergeable and deployable.
5. **Photos are upstream of everything.** If the data is wrong, re-photograph and
   re-enrich. Don't patch bad data downstream.
6. **Quality gates are mandatory.** Each phase defines pass/fail criteria. Do not
   proceed to the next phase until the current phase's gates are green.
