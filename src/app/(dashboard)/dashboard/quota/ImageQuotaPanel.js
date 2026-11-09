"use client";

import { useEffect, useMemo, useState } from "react";
import ImageBulkPermission from "./ImageBulkPermission";
import ImageAccountControls from "./ImageAccountControls";
import ImageRunProgress from "./ImageRunProgress";
import ImageManagementActivity from "./ImageManagementActivity";
import ImageTestBatchButton from "./ImageTestBatchButton";
import ImagePolicyToggle from "./ImagePolicyToggle";
import ProviderIcon from "@/shared/components/ProviderIcon";
import Badge from "@/shared/components/Badge";
import { formatMicrousd } from "./constraintDisplay.mjs";
import ImageHelp from './ImageHelp';
import { buildImageQuotaRows, filterImageQuotaRows, sortImageQuotaRows, groupImageQuotaRows, imageQuotaRowState } from "./imageQuotaTable.mjs";

const STATES = {
  eligible: "Eligible", eligible_unreported: "Quota unknown", quota_blocked: "Image quota reached",
  probe_eligible: "Check due", probe_in_progress: "Checking", model_scoped_limits: "Model limited",
  manual_paused: "Paused", account_disabled: "Account disabled", model_not_enabled: "Model off",
  provider_usage_blocked: "Provider blocked", local_capacity_limited: "Local cap",
  legacy_cooldown: "Cooldown", identity_required: "Project needed", unavailable: "Unavailable",
};
const STATE_VARIANTS = { quota_blocked: "error", provider_usage_blocked: "error", identity_required: "warning", probe_eligible: "warning", probe_in_progress: "warning", local_capacity_limited: "warning", model_scoped_limits: "warning", eligible_unreported: "info" };
const SUPPLIER = {
  protected: "Protected", budget_exhausted: "Budget reached", budget_unavailable: "Budget unknown",
  policy_missing_fenced: "Policy missing · fenced", invalid_policy: "Policy invalid · fenced",
  legacy_unprotected: "Legacy routing unprotected", unavailable: "Supplier state unknown",
};
const SUPPLIER_BUDGET = {
  active: "Active", limit_reached: "Limit reached", outside_window: "Outside pilot window", disabled: "Disabled",
};

function budgetAmount(budget, kind, period) {
  return formatMicrousd(budget?.[kind]?.[period]);
}

function budgetUsage(budget, period) {
  return `${budgetAmount(budget, "obligationMicrousd", period)} / ${budgetAmount(budget, "limitsMicrousd", period)} · ${budgetAmount(budget, "remainingMicrousd", period)} headroom`;
}

function date(value) {
  const time = value && new Date(value);
  return time && Number.isFinite(time.getTime()) ? time.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
}

