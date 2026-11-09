export default {
  version: 14,
  name: "image-quota-identity-history-index",
  up(db) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_iqrs_identity_model_history ON imageQuotaRequestSubmissions(provider, supplierIdentity, identityGeneration, model, dispatchedAt DESC)");
  },
};
