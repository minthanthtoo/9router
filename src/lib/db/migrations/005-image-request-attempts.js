import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 6,
  name: "image-request-attempts",
  up(db) {
    const name = "imageQuotaRequestAttempts";
    db.exec(buildCreateTableSql(name, TABLES[name]));
    for (const index of TABLES[name].indexes || []) db.exec(index);
  },
};
