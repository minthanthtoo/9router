import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 12,
  name: "image-quota-learning",
  up(db) {
    const table = "imageQuotaRequestSubmissions";
    db.exec(buildCreateTableSql(table, TABLES[table]));
    const columns = new Set(db.all(`PRAGMA table_info(${table})`).map((row) => row.name));
    if (!columns.has("traceScrubbedAt")) db.exec(`ALTER TABLE ${table} ADD COLUMN traceScrubbedAt TEXT`);
    for (const index of TABLES[table].indexes || []) db.exec(index);
  },
};
