<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Fastify-000000?style=for-the-badge&logo=fastify&logoColor=white" />
  <img src="https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white" />
  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/pnpm-F69220?style=for-the-badge&logo=pnpm&logoColor=white" />
  <img src="https://img.shields.io/badge/OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white" />
  <img src="https://img.shields.io/badge/eBay-E53238?style=for-the-badge&logo=ebay&logoColor=white" />
</p>

# listing-dashboard

Internal tooling for reviewing, enriching, and publishing product listings to eBay — powered by AI-generated titles and descriptions.

<p align="center">
  <img src="https://img.shields.io/github/commit-activity/m/skylordafk/listing-dashboard?style=flat-square&label=commits" />
  <img src="https://img.shields.io/github/last-commit/skylordafk/listing-dashboard?style=flat-square" />
  <img src="https://img.shields.io/github/issues/skylordafk/listing-dashboard?style=flat-square" />
  <img src="https://img.shields.io/github/issues-pr/skylordafk/listing-dashboard?style=flat-square" />
</p>

---

## Overview

A **pnpm monorepo** with two Fastify services and shared libraries that form a pipeline from Odoo product data to live eBay listings.

```
┌─────────────┐     ┌─────────────────────┐     ┌──────────────┐     ┌───────┐
│    Odoo      │────▶│  listing-processor  │────▶│  upload-api  │────▶│ eBay  │
│  (products)  │     │     :5050           │     │    :5051     │     │       │
└─────────────┘     └─────────────────────┘     └──────────────┘     └───────┘
                          │                           │
                          └───────── SQLite ───────────┘
```

| Package | Description |
|---|---|
| `packages/listing-processor` | Web UI — review, approve, and manage listings |
| `packages/upload-api` | REST API — upload approved listings to eBay |
| `lib/catalog` | Shared product types and enrichment blob parser |
| `lib/ebay` | eBay Trading API (XML) + Taxonomy API client |
| `lib/odoo` | Typed Odoo JSON-RPC client |
| `lib/db` | Shared SQLite database layer |

## Quick Start

```bash
pnpm install
pnpm build
```

## Activity

![Alt](https://repobeats.axiom.co/api/embed/2e74c8b059ca4796014a8cd9930fda8758fc128a.svg "Repobeats analytics image")

<p align="center">
  <img src="https://img.shields.io/github/contributors/skylordafk/listing-dashboard?style=flat-square" />
  <img src="https://img.shields.io/github/languages/top/skylordafk/listing-dashboard?style=flat-square" />
  <img src="https://img.shields.io/github/repo-size/skylordafk/listing-dashboard?style=flat-square" />
</p>
