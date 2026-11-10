import {getSettings} from '@/lib/localDb';
import {rotationAutomationStatus,startRotationSnapshotRefresh} from '@/shared/services/rotationSnapshotRefresh';
import {getDashboardAuthSession} from '@/lib/auth/dashboardSession';
import {isAuthenticated} from '@/dashboardGuard';
import {readImageRouting,saveImageRouting,ImageRoutingError} from '@/lib/db/repos/imageRoutingRepo';
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
async function authorized(request){return await isAuthenticated(request)&&Boolean(await getDashboardAuthSession(request.cookies?.get?.('auth_token')?.value));}
function fail(error){return json({error:error instanceof TypeError?'invalid_image_routing':error instanceof ImageRoutingError?error.code:'image_routing_unavailable'},error instanceof TypeError?422:error instanceof ImageRoutingError?error.status:503);}
export async function GET(request){if(!await authorized(request))return json({error:'dashboard_sign_in_required'},401);try{const settings=await getSettings();if(new URL(request.url).searchParams.get('view')==='automation')return json({schema:'rotation_automation.v1',automation:rotationAutomationStatus(settings)});return json({schema:'image_routing.v1',...await readImageRouting(),textSequences:Object.fromEntries(Object.entries(settings.providerStrategies||{}).map(([id,value])=>[id,value.rotationSequence||null])),automation:rotationAutomationStatus(settings)});}catch(error){return fail(error);}}
export async function PATCH(request){
 if(!await authorized(request))return json({error:'dashboard_sign_in_required'},401);
 try{const text=await request.text();if(text.length>150000)return json({error:'body_too_large'},413);let body;try{body=JSON.parse(text);}catch{throw new TypeError();}
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['config','revision'].includes(key))||!body.config||typeof body.revision!=='string'||!/^[a-f0-9]{64}$/.test(body.revision))throw new TypeError();
 const result=await saveImageRouting(body.config,body.revision);startRotationSnapshotRefresh();return json({schema:'image_routing.v1',...result});
 }catch(error){return fail(error);}
}
