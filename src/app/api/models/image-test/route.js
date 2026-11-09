import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { isAuthenticated } from "@/dashboardGuard";
import { executeAdminImageTest } from "@/sse/services/adminImageTest";

import { assertImageTargetResolved, AdminImageRunError } from "@/lib/db/repos/adminImageTestRuns";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request) {
  if (!(await isAuthenticated(request)) || !(await getDashboardAuthSession(request.cookies?.get?.("auth_token")?.value))) return json({ error: "Dashboard sign-in required" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid test selection" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !["connectionId", "model"].includes(key))
    || typeof body.connectionId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(body.connectionId)
    || typeof body.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(body.model)) return json({ error: "Select an exact account and catalog model" }, 400);
  try { await assertImageTargetResolved(body.connectionId, body.model); }
  catch (error) { return json({error:error instanceof AdminImageRunError ? error.code : "test_service_unavailable"},error instanceof AdminImageRunError ? error.status : 503); }
  return executeAdminImageTest(request, body);
}
