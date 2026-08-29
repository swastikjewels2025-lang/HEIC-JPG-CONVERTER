const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const drive = require('./drive');
const converter = require('./converter');
const validator = require('./validator');

// Create temp directory if it doesn't exist
if (!fs.existsSync(config.tempDir)) {
  fs.mkdirSync(config.tempDir, { recursive: true });
}

const MAX_ATTEMPTS = 4;
let activeConversions = 0;
let isGracefulShutdown = false;

// Helper to calculate backoff time
function getBackoffMs(attempts) {
  const backoffs = [60000, 120000, 300000, 900000]; // 1, 2, 5, 15 minutes
  return backoffs[Math.min(attempts - 1, backoffs.length - 1)];
}

/**
 * Adds a candidate file to the persistent SQLite queue.
 */
async function addToQueue(fileId, filename, ext, mimeType, targetFilename) {
  const now = Date.now();
  const sql = `
    INSERT OR IGNORE INTO conversion_queue 
    (file_id, filename, ext, mime_type, target_filename, status, attempts, last_error, created_at, updated_at, next_retry_at)
    VALUES (?, ?, ?, ?, ?, 'PENDING', 0, NULL, ?, ?, 0)
  `;
  await db.run(sql, [fileId, filename, ext, mimeType, targetFilename, now, now]);
}

/**
 * Gets the next pending job from the database, respecting the retry backoff.
 */
async function getNextPendingJob() {
  const now = Date.now();
  const sql = `
    SELECT * FROM conversion_queue 
    WHERE status = 'PENDING' OR (status = 'RETRY_WAIT' AND next_retry_at <= ?)
    ORDER BY created_at ASC 
    LIMIT 1
  `;
  return await db.get(sql, [now]);
}

/**
 * Updates a job status in the SQLite database.
 */
async function updateJobStatus(fileId, status, errorMsg = null) {
  const now = Date.now();
  let sql = '';
  let params = [];

  if (status === 'PROCESSING') {
    sql = `
      UPDATE conversion_queue 
      SET status = ?, started_at = ?, updated_at = ?
      WHERE file_id = ?
    `;
    params = [status, now, now, fileId];
  } else if (status === 'COMPLETED') {
    sql = `
      UPDATE conversion_queue 
      SET status = ?, completed_at = ?, updated_at = ?
      WHERE file_id = ?
    `;
    params = [status, now, now, fileId];
  } else if (status === 'SKIPPED') {
    sql = `
      UPDATE conversion_queue 
      SET status = ?, updated_at = ?
      WHERE file_id = ?
    `;
    params = [status, now, fileId];
  } else {
    logger.error(`Unknown status parameter passed to updateJobStatus: ${status}`);
    return;
  }

  await db.run(sql, params);
}

/**
 * Handles a failed job by updating attempts, choosing whether to retry or fail permanently,
 * and scheduling the next retry.
 */
async function handleJobFailure(fileId, errorMsg) {
  const now = Date.now();
  // Fetch current attempts
  const row = await db.get('SELECT attempts FROM conversion_queue WHERE file_id = ?', [fileId]);
  const newAttempts = (row ? row.attempts : 0) + 1;

  let newStatus = 'RETRY_WAIT';
  let nextRetry = 0;

  if (newAttempts >= MAX_ATTEMPTS) {
    newStatus = 'FAILED';
    logger.error(`Job for file ID ${fileId} failed permanently after ${newAttempts} attempts.`);
  } else {
    const backoff = getBackoffMs(newAttempts);
    nextRetry = now + backoff;
    logger.warn(`Job for file ID ${fileId} set to retry in ${backoff / 1000}s (Attempt ${newAttempts}/${MAX_ATTEMPTS}).`);
  }

  const sql = `
    UPDATE conversion_queue 
    SET status = ?, attempts = ?, last_error = ?, updated_at = ?, next_retry_at = ?
    WHERE file_id = ?
  `;
  await db.run(sql, [newStatus, newAttempts, errorMsg, now, nextRetry, fileId]);
}

/**
 * Cleans up temporary files if they exist on the VPS.
 */
