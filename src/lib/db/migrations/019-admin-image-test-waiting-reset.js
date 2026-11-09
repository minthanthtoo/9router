export default {
  version: 19,
  name: 'admin-image-test-waiting-reset',
  up(db) {
    db.exec('DROP INDEX IF EXISTS idx_admin_image_test_active');
    db.exec("CREATE UNIQUE INDEX idx_admin_image_test_active ON adminImageTestRuns((1)) WHERE state IN ('queued','running','stopping','waiting_reset','paused','needs_review')");
  },
};
