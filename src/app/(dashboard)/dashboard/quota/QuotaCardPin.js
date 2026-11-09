"use client";
import {useState} from "react";
export default function QuotaCardPin({pinned,name,onToggle}) {
 const [feedback,setFeedback]=useState(false);
 const label=pinned?'Unpin card':'Pin to top';
 return <button type="button" onClick={()=>{setFeedback(true);onToggle();}} aria-pressed={pinned} aria-label={`${pinned?'Unpin':'Pin'} ${name}`} title={`${label} · current page and filters`} className={`quota-card-pin quota-card-pin-corner ${pinned?'is-pinned':''}`}>
  <span key={String(pinned)} className={`quota-pin-feedback ${feedback?'has-feedback':''} ${pinned?'is-pinned':'is-unpinned'}`} aria-hidden="true"><span className="material-symbols-outlined">push_pin</span><span className="quota-pin-spark"/></span>
  <span className="quota-pin-caption" aria-hidden="true">{label}</span>
 </button>;
}