function cleanTempFiles(heicPath, jpgPath) {
  try {
    if (heicPath && fs.existsSync(heicPath)) fs.unlinkSync(heicPath);
    if (jpgPath && fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath);
  } catch (err) {
    logger.warn(`Failed to clean up temp files: ${err.message}`);
  }
}

/**
 * Helper function to run orphaned temp file cleanups on start.
 */
function cleanupOrphanedTempFiles() {
  try {
    if (!fs.existsSync(config.tempDir)) return;
    const files = fs.readdirSync(config.tempDir);
    for (const file of files) {
      const filePath = path.join(config.tempDir, file);
      const stat = fs.statSync(filePath);
      // Delete if file is older than 1 hour
      if (Date.now() - stat.mtimeMs > 3600000) {
        fs.unlinkSync(filePath);
        logger.info(`Cleaned up orphaned temporary file: ${file}`);
      }
    }
  } catch (err) {
    logger.warn(`Orphaned temp files cleanup error: ${err.message}`);
  }
}

/**
 * Core job execution function. Downloads, converts, validates, uploads, verifies, and trashes.
 */
async function processJob(job) {
  const tempHeicPath = path.join(config.tempDir, `${job.file_id}.heic`);
  const tempJpgPath = path.join(config.tempDir, `${job.file_id}.jpg`);

  try {
    await updateJobStatus(job.file_id, 'PROCESSING');
    logger.info(`Processing Job: ${job.filename} (${job.file_id})`);

    // 1. Download file
    logger.info(`Downloading original HEIC file: ${job.filename}...`);
    await drive.downloadFile(job.file_id, tempHeicPath);

    // 2. Convert file
    logger.info(`Converting HEIC file locally...`);
    await converter.convertHeicToJpg(tempHeicPath, tempJpgPath);

    // 3. Validate file
    logger.info(`Validating converted JPG file...`);
    const isValid = validator.validateJpg(tempJpgPath);
    if (!isValid) {
      throw new Error('Local JPG validation checks failed. Image may be corrupted.');
    }

    // 4. Upload file
    logger.info(`Uploading JPG to Google Drive...`);
    const uploadedFile = await drive.uploadFile(job.target_filename, tempJpgPath);
    
    // 5. Verify upload
    logger.info(`Verifying uploaded file exists on Drive: ID ${uploadedFile.id}`);
    const exists = await drive.checkFileExists(uploadedFile.id);
    if (!exists) {
      throw new Error(`Google Drive verification failed: Uploaded file ID ${uploadedFile.id} not found.`);
    }

    // 6. Safe delete original
    if (config.testMode) {
      logger.info(`[TEST MODE] Skipping trashing of original file: ${job.filename}`);
    } else {
      logger.info(`Moving original HEIC file to Google Drive Trash: ${job.filename}`);
      await drive.trashFile(job.file_id);
    }

    // 7. Complete job
    await updateJobStatus(job.file_id, 'COMPLETED');
    logger.info(`Successfully completed job for ${job.filename}`);

  } catch (err) {
    logger.error(`Error processing job for ${job.filename}: `, err);
    await handleJobFailure(job.file_id, err.message);
  } finally {
    cleanTempFiles(tempHeicPath, tempJpgPath);
  }
}

/**
 * Throttled queue loops. Pulls pending items and runs them concurrently up to limits.
 */
async function processQueue() {
  if (isGracefulShutdown) {
    logger.info('Queue processing paused due to graceful shutdown.');
    return;
  }

  if (activeConversions >= config.maxConcurrentConversions) {
    return; // Concurrency limit reached
  }

  try {
    const job = await getNextPendingJob();
    if (!job) {
      return; // No pending or retry-ready jobs
    }

    activeConversions++;
    // Trigger queue processor again for other concurrent slots
    processQueue();

    try {
      await processJob(job);
    } finally {
      activeConversions--;
      // Run loop again to fetch next job
      processQueue();
    }
  } catch (err) {
    logger.error('Error occurred in queue loop: ', err);
  }
}

function shutdown() {
  isGracefulShutdown = true;
  logger.info('Queue shutdown requested. Awaiting active workers...');
}

function getActiveCount() {
  return activeConversions;
}

module.exports = {
  addToQueue,
  processQueue,
  shutdown,
  cleanupOrphanedTempFiles,
  getActiveCount
};
