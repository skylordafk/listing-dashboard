// Settings routes.

import type { FastifyInstance } from 'fastify';
import { loadAiConfig, saveAiConfig, loadEbayAppConfig, saveEbayAppConfig } from '../config.js';
import { flash } from '../helpers/flash.js';
import { render } from '../helpers/render.js';

export default async function (app: FastifyInstance) {

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
}
