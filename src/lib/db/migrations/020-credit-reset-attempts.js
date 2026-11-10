export default {
  version: 20,
  name: 'credit-reset-attempts',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS providerCreditResetAttempts (
      id TEXT PRIMARY KEY, connectionId TEXT NOT NULL, cycle TEXT, state TEXT NOT NULL, createdAt INTEGER NOT NULL, result TEXT
    )`);
  },
};
