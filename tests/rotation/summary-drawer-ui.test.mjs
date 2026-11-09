import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve,extname} from 'node:path';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const req=createRequire(new URL('../package.json',import.meta.url));
const {JSDOM}=req('jsdom'),esbuild=req('esbuild');
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
for(const key of ['window','document','HTMLElement','Event','MutationObserver'])globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const React=req('react'),{render,screen,fireEvent,waitFor,cleanup}=req('@testing-library/react');

test('summary drawers open per row and support touch toggle, hover, Escape and scoped commands',async()=>{
 const result=await esbuild.build({entryPoints:[resolve(repo,'src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable.js')],write:false,bundle:true,format:'cjs',platform:'node',jsx:'automatic',loader:{'.js':'jsx'},plugins:[{name:'fixture',setup(build){
  build.onResolve({filter:/^\.\/utils$/},()=>({path:'utils',namespace:'fixture'}));
  build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const getRemainingPercentage=q=>100-q.used;export const formatResetTime=()=>"1h";',loader:'js'}));
  build.onResolve({filter:/^@\//},a=>({path:resolve(repo,'src',a.path.slice(2)+(extname(a.path)?'':'.js'))}));
  build.onResolve({filter:/^(react|react-dom)(\/.*)?$/},a=>({path:req.resolve(a.path),external:true}));
 }}]});
 const mod=new Module(resolve(repo,'tests/rotation/summary-drawer-bundle.cjs'));
 mod.filename=resolve(repo,'tests/rotation/summary-drawer-bundle.cjs');mod._compile(result.outputFiles[0].text,mod.filename);
 const Table=mod.exports.default,calls=[];
 try{
  render(React.createElement(React.Fragment,null,...['a','b'].map(id=>React.createElement(Table,{key:id,minimal:true,compact:true,quotas:[{name:'Weekly',used:10,total:100}],onRefreshQuota:()=>calls.push(id+':refresh'),onHideQuota:q=>calls.push(id+':hide:'+q.name),onOpenSummaryOptions:()=>calls.push(id+':options')}))));
  const triggers=screen.getAllByRole('button',{name:'Actions for Weekly'});
  assert.notEqual(triggers[0].getAttribute('aria-controls'),triggers[1].getAttribute('aria-controls'));
  assert.equal(screen.queryByRole('button',{name:'Summary display options'}),null);
  fireEvent.click(triggers[0]);
  fireEvent.click(screen.getByRole('button',{name:'Refresh quotas for Weekly'}));
  assert.deepEqual(calls,['a:refresh']);assert.equal(triggers[0].getAttribute('aria-expanded'),'false');
  fireEvent.click(triggers[1]);fireEvent.keyDown(document,{key:'Escape'});
  assert.equal(document.activeElement,triggers[1]);assert.equal(triggers[1].getAttribute('aria-expanded'),'false');
  fireEvent.pointerEnter(triggers[0].closest('.quota-summary-item'));
  await waitFor(()=>assert.equal(triggers[0].getAttribute('aria-expanded'),'true'));
  fireEvent.click(screen.getByRole('button',{name:'Hide quota Weekly'}));assert.equal(calls.at(-1),'a:hide:Weekly');
  fireEvent.click(triggers[1]);fireEvent.click(screen.getByRole('button',{name:'Summary display options'}));assert.equal(calls.at(-1),'b:options');
  fireEvent.click(triggers[1]);fireEvent.pointerDown(document.body);assert.equal(triggers[1].getAttribute('aria-expanded'),'false');
 }finally{cleanup();dom.window.close();}
});
