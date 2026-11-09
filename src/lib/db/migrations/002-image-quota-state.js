import { TABLES, buildCreateTableSql } from "../schema.js";

const TABLE_NAMES = ["imageQuotaConstraints", "imageQuotaProbeLeases"];

export default {
  version: 3,
  name: "image-quota-state",
  up(db) {
    for (const name of TABLE_NAMES) {
      db.exec(buildCreateTableSql(name, TABLES[name]));
      for (const index of TABLES[name].indexes || []) db.exec(index);
    }
  },
};
