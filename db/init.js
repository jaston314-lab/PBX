'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        return reject(err);
      }
      return resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        return reject(err);
      }
      return resolve(row);
    });
  });
}

async function initializeDatabase(db) {
  await runAsync(
    db,
    `CREATE TABLE IF NOT EXISTS engineers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      mobile_number TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
      rota_position INTEGER
    )`
  );

  await runAsync(
    db,
    `CREATE TABLE IF NOT EXISTS rota_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      rota_start_date TEXT
    )`
  );

  await runAsync(
    db,
    `CREATE TABLE IF NOT EXISTS rota_overrides (
      override_date TEXT PRIMARY KEY,
      engineer_id INTEGER,
      FOREIGN KEY(engineer_id) REFERENCES engineers(id) ON DELETE SET NULL
    )`
  );

  const tableInfo = await new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(engineers)', (err, rows) => {
      if (err) {
        return reject(err);
      }
      return resolve(rows || []);
    });
  });

  const hasRotaPosition = tableInfo.some((column) => column.name === 'rota_position');
  if (!hasRotaPosition) {
    await runAsync(db, 'ALTER TABLE engineers ADD COLUMN rota_position INTEGER');
  }

  await runAsync(
    db,
    `UPDATE engineers
     SET rota_position = id
     WHERE rota_position IS NULL OR rota_position <= 0`
  );

  await runAsync(
    db,
    `INSERT OR IGNORE INTO rota_config (id, rota_start_date)
     VALUES (1, date('now'))`
  );

  await runAsync(
    db,
    `UPDATE engineers
     SET mobile_number = CASE
       WHEN mobile_number = '15550000001' THEN '+447700900001'
       WHEN mobile_number = '15550000002' THEN '+447700900002'
       WHEN mobile_number = '15550000003' THEN '+447700900003'
       WHEN mobile_number = '15550000004' THEN '+447700900004'
       ELSE mobile_number
     END`
  );
}

async function seedEngineersIfEmpty(db) {
  const row = await getAsync(db, 'SELECT COUNT(*) AS count FROM engineers');

  if (row && row.count > 0) {
    return;
  }

  await runAsync(db, 'BEGIN IMMEDIATE TRANSACTION');

  try {
    const seedData = [
      ['Alice Carter', '+447700900001', 1, 1],
      ['Bruno Hayes', '+447700900002', 0, 2],
      ['Chloe Singh', '+447700900003', 0, 3],
      ['Diego Ramos', '+447700900004', 0, 4]
    ];

    for (const engineer of seedData) {
      await runAsync(
        db,
        'INSERT INTO engineers (name, mobile_number, is_active, rota_position) VALUES (?, ?, ?, ?)',
        engineer
      );
    }

    await runAsync(db, 'COMMIT');
  } catch (err) {
    await runAsync(db, 'ROLLBACK');
    throw err;
  }
}

async function initStandalone() {
  const dataDir = path.join(__dirname, '..', 'data');
  const dbPath = path.join(dataDir, 'router.db');

  fs.mkdirSync(dataDir, { recursive: true });

  const db = new sqlite3.Database(dbPath);

  try {
    await initializeDatabase(db);
    await seedEngineersIfEmpty(db);
    console.log(`Database initialized at ${dbPath}`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  initStandalone().catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
}

module.exports = {
  initializeDatabase,
  seedEngineersIfEmpty
};
