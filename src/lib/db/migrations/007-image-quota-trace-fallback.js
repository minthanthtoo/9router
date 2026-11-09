import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 8,
  name: "image-quota-trace-fallback",
  up(db) {
    const table = "imageQuotaRequestAttempts";
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
