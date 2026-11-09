import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 10,
  name: "image-quota-admission-fallback",
  up(db) {
    const table = "imageQuotaAdmissionState";
    db.exec(buildCreateTableSql(table, TABLES[table]));
    const existing = new Set(db.all(`PRAGMA table_info(${table})`).map((row) => row.name));
    if (!existing.has("quotaObservations")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN quotaObservations ${TABLES[table].columns.quotaObservations}`);
    }
    db.run("INSERT OR IGNORE INTO imageQuotaAdmissionState(id, revision) VALUES(1, 0)");
  },
};
