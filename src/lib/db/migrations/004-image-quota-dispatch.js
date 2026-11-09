export default {
  version: 5,
  name: "image-quota-dispatch",
  up(db) {
    const columns = db.all("PRAGMA table_info(imageQuotaProbeLeases)");
    if (!columns.some((column) => column.name === "dispatchedAt")) {
      db.exec("ALTER TABLE imageQuotaProbeLeases ADD COLUMN dispatchedAt TEXT");
      // Old reservations do not distinguish pre-dispatch from in-flight work.
      // Preserve that uncertainty rather than admitting a duplicate on upgrade.
      db.run("UPDATE imageQuotaProbeLeases SET dispatchedAt = createdAt");
    }
  },
};
