import { getAdapter } from '../driver.js';
import { getModelUpstreamId, PROVIDER_ID_TO_ALIAS } from 'open-sse/config/providerModels.js';

const PERIODS = { '1h': [3600000, 300000], '24h': [86400000, 3600000], '7d': [604800000, 21600000] };
export async function readModelActivity(connection, model, period = '24h', now = Date.now()) {
  if (!PERIODS[period]) throw new TypeError('Invalid activity period');
  const [duration, interval] = PERIODS[period], from = now - duration;
  const startBucket = Math.floor(from / interval) * interval, upstream = getModelUpstreamId(PROVIDER_ID_TO_ALIAS[connection.provider] || connection.provider, model);
  const ids = [...new Set([model, upstream, `${connection.provider}/${model}`, `${connection.provider}/${upstream}`, ...(PROVIDER_ID_TO_ALIAS[connection.provider] ? [`${PROVIDER_ID_TO_ALIAS[connection.provider]}/${model}`, `${PROVIDER_ID_TO_ALIAS[connection.provider]}/${upstream}`] : [])])];
  const db = await getAdapter();
  const rows = db.all(`SELECT CAST(CAST(strftime('%s',timestamp) AS INTEGER) / ? AS INTEGER) AS bucket,
    COUNT(*) AS requests, SUM(COALESCE(promptTokens,0)) AS promptTokens, SUM(COALESCE(completionTokens,0)) AS completionTokens
    FROM usageHistory WHERE connectionId = ? AND provider = ? AND model IN (${ids.map(() => '?').join(',')})
    AND julianday(timestamp) >= julianday(?) AND julianday(timestamp) <= julianday(?) GROUP BY bucket`,
    [interval / 1000, connection.id, connection.provider, ...ids, new Date(from).toISOString(), new Date(now).toISOString()]);
  const lookup = new Map(rows.map(row => [row.bucket, row]));
  const buckets = Array.from({ length: Math.floor((now - startBucket) / interval) + 1 }, (_, index) => {
    const at = startBucket + index * interval, row = lookup.get(Math.floor(at / interval));
    return { at: new Date(at).toISOString(), requests: row?.requests || 0, promptTokens: row?.promptTokens || 0, completionTokens: row?.completionTokens || 0 };
  });
  const total = key => buckets.reduce((sum, row) => sum + row[key], 0);
  return { schema: 'model_activity.v1', observedAt: new Date(now).toISOString(), from: new Date(from).toISOString(), to: new Date(now).toISOString(), scope: { connectionId: connection.id, provider: connection.provider, model }, period, requests: total('requests'), promptTokens: total('promptTokens'), completionTokens: total('completionTokens'), buckets, coverage: 'retained_usage_history' };
}
