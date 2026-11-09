import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 9,
  name: "image-submission-quota-fallback",
  up(db) {
    const table = "imageQuotaRequestSubmissions";
    db.exec(buildCreateTableSql(table, TABLES[table]));
    const existing = new Set(db.all(`PRAGMA table_info(${table})`).map((row) => row.name));
    for (const [name, definition] of Object.entries({
      supplierIdentity: "TEXT",
      identityGeneration: "INTEGER",
      quotaObservations: "TEXT",
      quotaLockResolvedAt: "TEXT",
    })) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
    for (const index of TABLES[table].indexes || []) db.exec(index);
  },
};
