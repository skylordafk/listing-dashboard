// Dashboard route.

import type { FastifyInstance } from 'fastify';
import { getDb } from '../db.js';
import { getStatusCounts } from '../db.js';
import { getOdoo } from '../helpers/odoo.js';
import { render } from '../helpers/render.js';

export default async function (app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const db = getDb();
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
}
