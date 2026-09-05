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
  logger.info('Database schema and WAL PRAGMAs verified/initialized successfully.');
}

module.exports = {
  db,
  run,
  get,
  all,
  init
};
