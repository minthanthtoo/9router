export default {
  version: 18,
  name: 'account-text-model-permissions',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS textModelPolicies (
      connectionId TEXT PRIMARY KEY, provider TEXT NOT NULL,
      revision INTEGER NOT NULL, disabledModels TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS textModelCommands (
      connectionId TEXT NOT NULL, commandKey TEXT NOT NULL,
      payload TEXT NOT NULL, receipt TEXT NOT NULL,
      PRIMARY KEY(connectionId, commandKey)
    )`);
  },
};
