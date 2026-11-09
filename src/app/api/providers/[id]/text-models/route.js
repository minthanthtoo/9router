import { isAuthenticated } from '@/dashboardGuard';
import { getDashboardAuthSession } from '@/lib/auth/dashboardSession';
import { readTextModelPolicy, commandTextModelPolicy } from '@/lib/db/repos/textModelPolicyRepo.js';
export const dynamic = 'force-dynamic';
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const failed = error => reply({ error: error.status ? error.message : error instanceof SyntaxError ? 'Invalid JSON' : 'Text permission request failed' }, error.status || (error instanceof SyntaxError ? 400 : 500));
const authorized=async request=>await isAuthenticated(request)&&Boolean(await getDashboardAuthSession(request.cookies?.get?.('auth_token')?.value));
export async function GET(request, { params }) {
  if(!await authorized(request))return reply({error:'dashboard_sign_in_required'},401);
  try { return reply(await readTextModelPolicy((await params).id)); }
  catch (error) { return failed(error); }
}
export async function PATCH(request, { params }) {
  if(!await authorized(request))return reply({error:'dashboard_sign_in_required'},401);
  try { const text=await request.text();if(text.length>8192)return reply({error:'body_too_large'},413);return reply(await commandTextModelPolicy((await params).id, JSON.parse(text))); }
  catch (error) { return failed(error); }
}
