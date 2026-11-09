"use client";
import ImageCardModelGroup from './ImageCardModelGroup';
import ImageTestBatchButton from './ImageTestBatchButton';
import {imageAccountModels} from './imageQuotaTable.mjs';
import {imageNextCheck} from './imageLearningDisplay.mjs';
export {ActivityChart,timeRange} from './ImageActivityChart';
export default function ImageAccountCard({connection,row,state,onOpenAccountSettings,onOpenRotation,onSelectModel,visible=true,selectedModelIds=[],onChooseModels,onRevealSummary,modelInteraction,onHideModel}){
 if(!visible||!row)return null;
 const running=state.tests?.job?.items?.find(item=>item.connectionId===row.connectionId&&item.state==="running");
 const models=imageAccountModels(row,state.catalog),selected=models.filter(entry=>selectedModelIds.includes(entry.model)||!state.model&&entry.model===running?.model);
 const next=imageNextCheck(row);
 const accountRun=state.tests?.job?.items?.some(item=>item.connectionId===row.connectionId);
 return <section className="min-w-0 border-t border-border-subtle px-2 py-1" aria-label={`Images for ${row.accountLabel}`}>
  <div className="quota-card-section-heading flex min-h-8 min-w-0 items-center gap-1.5 text-xs"><span aria-hidden="true" className="material-symbols-outlined text-primary text-base">photo_library</span><strong>Images</strong><span className="shrink-0 text-text-muted">{selected.length}/{models.length}</span><span className="min-w-0 flex-1 truncate text-text-muted" title={next?.at?`${next.source==='learned_window'?'Estimated recovery':'Provider retry'} ${new Date(next.at).toLocaleString()}`:row.routeState?.replaceAll('_',' ')}>{row.routeState==='eligible_unreported'?'Unreported':row.routeState==='quota_blocked'?'Waiting':row.routeState?.replaceAll('_',' ')}</span>{state.tests&&<ImageTestBatchButton compact until429 rows={models.map(entry=>({account:row,entry,model:entry.model}))} label="Test all image models" scope={`${row.accountLabel} · all configured image models`} runner={state.tests} onComplete={state.fetchStatus}/>}{accountRun&&state.tests?.busy&&<button type="button" aria-label={`Stop current image test batch for ${row.accountLabel}`} onClick={state.tests.stop} title="Stop the current server batch after its in-flight request" className="quota-section-menu flex size-7 shrink-0 items-center justify-center text-amber-500"><span aria-hidden="true" className="material-symbols-outlined text-base">stop</span></button>}{onOpenRotation&&<button type="button" aria-label={`Image account rotation for ${row.accountLabel}`} title="Image account rotation" onClick={onOpenRotation} className="quota-section-menu flex size-7 shrink-0 items-center justify-center"><span aria-hidden="true" className="material-symbols-outlined text-base">alt_route</span></button>}<button type="button" aria-label={`Image display options for ${row.accountLabel}`} onClick={onChooseModels} className="quota-section-menu flex size-7 shrink-0 items-center justify-center"><span aria-hidden="true" className="material-symbols-outlined text-base">tune</span></button></div>
  {selected.length>0&&<ImageCardModelGroup connection={connection} row={row} state={state} modelRows={selected} modelInteraction={modelInteraction} onHideModel={onHideModel} onRevealSummary={onRevealSummary} onOpenAccountSettings={onOpenAccountSettings} onSelectModel={onSelectModel}/>}
  {state.error&&<p role="alert" className="text-xs text-amber-500">{state.error}</p>}
 </section>;
}
