"use client";

export default function ImageHelp({label, children}) {
  return <details className="image-study-help" onKeyDown={event=>{
    if(event.key==='Escape'){event.preventDefault();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();event.stopPropagation();}
  }}>
    <summary aria-label={`About ${label}`} title={`About ${label}`}><span aria-hidden="true" className="material-symbols-outlined">info</span></summary>
    <div role="note"><strong>{label}</strong><div>{children}</div></div>
  </details>;
}
