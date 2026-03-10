import type { FastifyInstance } from 'fastify';

export default async function (app: FastifyInstance) {
  app.get('/health', async () => ({
    status: 'ok',
    version: '2.0',
    time: new Date().toISOString(),
  }));
}
