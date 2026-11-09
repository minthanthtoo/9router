"use client";

import Toggle from "@/shared/components/Toggle";
import { imageManualPolicy, imagePolicyKey } from "./imagePolicyCommand.mjs";

export default function ImagePolicyToggle({ row, state, model = null, compact = false }) {
  const key = imagePolicyKey(row.connectionId, model);
  const pending = state.drafts[key]?.outcomeUnknown;
  const enabled = imageManualPolicy(row, model).state !== "paused";
  const title = pending ? "Save unconfirmed. Click to retry the same command."
    : `${enabled ? "Disable" : "Enable"} ${model || "all image models"}${row.linkedCredentialCount > 1 ? ` · shared with ${row.linkedCredentialCount} linked credentials` : ""}. Provider restrictions still apply.`;
  return <span className={`inline-flex ${compact?"h-7":"min-h-9"} items-center gap-1`} title={title}>
    <Toggle size={compact?"sm":"md"} checked={enabled} disabled={!!state.busyId || row.routeState === "identity_required"}
      ariaLabel={pending ? `Retry unconfirmed image switch on ${row.accountLabel}` : `${enabled ? "Disable" : "Enable"} ${model || "all image models"} on ${row.accountLabel}`}
      title={title} onChange={() => state.togglePolicy(row, model)} />
    {(pending || state.busyId === key) && <span aria-label={pending ? "Save unconfirmed" : "Saving"} className={`material-symbols-outlined text-amber-500 ${pending ? "" : "motion-safe:animate-spin"}`} style={{fontSize:16}}>{pending ? "sync_problem" : "progress_activity"}</span>}
  </span>;
}
