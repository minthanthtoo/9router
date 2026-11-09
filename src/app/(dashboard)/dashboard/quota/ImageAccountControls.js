"use client";
import ImagePolicyToggle from './ImagePolicyToggle';
import ImageCardModelGroup from './ImageCardModelGroup';
import ImageHelp from './ImageHelp';
export default function ImageAccountControls({row,state,modelRows,onSelectModel,onOpenAccountSettings,children}){
 return <section aria-label={`Image controls for ${row.accountLabel}`} className="min-w-0">
  <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle py-2"><strong className="mr-auto text-sm">Images</strong><span className="text-xs text-text-muted">Allow account</span><ImagePolicyToggle row={row} state={state}/><ImageHelp label="Image permissions"><p>Pausing this account preserves each model switch. Restoring the account does not turn on models individually disabled. Provider waits and unresolved jobs remain blocked.{row.linkedCredentialCount>1?` Shared with ${row.linkedCredentialCount} linked credentials.`:''}</p></ImageHelp>{onOpenAccountSettings&&<button type="button" aria-label={`Settings for ${row.accountLabel}`} className="flex size-9 items-center justify-center rounded-lg text-blue-500 hover:bg-blue-500/10" onClick={()=>onOpenAccountSettings(row)}><span aria-hidden="true" className="material-symbols-outlined">settings</span></button>}</div>
  {row.routeState==='identity_required'&&<p role="status" className="py-2 text-xs text-amber-500">Add a project in account settings.</p>}
  <ImageCardModelGroup connection={{id:row.connectionId,provider:row.provider}} row={row} state={state} modelRows={modelRows} onSelectModel={onSelectModel}/>
  {state.notice&&<p role="status" className="text-xs text-text-muted">{state.notice}</p>}{state.error&&<p role="alert" className="text-xs text-amber-500">{state.error}</p>}{children}
 </section>;
}
