import { getModelUpstreamId, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import {getImageQuotaState,getImageSupplierLoads} from '@/lib/db/repos/imageQuotaRepo.js';
import {resolveImageRouting,resolveImageAccountPreference,resolveImageSelection,validateImageRouting} from '@/shared/utils/imageRouting.mjs';
import {selectImageRotation} from '@/lib/db/repos/imageRoutingRepo.js';
import { getProviderConnections, getSettings } from '@/lib/localDb';
import { readRotationPolicy, saveRotationPolicy, readRotationSnapshots, chooseSequenceConnection, readCreditResetHolds } from '@/lib/db/repos/providerRotationRepo.js';
import { emptyRotation, rotationMetrics, validateRotation, legacyRotationNext, applicableRotationQuotas } from '@/shared/utils/rotationSequence.mjs';
import { rotationPreviewInfo, rotationStages, rotationMeasurements, quotaScopeSummary } from '@/shared/utils/rotationPreview.mjs';
import { rotationPool } from '@/sse/services/providerRotation.js';
import { refreshRotationSnapshots, startRotationSnapshotRefresh } from '@/shared/services/rotationSnapshotRefresh.js';
import { readTextModelPolicies } from '@/lib/db/repos/textModelPolicyRepo.js';
import { configuredQuotaModels } from '@/lib/quotaModelCatalog.js';
import { getCustomModels } from '@/lib/db/repos/aliasRepo.js';
import { canonicalTextModel } from '@/shared/utils/textModelPermission.mjs';
export const dynamic = 'force-dynamic';
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
async function providerId(params, imagePreview = false) {
  const { id } = await params;
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id) || !imagePreview && !rotationMetrics(id).length) throw new TypeError('Quota sequences are unavailable for this provider');
  return id;
}
async function inspect(provider, policy, model, draftImageRule = null) {
  if (typeof model !== 'string' || model.length > 256 || model && !/^[A-Za-z0-9._:/-]+$/.test(model)) throw new TypeError('Invalid model');
  const connections = await getProviderConnections({ provider });
  const snapshots = await readRotationSnapshots(connections);
  const now = Date.now();
  const cleanModel = canonicalTextModel(provider, model);
  const lockModel = getModelUpstreamId(PROVIDER_ID_TO_ALIAS[provider] || provider, cleanModel);
  const image = configuredQuotaModels([provider], await getCustomModels()).some(item => item.id === cleanModel && item.kind === 'image');
  const imageStates=image&&['codex','antigravity','gemini'].includes(provider)?await getImageQuotaState(connections,provider,'image_generation',lockModel):null;
  const settings = await getSettings(), override = settings.providerStrategies?.[provider] || {};
  if(draftImageRule&&!image)throw new TypeError('Choose a supported image model for image rotation preview');
  const imageRule=image?(draftImageRule||resolveImageRouting(settings,provider,lockModel,'generate')):null;
  if(image)policy=resolveImageAccountPreference(imageRule,policy,provider);
  const events = [];
  const textPolicies = image ? null : await readTextModelPolicies(connections);
  const resetHolds = provider === 'codex' && !image ? await readCreditResetHolds(connections) : [];
  const pool = rotationPool(connections, snapshots, policy, { resetHolds, provider, model, lockModel, now, imageStates, quotaAdmission: image, textPolicies, onStep: event => events.push(event) });
  const {strategy,stickyRequests} = resolveImageSelection(imageRule,override,settings);
  let next = policy.enabled && pool.hasEvidence ? strategy !== 'round-robin' ? pool.candidates[0] : await chooseSequenceConnection(pool.candidates, { provider, model, policy, stickyRequests, peekOnly: true }) : legacyRotationNext(pool.ranked.map(row => row.connection), strategy, stickyRequests);
  if(image){
    let candidates=policy.enabled&&pool.hasEvidence?pool.candidates:pool.ranked.map(row=>row.connection);
    if(imageStates&&strategy==='round-robin'&&candidates.length>1){const loads=await getImageSupplierLoads(candidates,provider),minimum=Math.min(...candidates.map(row=>loads.get(row.id)||0));candidates=candidates.filter(row=>(loads.get(row.id)||0)===minimum);}
    next=strategy==='round-robin'?await selectImageRotation(candidates,{provider,model:lockModel,operation:imageRule?.operation||'generate',stickyRequests,peekOnly:true}):legacyRotationNext(candidates,strategy,stickyRequests);
  }
  const label = connection => connection.name || connection.displayName || connection.email || connection.id.slice(0, 8);
  return {
    ...rotationPreviewInfo(pool, snapshots, policy, { provider, model, now }), stages: rotationStages(events, policy), model, sorts: policy.sorts, policyEnabled: policy.enabled, resetPriorityEnabled: policy.resetPriority.enabled, metrics: rotationMetrics(provider), observedAt: now, strategy, stickyRequests, total: connections.length, eligible: pool.ranked.length, staleCount: pool.staleCount, fallback: !policy.enabled || !pool.hasEvidence, nextId: next?.id || null,
    rows: [...pool.segments, ...(pool.waiting.length ? [{ rows: pool.waiting, boundaries: [], waiting: true }] : [])].flatMap((segment, index) => segment.rows.map(row => ({ id: row.connection.id, name: label(row.connection), segment: index + 1, waiting: Boolean(segment.waiting), reason: row.reason || null, priority: row.urgent, resetRequired: Boolean(row.urgent && policy.resetPriority.autoReset && applicableRotationQuotas(snapshots[row.connection.id], provider, model, now).some(q => q.remaining === 0)), expiry: row.urgent ? row.expiry : null, constraints: applicableRotationQuotas(snapshots[row.connection.id], provider, model, now), measurements: rotationMeasurements(snapshots[row.connection.id], provider, model, now), scope: quotaScopeSummary(snapshots[row.connection.id], provider, model, now), values: row.values, fresh: row.fresh, observedAt: snapshots[row.connection.id]?.observedAt || null, boundaries: segment.boundaries }))),
    admission: pool.admission || null,
    blocked: pool.blocked.map(row => ({ id: row.connection.id, name: label(row.connection), reason: row.reason, gate: row.gate || null })),
  };
}
function failure(error) { return reply({ error: error instanceof TypeError ? error.message : error.status ? error.message : 'Rotation request failed' }, error.status || (error instanceof TypeError ? 400 : 500)); }
export async function GET(request, { params }) {
  try {
    const provider = await providerId(params), current = await readRotationPolicy(provider);
    try { current.policy = validateRotation(current.policy, provider); }
    catch { current.policy = emptyRotation(); current.needsReview = true; }
    const query=new URL(request.url).searchParams,model=query.get('model')||'';
    if(model.length>256||model&&!/^[A-Za-z0-9._:/-]+$/.test(model))throw new TypeError('Invalid model');
    const clean=canonicalTextModel(provider,model),image=configuredQuotaModels([provider],await getCustomModels()).some(item=>item.id===clean&&item.kind==='image');
    const effectivePolicy=image?resolveImageAccountPreference(resolveImageRouting(await getSettings(),provider,getModelUpstreamId(PROVIDER_ID_TO_ALIAS[provider]||provider,clean),'generate'),current.policy,provider):current.policy;
    return reply({ ...current, effectivePolicy, sequenceScope:image?'image':'text', metrics: rotationMetrics(provider), preview: query.has('summary') ? null : await inspect(provider, current.policy, model) });
  } catch (error) { return failure(error); }
}
export async function POST(request, { params }) {
  try {
    const body = await request.json();
    if (!body || !['preview', 'refresh'].includes(body.action)) throw new TypeError('Invalid rotation action');
    const provider = await providerId(params, body.action === 'preview' && Boolean(body.imageRule));
    const policy = validateRotation(body.policy || emptyRotation(), provider);
    const model = body.model || '';
    if (typeof model !== 'string' || model.length > 256 || model && !/^[A-Za-z0-9._:/-]+$/.test(model)) throw new TypeError('Invalid model');
    const draftImageRule=body.imageRule?validateImageRouting({version:1,rules:[body.imageRule]}).rules[0]:null;
    if(draftImageRule&&(![provider,'*'].includes(draftImageRule.provider)||draftImageRule.model!=='*'&&draftImageRule.model!==getModelUpstreamId(PROVIDER_ID_TO_ALIAS[provider]||provider,canonicalTextModel(provider,model))))throw new TypeError('Image rule does not match preview scope');
    const refresh = body.action === 'refresh' ? await refreshRotationSnapshots(provider, policy.resetPriority.enabled) : null;
    return reply({ preview: await inspect(provider, policy, model, draftImageRule), errors: refresh?.errors || [] });
  } catch (error) { return failure(error); }
}
export async function PATCH(request, { params }) {
  try {
    const provider = await providerId(params), body = await request.json();
    if (typeof body.revision !== 'string') throw new TypeError('Expected rotation revision');
    const current = await saveRotationPolicy(provider, body.policy, body.revision);
    if (current.policy.enabled) startRotationSnapshotRefresh();
    return reply(current);
  } catch (error) { return failure(error); }
}
