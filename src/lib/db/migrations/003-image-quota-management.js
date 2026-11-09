import { TABLES, buildCreateTableSql } from "../schema.js";

const TABLE_NAMES = [
  "imageQuotaPolicies",
  "imageQuotaPolicyAudit",
  "imageQuotaIdempotency",
  "imageQuotaAdmissionState",
];

export default {
  version: 4,
  name: "image-quota-management",
  up(db) {
    for (const name of TABLE_NAMES) {
      db.exec(buildCreateTableSql(name, TABLES[name]));
      for (const index of TABLES[name].indexes || []) db.exec(index);
    }
    db.run("INSERT OR IGNORE INTO imageQuotaAdmissionState(id, revision) VALUES(1, 0)");
  },
};
