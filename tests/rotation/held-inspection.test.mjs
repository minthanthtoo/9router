import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {fileURLToPath} from 'node:url';
const req=createRequire(new URL('../package.json',import.meta.url));
const repo=fileURLToPath(new URL('../../',import.meta.url));
test('historical inspection reports uncertainty without exposing private trace data or starting a worker',async()=>{
 const run={id:'12345678-1234-4234-8234-123456789abc',createdAt:'2026-11-02T19:09:15Z',items:[{state:'unknown',operationId:'op',model:'image'}]};
 globalThis.__heldInspect={run,auth:true};
 const mocks={
  '@/lib/auth/dashboardSession':'export const getDashboardAuthSession=async()=>({sub:"operator"});',
  '@/dashboardGuard':'export const isAuthenticated=async()=>globalThis.__heldInspect.auth;',
  '@/lib/db/repos/imageQuotaIdentity.js':'export const imageQuotaIdentity=()=>"unused";export const imageQuotaIdentityGeneration=()=>0;',
  '@/lib/localDb':'export const getProviderConnections=async()=>[];',
  '@/lib/db/repos/imageQuotaInsights':'export const getImageQuotaModelCatalog=async()=>[];',
  '@/lib/db/repos/imageQuotaRepo':'export const getImageRequestTrace=async()=>({requests:[{router_request_id:"private",submissions:[{outcome:"outcome_unknown",http_status:200,output_count:null,provider_request_id:"private",dispatched_at:"2026-11-02T19:09:17Z"}]}]});',
  '@/lib/db/repos/adminImageTestRuns':'export const readAdminImageRun=async()=>globalThis.__heldInspect.run;export const readUnresolvedImageTargets=async()=>[];export class AdminImageRunError extends Error{};export const createAdminImageRun=()=>{throw Error("no mutation")};export const controlAdminImageRun=createAdminImageRun,reconcileAdminImageRun=createAdminImageRun;',
  '@/sse/services/adminImageTestWorker':'export const startAdminImageTestWorker=()=>{throw Error("worker must not start")};',
 };
 const result=await req('esbuild').build({entryPoints:[repo+'src/app/api/models/image-tests/route.js'],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'held-inspect',setup(build){build.onResolve({filter:/^@\//},a=>({path:a.path,namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'js'}));}}]});
 const mod=new Module(repo+'tests/rotation/held-inspect.cjs');mod.filename=repo+'tests/rotation/held-inspect.cjs';mod._compile(result.outputFiles[0].text,mod.filename);
 try{
  const response=await mod.exports.GET(new Request('http://localhost/api/models/image-tests?id='+run.id)),body=await response.json();assert.equal(response.status,200);
  assert.equal(body.recovery[0].evidence,'outcome_unknown');assert.equal(body.recovery[0].httpStatus,200);assert.equal(body.recovery[0].createdAt,run.createdAt);assert.ok(!JSON.stringify(body).includes('private'));
  globalThis.__heldInspect.auth=false;assert.equal((await mod.exports.GET(new Request('http://localhost/api/models/image-tests?id='+run.id))).status,401);
 }finally{delete globalThis.__heldInspect;}
});
