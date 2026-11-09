import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 13,
  name: "image-quota-learning-predictions",
  up(db) {
    const table = "imageQuotaLearningPredictions";
    db.exec(buildCreateTableSql(table, TABLES[table]));
    for (const index of TABLES[table].indexes || []) db.exec(index);
  },
};
