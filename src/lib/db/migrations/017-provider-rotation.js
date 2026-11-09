export default {
  version: 17,
  name: 'provider-rotation-sequence',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS providerRotationSnapshots (
      connectionId TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS providerRotationCursors (
      scope TEXT PRIMARY KEY, connectionId TEXT NOT NULL, useCount INTEGER NOT NULL
    )`);
  },
};
