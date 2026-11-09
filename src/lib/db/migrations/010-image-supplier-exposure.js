import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 11,
  name: "image-supplier-exposure",
  up(db) {
    for (const name of [
      "imageSupplierBudgets",
      "imageSupplierExposureAllocations",
      "imageSupplierExposureAdjustments",
    ]) {
      db.exec(buildCreateTableSql(name, TABLES[name]));
      for (const index of TABLES[name].indexes || []) db.exec(index);
    }
  },
};
