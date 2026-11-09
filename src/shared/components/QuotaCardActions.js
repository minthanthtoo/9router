"use client";
import {useLayoutEffect,useRef} from 'react';
export default function QuotaCardActions({children}){
 const viewport=useRef(null),content=useRef(null);
 useLayoutEffect(()=>{
  const node=viewport.current;let atEnd=true;
  const align=()=>{if(atEnd)node.scrollLeft=node.scrollWidth;};
  const scroll=()=>{atEnd=node.scrollWidth-node.clientWidth-node.scrollLeft<2;};
  align();const observer=new ResizeObserver(align);observer.observe(node);observer.observe(content.current);node.addEventListener('scroll',scroll,{passive:true});
  return()=>{observer.disconnect();node.removeEventListener('scroll',scroll);};
 },[]);
 return <div ref={viewport} role="group" aria-label="Account actions" tabIndex={0} className="quota-account-actions min-w-0 flex-1 overflow-x-auto"><div ref={content} className="ml-auto flex w-max items-center gap-1">{children}</div></div>;
}
