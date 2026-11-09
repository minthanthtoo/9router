export const IMAGE_RUN_STATES = new Set(['queued','running','stopping','waiting_reset','paused','needs_review','completed','cancelled']);
const ITEM_STATES = ['pending','running','succeeded','refused','unknown','cancelled'];
export function validImageTestRun(run) {
  return run === null || Boolean(run && typeof run.id === 'string' && run.id && IMAGE_RUN_STATES.has(run.state)
    && Number.isSafeInteger(run.revision) && run.revision >= 0 && Array.isArray(run.items)
    && run.items.every(item=>item && ITEM_STATES.includes(item.state)));
}
export function imageRunSummary(items) {
  const counts=Object.fromEntries(ITEM_STATES.map(key=>[key,0]));
  for(const item of items)if(Object.hasOwn(counts,item.state))counts[item.state]++;
  return {...counts,total:items.length,processed:counts.succeeded+counts.refused+counts.unknown+counts.cancelled,
    attempted:counts.succeeded+counts.refused+counts.unknown+counts.running};
}
export function imageRunReadError(error, saved) {
  if([401,403].includes(error?.status))return 'Sign in again to refresh test status. Saved results are unchanged.';
  const code=Number.isInteger(error?.status)?` (HTTP ${error.status})`:'';
  if(error?.invalid)return 'Invalid test status response. Saved results are unchanged; refresh to retry.';
  return saved?`Status connection interrupted${code}. Showing saved results; retrying automatically.`:`Test status unavailable${code}. Recheck before starting a run.`;
}

export function validBlockedImageTargets(targets) {
  return Array.isArray(targets) && targets.every(item => item && typeof item.connectionId === 'string' && typeof item.model === 'string' && typeof item.runId === 'string');
}

export function imageRunPauseDetails(job) {
  if (job?.state !== 'paused') return null;
  const refusals=job.items.filter(item=>item.state==='refused');
  const last=refusals.at(-1);
  if (!last) return {reason:'The batch is paused.',remaining:job.items.filter(item=>item.state==='pending').length,skipped:0,retryAt:null};
  const blocked=new Set(refusals.filter(item=>[401,403].includes(item.status)||item.status===429&&(!item.retryAt||Date.parse(item.retryAt)>Date.now())).map(item=>item.connectionId));
  const pending=job.items.filter(item=>item.state==='pending');
  return {
    reason:last.failureCode==='image_pool_paused'||last.message==='Test not sent: image generation is paused.'?'Model turned off · test not sent.':last.status===429?`${last.accountLabel||'This account'} reached its quota (HTTP 429).`:[401,403].includes(last.status)?`${last.accountLabel||'This account'} needs sign-in or access (HTTP ${last.status}).`:last.message||'The batch is paused.',
    retryAt:last.status===429?last.retryAt:null,
    skipped:pending.filter(item=>blocked.has(item.connectionId)).length,
    remaining:pending.filter(item=>!blocked.has(item.connectionId)).length,
  };
}
