"use client";
import {useRef,useState} from 'react';
import {imageManualPolicy} from './imagePolicyCommand.mjs';
import ImageHelp from './ImageHelp';
export default function ImageBulkPermission({accounts,state}){
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');const lock=useRef(false);
 const unique=[...new Map(accounts.map(row=>[`${row.provider}:${row.connectionId}`,row])).values()];
 const allowed=unique.filter(row=>imageManualPolicy(row).state!=='paused').length;
 const apply=async enabled=>{if(lock.current)return;lock.current=true;setBusy(true);let saved=0,failed=0,unknown=false;try{for(const row of unique){if(row.routeState==='identity_required'||(imageManualPolicy(row).state!=='paused')===enabled)continue;const result=await state.togglePolicy(row,null,enabled?'resume':'pause');if(result?.ok)saved++;else failed++;if(result?.unknown){unknown=true;break;}}setNotice(`${saved} saved${failed?` · ${failed} failed`:''}${unknown?' · stopped: check unconfirmed switch':''}.`);}finally{lock.current=false;setBusy(false);}};
 return <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="Bulk image permission"><span className="text-text-muted">{allowed}/{unique.length} accounts allowed{allowed>0&&allowed<unique.length?' · mixed':''}</span><button type="button" className="min-h-9 rounded-lg border border-border px-2 disabled:opacity-40" disabled={busy||!!state.busyId||allowed===unique.length||Object.values(state.drafts).some(d=>d.outcomeUnknown)} onClick={()=>apply(true)}>Allow shown accounts</button><button type="button" className="min-h-9 rounded-lg border border-border px-2 disabled:opacity-40" disabled={busy||!!state.busyId||!allowed||Object.values(state.drafts).some(d=>d.outcomeUnknown)} onClick={()=>apply(false)}>Pause shown accounts</button><ImageHelp label="Bulk image permission"><p>Changes account permission for the shown accounts, once per account. Individual model choices are preserved. Project-required accounts are skipped. Linked credentials may share a policy. Each command is revision-checked separately; an unknown outcome stops this operation.</p></ImageHelp>{notice&&<span role="status">{notice}</span>}</div>;
}
