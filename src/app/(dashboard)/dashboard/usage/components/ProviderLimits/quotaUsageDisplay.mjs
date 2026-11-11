export function getQuotaUsageDisplay(quota = {}) {
  if(quota.displayUnit==='relative_percentage' && quota.quotaStatus!=='unknown') {
    const remaining=typeof quota.remaining==='number' ? quota.remaining : typeof quota.used==='number' ? 100-quota.used : NaN;
    return {text:Number.isFinite(remaining)?'Plan allowance':'Unreported',title:'Provider-reported relative allowance. Not a request or token count; percentages across different plans are not equal capacity.'};
  }
  if (quota.displayUnit === "image_window_unreported") {
    return {
      text: "Window unreported",
      title: "Codex has not reported a separate image quota window or call allowance. A recorded provider reset is a next-check hint, not guaranteed capacity.",
    };
  }

  if (quota.quotaStatus === "unknown") {
    return {
      text: "Quota status unknown",
      title: "The provider did not report a usable quota fraction for this model.",
    };
  }

  if (quota.displayUnit === "provider_percentage") {
    return {
      text: "Provider quota percentage · request count unavailable",
      title: "The provider reports a percentage, not an image request allowance.",
    };
  }

  if (quota.displayUnit === "normalized_percentage") {
    return {
      text: "Normalized quota percentage · request count unavailable",
      title: "The 1000-point scale is a UI normalization of a quota fraction, not a provider request count.",
    };
  }

  const total = Number(quota.total) > 0 ? Number(quota.total).toLocaleString() : "∞";
  const text = `${(Number(quota.used) || 0).toLocaleString()} / ${total}`;
  return { text, title: text };
}
