import { readTextModelPolicies } from '@/lib/db/repos/textModelPolicyRepo.js';
import { rotationPool } from "@/sse/services/providerRotation.js";
import { emptyRotation, validateRotation, evaluateRotation, applicableRotationQuotas, scopeMatches, RESET_GROUPS } from "@/shared/utils/rotationSequence.mjs";
import { readRotationPolicy, readRotationSnapshots, readCreditResetHolds } from "@/lib/db/repos/providerRotationRepo.js";
import { rotationPreviewInfo } from "@/shared/utils/rotationPreview.mjs";
import { NextResponse } from "next/server";
import {getImageQuotaState} from "@/lib/db/repos/imageQuotaRepo.js";
import {resolveImageRouting,resolveImageAccountPreference} from "@/shared/utils/imageRouting.mjs";
import { getProviderConnections, getSettings } from "@/lib/localDb";
import { configuredQuotaModels } from "@/lib/quotaModelCatalog.js";
import { canonicalTextModel } from "@/shared/utils/textModelPermission.mjs";
import { getModelUpstreamId, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { getCustomModels } from "@/lib/db/repos/aliasRepo.js";
import { accountMatchesQuotaModel, filterQuotaConnections, quotaCatalogCounts, QUOTA_MODEL_CATEGORIES, QUOTA_MODEL_ID } from "@/shared/utils/quotaModelCatalog.mjs";
import { backfillCodexEmails } from "@/lib/oauth/providers";
import { USAGE_APIKEY_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";

const SAFE_FIELDS = [
  "id", "provider", "authType", "name", "email", "displayName",
  "priority", "globalPriority", "isActive", "defaultModel",
  "testStatus", "lastError", "lastErrorAt", "errorCode",
  "expiresAt", "lastUsedAt", "consecutiveUseCount",
  "createdAt", "updatedAt",
];

const SAFE_PSD_FIELDS = [
  "baseUrl", "azureEndpoint", "deployment", "apiVersion", "accountId",
  "region", "projectId", "resourceUrl", "proxyPoolId",
  "connectionProxyEnabled", "connectionProxyUrl", "connectionNoProxy",
  "githubLogin", "githubName", "githubEmail", "githubUserId",
  "username", "firstName", "lastName", "authMethod", "authKind",
  "profileArn",
];

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 500;

function maskName(name) {
  if (typeof name !== "string" || name.length <= 16) return name;
  if (/[a-zA-Z0-9_-]{32,}/.test(name)) return `${name.slice(0, 8)}***`;
  return name;
}

function sanitize(c) {
  const safe = {};
  for (const f of SAFE_FIELDS) if (c[f] !== undefined) safe[f] = c[f];
  if (safe.name) safe.name = maskName(safe.name);
  if (c.providerSpecificData) {
    const psd = {};
    for (const f of SAFE_PSD_FIELDS) {
      if (c.providerSpecificData[f] !== undefined) psd[f] = c.providerSpecificData[f];
    }
    safe.providerSpecificData = psd;
  }
  return safe;
}

function isUsageEligible(connection) {
  return USAGE_SUPPORTED_PROVIDERS.includes(connection.provider) && (
    connection.authType === "oauth" || USAGE_APIKEY_PROVIDERS.includes(connection.provider)
  );
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sortConnections(connections, sort) {
  const list = [...connections];

  if (sort === "provider") {
    return list.sort((a, b) => {
      const orderA = USAGE_SUPPORTED_PROVIDERS.indexOf(a.provider);
      const orderB = USAGE_SUPPORTED_PROVIDERS.indexOf(b.provider);
      if (orderA !== orderB) return orderA - orderB;
      return a.provider.localeCompare(b.provider);
    });
  }

  return list.sort((a, b) => {
    const priorityA = a.priority ?? Number.MAX_SAFE_INTEGER;
    const priorityB = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return (a.provider || "").localeCompare(b.provider || "");
  });
}

export async function GET(request) {
  try {
    await backfillCodexEmails();

    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || "all";
    const accountStatus = searchParams.get("accountStatus") || "all";
    const sort = searchParams.get("sort") || "priority";
    const page = parsePositiveInt(searchParams.get("page"), 1);
    const pageSize = Math.min(parsePositiveInt(searchParams.get("pageSize"), DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

    const includeImageAccounts = searchParams.get("includeImageAccounts") === "true";
    const allConnections = await getProviderConnections();
    const eligibleConnections = allConnections.filter((connection) => isUsageEligible(connection)
      || (includeImageAccounts && ["antigravity", "codex", "gemini"].includes(connection.provider)));
    const providerOptions = Array.from(new Set(eligibleConnections.map((conn) => conn.provider))).sort();

    const providerFilteredConnections = eligibleConnections.filter((conn) => (
      provider === "all" || conn.provider === provider
    ));

    const accountFilteredConnections = providerFilteredConnections.filter((conn) => {
      if (accountStatus === "active") return conn.isActive ?? true;
      if (accountStatus === "inactive") return !(conn.isActive ?? true);
      return true;
    });

    const model = searchParams.get("model") || "";
    const modelProvider = searchParams.get("model_provider") || "";
    const category = searchParams.get("category") || "all";
    if (model && !QUOTA_MODEL_ID.test(model) || modelProvider.length > 80 || !QUOTA_MODEL_CATEGORIES.some(item => item.value === category)) {
      return NextResponse.json({ error: "Invalid model filter" }, { status: 400 });
    }
    const wantsCatalog = searchParams.get("includeCatalog") === "true";
    let models = [];
    if (wantsCatalog || model || category !== "all" || searchParams.get("rotationModel")) {
      models = configuredQuotaModels(providerOptions.filter(id => provider === "all" || id === provider), await getCustomModels());
    }
    const matchingConnections = filterQuotaConnections(accountFilteredConnections, models, { model, modelProvider, category });
    let sortedConnections = sortConnections(matchingConnections, sort);
    let rotationSegments = null, rotationHints = {}, resetPrioritySummary = null;
    if (searchParams.has("rotationPolicy")) {
      const encoded = searchParams.get("rotationPolicy");
      const rotationModel = searchParams.get("rotationModel") || "";
      if (provider === "all" || encoded.length > 4096 || rotationModel.length > 256 || rotationModel && !QUOTA_MODEL_ID.test(rotationModel)) return NextResponse.json({error:"Invalid rotation preview"},{status:400});
      let policy;
      try { policy = validateRotation(JSON.parse(encoded), provider); } catch { return NextResponse.json({error:"Invalid rotation preview policy"},{status:400}); }
      const snapshots = await readRotationSnapshots(sortedConnections);
      const cleanModel = canonicalTextModel(provider, rotationModel);
      const lockModel = getModelUpstreamId(PROVIDER_ID_TO_ALIAS[provider] || provider, cleanModel);
      const image = models.some(item => item.provider === provider && item.id === cleanModel && item.kind === "image");
      const imageStates=image&&['codex','antigravity','gemini'].includes(provider)?await getImageQuotaState(sortedConnections,provider,'image_generation',lockModel):null;
      if(image)policy=resolveImageAccountPreference(resolveImageRouting(await getSettings(),provider,lockModel,'generate'),policy,provider);
      const resetHolds = provider==='codex'&&!image&&scopeMatches(provider,'codex:main',rotationModel)?await readCreditResetHolds(sortedConnections):[];
      const evaluation = policy.enabled || policy.groupAvailability || rotationModel ? rotationPool(sortedConnections, snapshots, policy, {resetHolds,provider,model:rotationModel,lockModel,imageStates,quotaAdmission:image,textPolicies:image?null:await readTextModelPolicies(sortedConnections)}) : evaluateRotation(sortedConnections, snapshots, policy, {provider,model:rotationModel});
      resetPrioritySummary = rotationPreviewInfo(evaluation, snapshots, policy, {provider,model:rotationModel,now:Date.now()}).creditSummary;
      // Card sorting includes every account. Request admission remains in rotationPool.
      const displayPolicy = {...policy, enabled: policy.sorts.length > 0 || policy.resetPriority.enabled};
      const displayOrder = evaluateRotation(sortedConnections, snapshots, displayPolicy, {provider,model:rotationModel,includeExhausted:true});
      resetPrioritySummary = {...resetPrioritySummary, enabled: displayPolicy.resetPriority.enabled, matching: displayOrder.ranked.filter(row=>row.urgent).length};
      rotationHints = Object.fromEntries(displayOrder.ranked.filter(row=>row.resetGroup).map(row=>[row.connection.id,{group:row.resetGroup,expiresAt:row.expiry}]));
      const unavailable = new Set([...evaluation.waiting, ...(evaluation.blocked || [])].map(row=>row.connection.id));
      sortedConnections = displayOrder.ranked.map(row=>row.connection);
      rotationSegments = displayOrder.segments.map(segment => ({
        key:segment.key,
        resetGroup:segment.resetGroup,
        ids:segment.rows.map(row=>row.connection.id),
        boundaries:segment.boundaries,
        unavailableIds:segment.rows.filter(row=>unavailable.has(row.connection.id)||applicableRotationQuotas(snapshots[row.connection.id],provider,rotationModel).some(quota=>quota.remaining===0)).map(row=>row.connection.id),
        rotationName:RESET_GROUPS.find(group=>group.key===segment.resetGroup)?.label||"Rotation segment",
      }));
    }
    if (searchParams.has("resetPriority") && !searchParams.has("rotationPolicy")) {
      const encoded = searchParams.get("resetPriority");
      let policy;
      try {
        if (encoded.length > 1024) throw new TypeError();
        policy = validateRotation({...emptyRotation(),enabled:true,resetPriority:JSON.parse(encoded)},'codex');
      } catch { return NextResponse.json({error:"Invalid reset priority"},{status:400}); }
      const codex = sortedConnections.filter(connection => connection.provider === 'codex');
      const snapshots = await readRotationSnapshots(codex), now = Date.now();
      const evaluation = rotationPool(codex,snapshots,policy,{provider:'codex',model,now});
      resetPrioritySummary = rotationPreviewInfo(evaluation,snapshots,policy,{provider:'codex',model,now}).creditSummary;
      const display = evaluateRotation(codex,snapshots,policy,{provider:'codex',model,now,includeExhausted:true});
      const urgent = display.ranked.filter(row => row.urgent);
      resetPrioritySummary = {...resetPrioritySummary,enabled:true,matching:urgent.length};
      rotationHints = Object.fromEntries(display.ranked.filter(row=>row.resetGroup).map(row => [row.connection.id,{group:row.resetGroup,expiresAt:row.expiry}]));
      // Promote across the entire result before pagination; local card sorts stay inside this group.
      sortedConnections = [...display.ranked.map(row=>row.connection),...sortedConnections.filter(connection=>connection.provider!=='codex')];
    }
    if (resetPrioritySummary) {
      const {policy:saved} = await readRotationPolicy('codex');
      const requested = searchParams.has('rotationPolicy') ? JSON.parse(searchParams.get('rotationPolicy')).resetPriority : JSON.parse(searchParams.get('resetPriority'));
      resetPrioritySummary.live = requested.enabled && saved.enabled && saved.resetPriority.enabled && saved.resetPriority.days === requested.days && saved.resetPriority.weeklyBelow === requested.weeklyBelow && Boolean(saved.resetPriority.autoReset) === Boolean(requested.autoReset);
    }
    const total = sortedConnections.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);
    const offset = (currentPage - 1) * pageSize;
    const pageConnections = sortedConnections.slice(offset, offset + pageSize).map(connection => ({...sanitize(connection),...(wantsCatalog ? {displayModels: models.filter(item => accountMatchesQuotaModel(connection,item))} : {}),...(rotationHints[connection.id]?{rotationHint:rotationHints[connection.id]}:{})}));

    return NextResponse.json({
      connections: pageConnections,
      rotationSegments,
      resetPrioritySummary,
      ...(wantsCatalog ? { modelCatalog: quotaCatalogCounts(accountFilteredConnections, models, category), catalogObservedAt: new Date().toISOString(), supportScope: "configured_catalog_not_confirmed_access" } : {}),
      scope: { provider, accountStatus, model, modelProvider, category },
      providerOptions,
      pagination: {
        page: currentPage,
        pageSize,
        total,
        totalPages,
      },
      totals: {
        eligibleConnections: eligibleConnections.length,
        providerFilteredConnections: providerFilteredConnections.length,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error fetching providers for client:", error);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}
