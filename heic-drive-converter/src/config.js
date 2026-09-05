const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const config = {
  driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
  credentialsPath: path.resolve(__dirname, '..', process.env.GOOGLE_APPLICATION_CREDENTIALS || 'credentials.json'),
  pollIntervalMs: (parseInt(process.env.POLL_INTERVAL_SECONDS, 10) || 5) * 1000,
  maxConcurrentConversions: parseInt(process.env.MAX_CONCURRENT_CONVERSIONS, 10) || 2,
  testMode: process.env.TEST_MODE !== 'false', // Default to true unless explicitly 'false'
  jpegQuality: parseInt(process.env.JPEG_QUALITY, 10) || 95,
  dbPath: path.resolve(__dirname, '..', process.env.DB_PATH || './data/queue.sqlite'),
  tempDir: path.resolve(__dirname, '..', process.env.TEMP_DIR || './temp')
};

// Validate critical configurations
if (!config.driveFolderId) {
  console.error('\x1b[31m%s\x1b[0m', 'CRITICAL ERROR: GOOGLE_DRIVE_FOLDER_ID is not set in the .env file!');
  process.exit(1);
}

module.exports = config;
