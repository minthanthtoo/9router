export default {
  version: 15,
  name: 'admin-image-test-runs',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS adminImageTestRuns (
      id TEXT PRIMARY KEY, commandKey TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
      state TEXT NOT NULL, itemsJson TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      owner TEXT, leaseUntil INTEGER NOT NULL DEFAULT 0, stopRequested INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    )`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_image_test_active ON adminImageTestRuns((1)) WHERE state IN ('queued','running','stopping','paused','needs_review')");
  },
};
