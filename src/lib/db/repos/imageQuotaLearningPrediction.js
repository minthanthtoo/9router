import {readImageLearningScope} from "./imageLearningScope.js";
import {wilsonInterval} from "../../../sse/services/imageQuotaStatistics.js";
import { createHash, randomUUID } from "node:crypto";
import { estimateImageQuotaLearning } from "../../../sse/services/imageQuotaLearning.js";

// Older forecasts used dispatch-order recovery counts, so keep their calibration separate.
const ESTIMATOR_VERSION = "rolling-fit.v5";

function identityHash(provider, identity) {
  return createHash("sha256").update(provider + "\0" + identity, "utf8").digest("hex");
}

/** Called inside the submission's existing write transaction; never by dashboard reads. */
export function recordImageQuotaLearningPrediction(db, submission, outcome, now) {
  if (!submission?.supplierIdentity || !Number.isSafeInteger(Number(submission.identityGeneration))
    || !submission.model || !submission.provider || !["succeeded", "quota_rejected"].includes(outcome)) return;

  const fingerprint = identityHash(submission.provider, submission.supplierIdentity);
  const generation = Number(submission.identityGeneration);
  const dispatchedAt = submission.dispatchedAt;
  const selected=readImageLearningScope(db,submission.provider,submission.supplierIdentity,generation,submission.model,{limit:2000});
  if(selected.scope.ambiguous)return;
  const predictionModel=selected.predictionModel;
  const canValidate = ["succeeded", "quota_rejected"].includes(outcome) && dispatchedAt;
  if (canValidate) {
    const eligible = db.all(
      "SELECT id FROM imageQuotaLearningPredictions WHERE provider = ? AND identityHash = ? AND identityGeneration = ? AND model = ? AND estimatorVersion = ? AND outcome = 'open' AND predictedNextCheckAt <= ? AND createdAt < ? ORDER BY createdAt DESC LIMIT 1",
      [submission.provider, fingerprint, generation, predictionModel, ESTIMATOR_VERSION, dispatchedAt, dispatchedAt],
    )[0];
    if (eligible) {
      db.run("UPDATE imageQuotaLearningPredictions SET outcome = ?, resolvedAt = ? WHERE id = ? AND outcome = 'open'",
        [outcome === "succeeded" ? "validated_success" : "validated_rejected", now, eligible.id]);
    }
  }

  if (outcome !== "quota_rejected") return;

  const events=selected.events;
  const learning = estimateImageQuotaLearning(events, { truncated: selected.truncated });
  const estimate = learning.estimate;
  const nextCheck = learning.learnedNextCheck;
  if (estimate.state !== "estimated" || !nextCheck?.at || Date.parse(nextCheck.at) <= Date.parse(now)) return;

  const open = db.all(
    "SELECT id, predictedWindowSeconds, predictedCallLimit, predictedNextCheckAt FROM imageQuotaLearningPredictions " +
      "WHERE provider = ? AND identityHash = ? AND identityGeneration = ? AND model = ? AND estimatorVersion = ? AND outcome = 'open' ORDER BY createdAt DESC LIMIT 1",
    [submission.provider, fingerprint, generation, predictionModel, ESTIMATOR_VERSION],
  )[0];
  if (open && Number(open.predictedWindowSeconds) === estimate.windowSeconds
    && Number(open.predictedCallLimit) === estimate.callLimit && open.predictedNextCheckAt === nextCheck.at) return;
  if (open) db.run("UPDATE imageQuotaLearningPredictions SET outcome = 'superseded', resolvedAt = ? WHERE id = ? AND outcome = 'open'", [now, open.id]);

  db.run(
    "INSERT INTO imageQuotaLearningPredictions " +
      "(id, provider, identityHash, identityGeneration, model, estimatorVersion, evidenceThroughAt, " +
      "predictedWindowSeconds, predictedCallLimit, predictedNextCheckAt, confidence, sampleCount, outcome, createdAt) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'low', ?, 'open', ?)",
    [randomUUID(), submission.provider, fingerprint, generation, predictionModel, ESTIMATOR_VERSION,
      dispatchedAt, estimate.windowSeconds, estimate.callLimit, nextCheck.at, events.length, now],
  );
  db.run(
    "DELETE FROM imageQuotaLearningPredictions WHERE provider = ? AND identityHash = ? AND identityGeneration = ? AND model = ? AND estimatorVersion = ? AND outcome <> 'open' AND createdAt < ?",
    [submission.provider, fingerprint, generation, predictionModel, ESTIMATOR_VERSION,
      new Date(Date.parse(now) - 180 * 86400_000).toISOString()],
  );
}

export function imageQuotaLearningPredictionChecks(db, provider, identity, generation, model) {
  const hash = identityHash(provider, identity);
  const rows = db.all(
    "SELECT outcome, estimatorVersion, COUNT(*) AS count FROM imageQuotaLearningPredictions WHERE provider = ? AND identityHash = ? AND identityGeneration = ? AND model = ? GROUP BY outcome, estimatorVersion",
    [provider, hash, generation, model],
  );
  const counts = Object.fromEntries(rows.filter(row => row.estimatorVersion === ESTIMATOR_VERSION).map((row) => [row.outcome, Number(row.count) || 0]));
  return {
    estimatorVersion: ESTIMATOR_VERSION,
    priorVersionSamples: rows.filter(row => row.estimatorVersion !== ESTIMATOR_VERSION).reduce((sum,row) => sum + Number(row.count || 0),0),
    succeeded: counts.validated_success || 0,
    rejected: counts.validated_rejected || 0,
    open: counts.open || 0,
    superseded: counts.superseded || 0,
    calibration: wilsonInterval(counts.validated_success||0,counts.validated_rejected||0),
  };
}

export function imageQuotaLearningIdentityHash(provider, identity) {
  return identityHash(provider, identity);
}

export const IMAGE_QUOTA_LEARNING_ESTIMATOR_VERSION = ESTIMATOR_VERSION;
