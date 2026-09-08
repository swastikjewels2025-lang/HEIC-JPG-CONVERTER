const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const config = require('./config');
const logger = require('./logger');

// Ensure database directory exists
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Open SQLite database
const db = new sqlite3.Database(config.dbPath, (err) => {
  if (err) {
    logger.error('Failed to open SQLite database: ', err);
    process.exit(1);
  }
  logger.info(`SQLite database loaded at: ${config.dbPath}`);
});

// Wrap database operations in Promises
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Initialize tables and PRAGMAs
async function init() {
  await run('PRAGMA journal_mode = WAL;');
  await run('PRAGMA busy_timeout = 10000;');
  await run('PRAGMA synchronous = NORMAL;');

  const sql = `
    CREATE TABLE IF NOT EXISTS conversion_queue (
      file_id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      ext TEXT NOT NULL,
      mime_type TEXT,
      target_filename TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      next_retry_at INTEGER DEFAULT 0
    )
  `;
  await run(sql);

  // Auto-recover any orphaned conversion jobs left in PROCESSING state
  const recoverResult = await run("UPDATE conversion_queue SET status = 'PENDING' WHERE status = 'PROCESSING'");
  if (recoverResult && recoverResult.changes > 0) {
    logger.info(`Auto-recovered ${recoverResult.changes} orphaned PROCESSING conversion jobs back to PENDING.`);
  }

  const auditSql = `
    CREATE TABLE IF NOT EXISTS verification_audit (
      file_id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      expected_tag TEXT,
      detected_tag TEXT,
      status TEXT NOT NULL,
      mismatch_reason TEXT,
      is_valid_jpg INTEGER DEFAULT 1,
      ocr_time_ms REAL,
      repaired_filename TEXT,
      conflicting_file_id TEXT,
      verified_at INTEGER,
      updated_at INTEGER
    )
  `;
  await run(auditSql);
  await run('CREATE INDEX IF NOT EXISTS idx_verification_status ON verification_audit(status)');

  // Safely migrate existing databases if columns are missing
  try {
    await run('ALTER TABLE verification_audit ADD COLUMN repaired_filename TEXT');
  } catch (e) {}
  try {
    await run('ALTER TABLE verification_audit ADD COLUMN conflicting_file_id TEXT');
  } catch (e) {}

  // Auto-recover any orphaned verification jobs that were left in VERIFYING state
  await run("UPDATE verification_audit SET status = 'UNVERIFIED' WHERE status = 'VERIFYING'");

  logger.info('Database schema and WAL PRAGMAs verified/initialized successfully.');
}

module.exports = {
  db,
  run,
  get,
  all,
  init
};
