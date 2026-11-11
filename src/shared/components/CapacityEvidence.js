'use client';
export default function CapacityEvidence({estimate}) {
  const observed=estimate?.state==='observed';
  if(estimate?.state==='choose_model')return null;
  return <span tabIndex={0} role="note" className="inline-flex items-center gap-1 text-xs text-text-muted" title={observed?`${estimate.samples} local quota intervals · requested settings: ${estimate.speed}/${estimate.effort} · ${new Date(estimate.observedAt).toLocaleString()}. Range extrapolates similar recorded work, not a guaranteed token allowance or statistical confidence interval. External use and hidden provider weights are unobserved.`:'Learning from normal traffic. Needs at least 5 comparable intervals, 25 quota points and 10 successful requests per applicable allowance. No extra test requests are made.'}><span aria-hidden="true" className="material-symbols-outlined text-[14px]">science</span>{observed?`≈${estimate.low}–${estimate.high} similar requests`:'Learning capacity'}</span>;
}
