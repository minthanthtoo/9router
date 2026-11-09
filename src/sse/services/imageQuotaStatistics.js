// Wilson score interval: uncertainty in observed binary checks, not remaining capacity.
export function wilsonInterval(successes,failures){
 const n=successes+failures;if(!n)return null;
 const z=1.959963984540054,p=successes/n,denominator=1+z*z/n;
 const center=(p+z*z/(2*n))/denominator,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/denominator;
 return {samples:n,rate:p,lower:Math.max(0,center-half),upper:Math.min(1,center+half),level:0.95};
}
// Recovery is interval censored between the last observed refusal and first later success.
export function recoveryIntervals(history){
 const events=[...history].sort((a,b)=>Date.parse(a.dispatchedAt)-Date.parse(b.dispatchedAt));
 const intervals=[];let start=null,last=null;
 for(const event of events){
  const dispatched=Date.parse(event.dispatchedAt),completed=Date.parse(event.completedAt||event.dispatchedAt);
  if(event.outcome==='quota_rejected'){
   if(start===null)start=completed;
   last=Math.max(last??completed,completed);
  }else if(event.outcome==='succeeded'&&start!==null&&dispatched>last){
   intervals.push({from:new Date(start).toISOString(),lastRefusalAt:new Date(last).toISOString(),firstSuccessAt:event.dispatchedAt,to:event.dispatchedAt,minSeconds:Math.max(0,(last-start)/1000),maxSeconds:(dispatched-start)/1000});start=null;last=null;
  }
 }
 return {completed:intervals.length,open:start!==null,intervals:intervals.slice(-30),meaning:'observed_wait_until_recovery_not_quota_window'};
}

// Compare anchored fixed periods only when repeated provider reset hints supply the phase.
export function fixedResetFits(history, periods) {
 const events=[...history].sort((a,b)=>Date.parse(a.dispatchedAt)-Date.parse(b.dispatchedAt));
 if(events.some(event=>['in_flight','outcome_unknown'].includes(event.outcome)))return [];
 const resets=[...new Set(events.filter(event=>event.outcome==='quota_rejected'&&event.confidence==='provider_confirmed'&&Date.parse(event.retryAt)>Date.parse(event.dispatchedAt)).map(event=>Date.parse(event.retryAt)))].sort((a,b)=>a-b);
 if(resets.length<4)return [];
 return periods.flatMap(seconds=>{
  const period=seconds*1000,anchor=resets[0],gaps=resets.slice(1).map((value,index)=>value-resets[index]);
  if(gaps.filter(gap=>Math.abs(gap-period)<=1000).length<2)return [];
  const error=Math.max(...resets.map(value=>Math.abs(value-anchor-Math.round((value-anchor)/period)*period)));
  if(error>1000)return [];
  const buckets=new Map();let minimum=1,maximum=Infinity,successes=0,rejections=0;
  for(const event of events){
   const at=Date.parse(event.dispatchedAt);if(at<anchor)continue;
   const bucket=Math.floor((at-anchor)/period),consumed=buckets.get(bucket)||0;
   if(event.outcome==='succeeded'){minimum=Math.max(minimum,consumed+1);buckets.set(bucket,consumed+1);successes++;}
   if(event.outcome==='quota_rejected'){maximum=Math.min(maximum,consumed);rejections++;}
  }
  return successes>=6&&rejections>=3&&minimum===maximum
   ? [{periodSeconds:seconds,callLimit:minimum,resetAnchorAt:new Date(anchor).toISOString(),resetHints:resets.length,phaseErrorSeconds:error/1000}] : [];
 });
}

// Quota-hit spacing is an observed span, not a reset period or an admission allowance.
export function quotaHitSpans(history) {
 const events=[...history].sort((a,b)=>Date.parse(a.dispatchedAt)-Date.parse(b.dispatchedAt));
 const spans=[];let previous=null,last=null,successes=0,uncertain=false;
 for(const event of events){
  const at=Date.parse(event.completedAt||event.dispatchedAt);if(!Number.isFinite(at))continue;
  if(['outcome_unknown','in_flight'].includes(event.outcome))uncertain=true;
  if(event.outcome==='succeeded'&&previous!==null)successes++;
  if(event.outcome!=='quota_rejected')continue;
  if(previous!==null&&successes>0){spans.push({from:new Date(previous).toISOString(),to:new Date(at).toISOString(),seconds:Math.max(0,(at-previous)/1000),successfulCalls:successes,uncertain});successes=0;uncertain=false;}
  previous=at;last=at;
 }
 return {latestHitAt:last===null?null:new Date(last).toISOString(),intervals:spans.slice(-12),meaning:'successful_dispatches_between_quota_hit_episodes_not_a_reset_period'};
}
