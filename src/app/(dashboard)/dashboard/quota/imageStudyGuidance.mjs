export const STUDY_STAGES=[['review','Needs review'],['waiting','Waiting for reset'],['recovered','Recovery observed'],['candidate','Candidates'],['history','Insufficient history']];
export function imageStudyGuidance(row,now=Date.now()){
 const d=row.diagnostics||{},safe=d.safePeriod||{},counts=row.sampleCounts||{};
 const future=row.nextCheck?.at&&Date.parse(row.nextCheck.at)>now;
 const stage=safe.liveUncertainty||(!safe.afterUncertainty&&((counts.outcome_unknown||0)+(counts.in_flight||0)>0))||row.quotaScope?.ambiguous?'review':future?'waiting':d.recovery?.completed?'recovered':d.fits?.length||d.fixedResetFits?.length?'candidate':'history';
 const observedFrom=row.coverage?.firstAt?Date.parse(row.coverage.firstAt):null;
 const recordedDays=Number.isFinite(observedFrom)?Math.max(0,(now-observedFrom)/86400000):0;
 const missing=[['Successes',counts.succeeded||0,6],['Quota refusals',counts.quota_rejected||0,3],['Recoveries',d.recovery?.completed||0,3]].map(([label,value,target])=>({label,value,target,missing:Math.max(0,target-value)}));
 const suggestions=[];
 for(const fit of d.fits||[]){const last=row.evidencePoints?.filter(event=>event.outcome==='succeeded').at(-1);if(last){const at=Date.parse(last.at)+fit.windowRangeSeconds.max*1000;if(at>now&&(!future||at>=Date.parse(row.nextCheck.at)))suggestions.push({at:new Date(at).toISOString(),kind:'Rolling candidate boundary'});}}
 for(const fit of d.fixedResetFits||[]){const anchor=Date.parse(fit.resetAnchorAt),period=fit.periodSeconds*1000;let at=anchor+Math.max(1,Math.floor((now-anchor)/period)+1)*period;if(future&&at<Date.parse(row.nextCheck.at))at+=Math.ceil((Date.parse(row.nextCheck.at)-at)/period)*period;suggestions.push({at:new Date(at).toISOString(),kind:'Fixed candidate boundary'});}
 const boundaries=[...new Map(suggestions.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).map(item=>[item.at,item])).values()].slice(0,4);
 const next=stage==='review'?'Review saved outcomes and quota scope.':stage==='waiting'?'Wait for the recorded check time, then review one eligible check.':d.recovery?.open?'Record the first later success to bound this recovery.':boundaries.length?'Compare outcomes near the candidate boundaries on separate occasions.':missing.some(item=>item.missing)?'Record normal use and a later recovery; avoid repeated tests now.':'Allow a full candidate-window warmup and record irregularly timed use.';
 return {stage,recordedDays,missing,boundaries,next};
}