export default function ImageQuotaPanel({ state, onOpenAccountSettings, onSelectModel, settingsError }) {
  const { projection, loading, refreshing, error, fetchStatus, model, modelProvider } = state;
  const [provider, setProvider] = useState("all");
  const [status, setStatus] = useState("all");
  const [accountQuery, setAccountQuery] = useState("");
  const [collapsedProviders, setCollapsedProviders] = useState(new Set());
  const [expandedAccounts, setExpandedAccounts] = useState(new Set());
  const [sort, setSort] = useState({ key: "account", direction: "asc" });
  const entries = useMemo(() => buildImageQuotaRows(projection, model, modelProvider, state.catalog), [projection, model, modelProvider, state.catalog]);
  const accountOptions = useMemo(() => [...new Set((projection?.rows || []).map((row) => row.accountLabel).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [projection]);
  const visible = useMemo(() => {
    const filtered = filterImageQuotaRows(entries, { provider, status, accountQuery });
    return sortImageQuotaRows(filtered, sort);
  }, [entries, provider, status, accountQuery, sort]);
  const [page,setPage]=useState(1);
  const identities=[...new Set(visible.map(({account})=>`${account.provider}:${account.connectionId}`))];
  const pages=Math.max(1,Math.ceil(identities.length/10)),activePage=Math.min(page,pages);
  const pageIds=new Set(identities.slice((activePage-1)*10,activePage*10));
  const groups = groupImageQuotaRows(visible.filter(({account})=>pageIds.has(`${account.provider}:${account.connectionId}`)));
  useEffect(()=>setPage(1),[provider,status,accountQuery,model,modelProvider,sort]);
  const toggle = (setter, key) => setter(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const blocked = visible.filter(row => ["quota_blocked", "provider_usage_blocked", "local_capacity_limited"].includes(imageQuotaRowState(row))).length;
  const unknown = visible.filter(row => ["eligible_unreported", "identity_required", "unavailable"].includes(imageQuotaRowState(row))).length;
  const modelCount = visible.filter(({ entry }) => entry).length;
  const supplier = projection?.supplierAdmission;

  const sortBy = (key) => setSort((current) => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" }));


  return <section aria-label="Image quota" className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2"><h2 className="text-base font-semibold">Image availability</h2><ImageHelp label="Image availability"><p>These states describe permission to route, saved restrictions and known observations. An available route does not establish remaining image allowance. Subscription image limits are separate from text usage and API credits.</p><p>Model counts can include several models sharing one subscription quota. A successful test does not reveal the limit; normal use and later recoveries provide estimation evidence.</p></ImageHelp></div>
      <button type="button" onClick={() => fetchStatus()} disabled={refreshing} aria-label="Refresh saved image quota status" title="Refresh saved status" className="flex size-10 items-center justify-center rounded-lg border border-border disabled:opacity-50"><span className={`material-symbols-outlined ${refreshing ? "animate-spin" : ""}`}>refresh</span></button>
    </div>

    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {settingsError && <p role="alert" className="text-sm text-red-500">{settingsError}</p>}
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="rounded-full border border-border px-2 py-1">{new Set(visible.map(({ account }) => account.connectionId)).size} accounts</span>
      <span className="rounded-full border border-border px-2 py-1">{blocked} model limits</span>
      <span className="rounded-full border border-border px-2 py-1">{unknown} unknown limits</span>
      <span className="rounded-full border border-border px-2 py-1">{modelCount} models</span>
      {model && <span className="rounded-full border border-border px-2 py-1">{model} · {modelProvider || "all providers"}</span>}
      {projection?.generatedAt && <span className="text-text-muted">Read {date(projection.generatedAt)}</span>}
    </div>

    {supplier && <details className="rounded-lg border border-border px-3 py-2 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2"><span className="material-symbols-outlined text-base">shield</span><span>Spend guard</span><Badge variant={supplier.state === "protected" ? "success" : "warning"} size="sm">{SUPPLIER[supplier.state] || "Unknown"}</Badge></summary>
      <p className="mt-2 text-xs text-text-muted">{supplier.state === "protected" ? "Required budgets are active and below their local caps." : supplier.state === "legacy_unprotected" ? "No spend admission policy is configured; legacy image routes may dispatch." : supplier.configured ? `${supplier.callerCount} callers · ${supplier.routeCount} routes` : "Supplier admission state is not confirmed."}</p>
      {supplier.budgets?.length > 0 && <div className="mt-2 grid gap-2 sm:grid-cols-2">{supplier.budgets.map((budget) => <div key={budget.reference} className="min-w-0 text-xs"><strong>{(budget.scopeType || "supplier").replaceAll("_", " ")}</strong> · {SUPPLIER_BUDGET[budget.status] || "Unknown"}{budget.inPolicy === false && <span className="text-text-muted"> · outside active policy</span>}<p className="mt-1 text-text-muted">Daily {budgetUsage(budget, "daily")}</p><p className="text-text-muted">Monthly {budgetUsage(budget, "monthly")}</p><p className="mt-1 text-text-muted">Outstanding {formatMicrousd(budget.openMicrousd)} open · {formatMicrousd(budget.provisionalMicrousd)} provisional</p></div>)}</div>}
      <p className="mt-2 text-[10px] text-text-muted">Local USD exposure only, not a provider invoice, provider quota, or billing confirmation. This status read makes no provider inference calls. Open dispatches keep their reservation against daily and monthly headroom until reconciled.</p>
    </details>}

    <div className="flex flex-wrap gap-2">
      <label className="sr-only" htmlFor="image-quota-provider">Provider</label>
      <select id="image-quota-provider" value={provider} onChange={(event) => setProvider(event.target.value)} className="h-10 rounded-lg border border-border bg-surface px-2 text-sm"><option value="all">All providers</option>{[...new Set(entries.map(({account})=>account.provider))].map((value) => <option key={value} value={value}>{value}</option>)}</select>
      <label className="sr-only" htmlFor="image-quota-state">State</label>
      <select id="image-quota-state" value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 rounded-lg border border-border bg-surface px-2 text-sm"><option value="all">All states</option>{Object.entries(STATES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <label htmlFor="image-quota-account" className="sr-only">Account search</label>
      <input id="image-quota-account" list="image-quota-accounts" value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} placeholder="All accounts" className="h-10 min-w-40 flex-1 rounded-lg border border-border bg-surface px-2 text-sm" />
      <ImageTestBatchButton rows={visible} label={model || status !== "all" || accountQuery ? "Test filtered" : provider === "all" ? "Test all providers" : "Test provider"} scope={`${provider === "all" ? "All providers" : provider} · current model, state and account filters`} runner={state.tests} />
      <datalist id="image-quota-accounts">{accountOptions.map((label) => <option key={label} value={label} />)}</datalist>
    </div>

    <ImageBulkPermission accounts={groups.flatMap(group=>group.accounts.map(item=>item.account))} state={state}/>
    {['queued','running','stopping','waiting_reset','paused','needs_review'].includes(state.tests.job?.state)||state.tests.error||state.tests.blockedTargets?.length ? <ImageRunProgress runner={state.tests} controls/> : state.tests.job&&<details><summary className="min-h-9 cursor-pointer py-2 text-xs text-text-muted">Last check results</summary><ImageRunProgress runner={state.tests} controls/></details>}
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button type="button" onClick={() => { setCollapsedProviders(new Set()); setExpandedAccounts(new Set(groups.flatMap(group => group.accounts.map(item => item.key)))); }} className="min-h-9 rounded border border-border px-2">Expand accounts</button>
      <button type="button" onClick={() => setExpandedAccounts(new Set())} className="min-h-9 rounded border border-border px-2">Collapse accounts</button>
      <label htmlFor="image-model-sort" className="ml-auto text-text-muted">Sort models</label>
      <select id="image-model-sort" value={sort.key} onChange={event=>setSort(current=>({...current,key:event.target.value}))} className="h-9 rounded border border-border bg-surface px-2"><option value="account">Name</option><option value="next">Next check</option><option value="calls24h">24h calls</option><option value="total">Recorded total</option></select>
      <button type="button" aria-label="Reverse model sort" onClick={()=>sortBy(sort.key)} className="flex size-9 items-center justify-center rounded border border-border"><span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:18}}>{sort.direction==='asc'?'arrow_upward':'arrow_downward'}</span></button>
    </div>
    {loading && !projection ? <p role="status" className="py-4 text-center text-sm text-text-muted">Loading…</p>
      : visible.length === 0 ? <p className="py-4 text-center text-sm text-text-muted">No matching image quota records.</p>
        : groups.map(group => <section key={group.provider} aria-label={`${group.provider} image accounts`} className="min-w-0 border-y border-border-subtle">
          <div className="flex flex-wrap items-center gap-2 bg-surface-2 px-2 py-1">
            <button type="button" aria-expanded={!collapsedProviders.has(group.provider)} aria-label={`Toggle ${group.provider} accounts`} onClick={()=>toggle(setCollapsedProviders,group.provider)} className="flex min-h-10 min-w-0 basis-48 grow items-center gap-2 text-left text-sm font-semibold"><span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:18}}>{collapsedProviders.has(group.provider)?'chevron_right':'expand_more'}</span><ProviderIcon providerId={group.provider} alt="" size={20} />{group.provider}<span className="text-xs font-normal text-text-muted">{group.accounts.length} accounts</span></button>
            <ImageTestBatchButton rows={group.rows} label="Test provider" scope={`${group.provider} · current filters · all matching accounts`} runner={state.tests} />
          </div>

          {!collapsedProviders.has(group.provider) && group.accounts.map(item => {
            const account=item.account;
            const expanded=expandedAccounts.has(item.key);
            return <section key={item.key} aria-label={`${group.provider} ${account.accountLabel} models`} className="border-t border-border">
              <div className="flex flex-wrap items-center gap-2 px-2 py-1">
                <button type="button" aria-expanded={expanded} aria-label={`Toggle models for ${group.provider} ${account.accountLabel}`} onClick={()=>toggle(setExpandedAccounts,item.key)} className="flex min-h-10 min-w-0 basis-64 grow flex-wrap items-center gap-2 text-left text-xs"><span aria-hidden="true" className="material-symbols-outlined text-text-muted" style={{fontSize:18}}>{expanded?'expand_more':'chevron_right'}</span><strong className="min-w-0 break-words [overflow-wrap:anywhere]">{account.accountLabel}</strong><Badge size="sm" variant={STATE_VARIANTS[account.routeState] || 'default'}>{STATES[account.routeState] || account.routeState}</Badge><span className="text-text-muted">{item.rows.length} models{account.linkedCredentialCount>1?` · ${account.linkedCredentialCount} linked`:''}</span></button>
                {!expanded&&<span className="inline-flex items-center gap-1 text-xs text-text-muted"><span>Allow images</span><ImagePolicyToggle row={account} state={state} /></span>}<ImageTestBatchButton rows={item.rows} label="Test account" scope={`${group.provider} · ${account.accountLabel} · current filters`} runner={state.tests} />
                <button type="button" title="Edit this account" aria-label={`Edit ${account.accountLabel} settings`} onClick={()=>onOpenAccountSettings?.(account)} className="flex size-10 items-center justify-center rounded border border-border text-blue-500"><span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:18}}>edit</span></button>
              </div>

              {expanded && <ImageAccountControls row={account} state={state} modelRows={item.rows.map(({entry,model})=>({...entry,model}))} onSelectModel={onSelectModel} onOpenAccountSettings={onOpenAccountSettings}><details><summary className="min-h-9 cursor-pointer py-2 text-xs text-text-muted">Recorded activity</summary><ImageManagementActivity account={account} rows={item.rows} model={model}/></details></ImageAccountControls>}
            </section>;
          })}
        </section>)}
    {pages>1&&<nav aria-label="Image account pages" className="flex flex-wrap items-center justify-end gap-1 text-xs"><span className="mr-auto text-text-muted">{identities.length} accounts · Page {activePage} of {pages}</span><button type="button" className="min-h-9 rounded border border-border px-2 disabled:opacity-40" disabled={activePage===1} onClick={()=>setPage(activePage-1)}>Previous</button>{[...new Set([1,activePage-1,activePage,activePage+1,pages])].filter(n=>n>0&&n<=pages).sort((a,b)=>a-b).map(n=><button key={n} type="button" aria-current={n===activePage?'page':undefined} className={`min-h-9 rounded px-2 ${n===activePage?'bg-primary text-white':''}`} onClick={()=>setPage(n)}>{n}</button>)}<button type="button" className="min-h-9 rounded border border-border px-2 disabled:opacity-40" disabled={activePage===pages} onClick={()=>setPage(activePage+1)}>Next</button></nav>}
  </section>;
}
