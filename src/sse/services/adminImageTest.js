import { getProviderConnectionById } from "@/lib/localDb";
import { getImageQuotaModelCatalog } from "@/lib/db/repos/imageQuotaInsights.js";
import { getInternalHeaders } from "@/app/api/models/test/ping";
import { handleImageGeneration } from "@/sse/handlers/imageGeneration.js";

const json = (body, status = 200) => Response.json(body, { status });

export async function executeAdminImageTest(request, body) {
  const connection = await getProviderConnectionById(body.connectionId);
  const catalog = await getImageQuotaModelCatalog();
  if (!connection || connection.isActive === false || !catalog.some((item) => item.provider === connection.provider && item.id === body.model && item.capabilities?.generation)) return json({ error: "The selected account or image model is unavailable" }, 422);
  const headers = await getInternalHeaders();
  headers['X-Hualogu-Image-Call-Type'] = 'admin_model_sample';
  if (body.operationId) headers['X-Hualogu-Operation-ID'] = body.operationId;
  const internal = new Request(new URL('/api/v1/images/generations', request.url), {
    method: 'POST', headers, signal: request.signal,
    body: JSON.stringify({ model: `${connection.provider}/${body.model}`, prompt: 'A small blue circle on a white background.', n: 1 }),
  });
  try {
    const response = await handleImageGeneration(internal, { connectionId: connection.id, singleSubmission: true });
    const result = await response.json().catch(() => null);
    const ok = response.ok && Array.isArray(result?.data) && result.data.length > 0;
    const refusals = {
      image_supplier_budget_unavailable: "Test not sent: supplier spend configuration is unavailable.",
      image_supplier_budget_exhausted: "Test not sent: supplier spend limit reached.",
      image_accounting_unavailable: "Test not sent: request accounting is unavailable.",
      image_project_identity_required: "Test not sent: configure the Google Cloud project first.",
      image_pool_paused: "Model turned off: no test sent.",
    };
    const refusal = refusals[result?.error?.code];
    const quotaLimitHit = response.status === 429 && result?.error?.quota_limit_hit === true && !ok;
    const outcomeUnknown = !refusal && (response.status >= 500 || (response.ok && !ok));
    const message = ok ? 'Image returned; dispatch recorded.' : refusal || (outcomeUnknown
      ? 'Outcome unconfirmed. Inspect activity before another request.'
      : response.status === 400 ? 'Provider rejected this test (HTTP 400). The selected model or request is not accepted for this account.'
      : quotaLimitHit ? 'Image quota limit confirmed. Check the recorded reset time.'
      : response.status === 429 ? 'Request refused (HTTP 429); image quota was not confirmed.'
      : `Test refused (HTTP ${response.status}). Check saved routing status.`);
    return json({ ok, failureCode: refusal ? result.error.code : quotaLimitHit ? 'image_quota' : null, quotaLimitHit, notSent: Boolean(refusal), status: response.status, outputCount: ok ? result.data.length : 0, outcomeUnknown,
      requestId: response.headers.get('X-9Router-Request-ID'),
      sharedImageQuota: result?.error?.shared_image_quota === true,
      retryAt: result?.error?.retry_at || null,
      retrySource: result?.error?.availability_source || null,
      retryConfidence: result?.error?.availability_confidence || "unknown",
      message });
  } catch {
    return json({ ok: false, outcomeUnknown: true, message: 'Outcome unconfirmed. Inspect activity before another request.' }, 502);
  }
}
