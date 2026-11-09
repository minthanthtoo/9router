import { isAuthenticated } from '@/dashboardGuard';
import { getDashboardAuthSession } from '@/lib/auth/dashboardSession';
import { getProviderConnectionById } from '@/lib/localDb';
import { getModelsByProviderId } from 'open-sse/config/providerModels.js';
import { getCustomModels } from '@/lib/db/repos/aliasRepo';
import { PROVIDER_ID_TO_ALIAS } from 'open-sse/config/providerModels.js';
import { normalizeQuotaModel } from '@/shared/utils/quotaModelCatalog.mjs';
import { readModelActivity } from '@/lib/db/repos/modelActivityRepo';
export const dynamic = 'force-dynamic';
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request) {
  if (!await isAuthenticated(request) || !await getDashboardAuthSession(request.cookies?.get?.('auth_token')?.value)) return json({error:'dashboard_sign_in_required'},401);
  try {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => !['connectionId','model','period'].includes(key)) || [...query.keys()].some(key => query.getAll(key).length !== 1)) return json({error:'invalid_activity_scope'},400);
    const id = query.get('connectionId'), model = query.get('model'), period = query.get('period') || '24h';
    if (!id || id.length > 160 || !model || model.length > 256 || !['1h','24h','7d'].includes(period)) return json({error:'invalid_activity_scope'},400);
    const connection = await getProviderConnectionById(id);
    if (!connection) return json({error:'account_not_found'},404);
    const alias = PROVIDER_ID_TO_ALIAS[connection.provider] || connection.provider;
    const custom = (await getCustomModels()).filter(row => row.provider === connection.provider || [connection.provider,alias].includes(row.providerAlias));
    const supported = [...getModelsByProviderId(connection.provider),...custom].some(row => row.id === model && normalizeQuotaModel(connection.provider,row)?.kind === 'llm');
    if (!supported) return json({error:'unsupported_text_model'},400);
    return json(await readModelActivity(connection,model,period));
  } catch { return json({error:'activity_unavailable'},503); }
}
