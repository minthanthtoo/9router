const DAY=86400000;
const parse=value=>{try{return typeof value==='string'?JSON.parse(value):value||{};}catch{return {};}};
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function accountContext(connection={},snapshot) {
  const live=typeof snapshot?.plan==='string'&&snapshot.plan!=='unknown'&&snapshot.plan.trim();
  const claim=typeof connection.providerSpecificData?.chatgptPlanType==='string'?connection.providerSpecificData.chatgptPlanType:null;
  return {authMode:['apikey','api_key'].includes(connection.authType)?'api_key':['oauth','access_token'].includes(connection.authType)?'subscription':'unknown',plan:live||typeof claim==='string'&&claim.slice(0,80)||null,planSource:live?'provider_usage':claim?'authentication':'unknown',observedAt:live?snapshot.observedAt:null};
}
export function usageWorkload(startedAt,body={}) {
  if(!finite(startedAt)||!Number.isSafeInteger(startedAt)||startedAt<=0||startedAt>Date.now()||!body||typeof body!=='object')return {};
  const speed=body.service_tier||'standard',effort=body.reasoning?.effort||body.reasoning_effort||'default';
  if(!['standard','auto','default','priority','fast','ultrafast','flex'].includes(speed)||!['default','none','minimal','low','medium','high','xhigh','max'].includes(effort))return {};
  return {startedAt,speed,effort};
}
export function collectCapacitySamples(old,next,rows=[]) {
  if(!old||!old.plan||old.plan==='unknown'||old.plan!==next.plan||old.provider!==next.provider||!old.completedAt||next.observedAt<=old.completedAt||next.observedAt-old.observedAt>3600000||!rows.length||rows.length>500)return [];
  const requests=rows.map(row=>({...row,meta:parse(row.meta),tokens:parse(row.tokens),endedAt:Date.parse(row.timestamp)}));
  const first=requests[0],cohort=JSON.stringify([first.model,first.meta.speed,first.meta.effort]);
  if(!first.model||!first.meta.speed||!first.meta.effort||requests.some(row=>row.status!=='ok'||JSON.stringify([row.model,row.meta.speed,row.meta.effort])!==cohort||!finite(row.meta.startedAt)||row.meta.startedAt<old.completedAt||!finite(row.endedAt)||row.endedAt<row.meta.startedAt||row.endedAt>next.observedAt))return [];
  const tokens={uncached:0,cached:0,output:0};
  for(const row of requests){
    const input=row.tokens.prompt_tokens??row.tokens.input_tokens,cached=row.tokens.cached_tokens??row.tokens.cache_read_input_tokens,output=row.tokens.completion_tokens??row.tokens.output_tokens;
    if(row.tokens.estimated||!finite(input)||!finite(cached)||!finite(output)||cached>input||input+output<=0)return [];
    tokens.uncached+=input-cached;tokens.cached+=cached;tokens.output+=output;
  }
  return next.quotas.flatMap(quota=>{
    const before=old.quotas.find(q=>q.id===quota.id&&q.scope===quota.scope&&q.windowSeconds===quota.windowSeconds);
    const points=before?.remaining-quota.remaining;
    if(!before||!finite(before.remaining)||!finite(quota.remaining)||!finite(before.resetAt)||!finite(quota.resetAt)||quota.resetAt<=next.observedAt||Math.abs(before.resetAt-quota.resetAt)>2000||!finite(quota.windowSeconds)||points<5||points>100)return [];
    return [{quotaId:quota.id,scope:quota.scope,windowSeconds:quota.windowSeconds,plan:next.plan,model:first.model,speed:first.meta.speed,effort:first.meta.effort,at:next.observedAt,points,requests:requests.length,tokens}];
  });
}
export function estimateCapacity(snapshot,model,now=Date.now(),quotas=snapshot?.quotas||[]) {
  if(!model)return {state:'choose_model'};
  const unknown={state:'learning',unit:'similar_requests'};
  if(!snapshot||!finite(snapshot.observedAt)||now<snapshot.observedAt||now-snapshot.observedAt>600000)return unknown;
  const samples=(snapshot.capacitySamples||[]).filter(s=>s.model===model&&s.plan===snapshot.plan&&finite(s.at)&&s.at<=now&&now-s.at<=7*DAY);
  const latest=samples.at(-1);if(!latest)return unknown;
  if(quotas.some(q=>!finite(q.remaining)))return unknown;
  const fits=[];
  for(const quota of quotas.filter(q=>finite(q.remaining)&&finite(q.resetAt)&&q.resetAt>now)){
    const rows=samples.filter(s=>s.quotaId===quota.id&&s.scope===quota.scope&&s.windowSeconds===quota.windowSeconds&&s.speed===latest.speed&&s.effort===latest.effort);
    const points=rows.reduce((n,s)=>n+s.points,0),requests=rows.reduce((n,s)=>n+s.requests,0);
    if(rows.length<5||points<25||requests<10)return {...unknown,samples:rows.length};
    const ratios=rows.map(s=>s.requests/s.points);
    const low=Math.max(0,Math.floor(Math.max(0,quota.remaining-1)*Math.min(...rows.map(s=>s.requests/(s.points+1)))));
    const high=quota.remaining===0?0:Math.ceil(Math.min(100,quota.remaining+1)*Math.max(...rows.map(s=>s.requests/Math.max(1,s.points-1))));
    fits.push({low,high,samples:rows.length,points,rate:requests/points,spread:Math.max(...ratios)/Math.min(...ratios)});
  }
  if(!fits.length||fits.some(f=>f.spread>2))return unknown;
  return {state:'observed',unit:'similar_requests',low:Math.min(...fits.map(f=>f.low)),high:Math.min(...fits.map(f=>f.high)),samples:Math.min(...fits.map(f=>f.samples)),observedAt:latest.at,speed:latest.speed,effort:latest.effort,workload: Object.fromEntries(['uncached','cached','output'].map(key=>[key,samples.filter(s=>s.speed===latest.speed&&s.effort===latest.effort).reduce((sum,s)=>sum+s.tokens[key],0)/samples.filter(s=>s.speed===latest.speed&&s.effort===latest.effort).reduce((sum,s)=>sum+s.requests,0)])),source:'local_quota_intervals'};
}
export function capacityComparable(estimates) {
  const known=estimates.filter(e=>e?.state==='observed');
  if(!known.length)return false;
  const reference=known[0];
  return known.every(e=>e.speed===reference.speed&&e.effort===reference.effort&&['uncached','cached','output'].every(key=>{
    const values=known.map(row=>row.workload?.[key]);
    if(values.some(value=>!finite(value)))return false;
    return Math.max(...values)<=Math.max(1,Math.min(...values))*1.5;
  }));
}
