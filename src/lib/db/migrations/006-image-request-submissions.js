import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 7,
  name: "image-request-submissions",
  up(db) {
    const name = "imageQuotaRequestSubmissions";
    db.exec(buildCreateTableSql(name, TABLES[name]));
    for (const index of TABLES[name].indexes || []) db.exec(index);
  },
};
