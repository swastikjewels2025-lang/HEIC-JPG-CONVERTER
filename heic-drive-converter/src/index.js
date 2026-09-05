const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const drive = require('./drive');
const queue = require('./queue');
const ocr = require('./ocr');

function getFileExtension(filename) {
  const parts = filename.split('.');
  if (parts.length > 1) {
    return parts.pop().toLowerCase();
  }
  return '';
}

function getOutputFilename(filename) {
  const lastDotIndex = filename.lastIndexOf('.');
  const nameWithoutExtension = lastDotIndex !== -1 ? filename.substring(0, lastDotIndex) : filename;
  return nameWithoutExtension + '.jpg';
}

function isHeicCompatibleMime(mimeType) {
  if (!mimeType) return true;
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.startsWith('text/') || 
      lowerMime.startsWith('audio/') || 
      lowerMime.startsWith('video/') || 
      lowerMime === 'application/pdf' || 
      lowerMime === 'application/zip' || 
      lowerMime === 'application/json') {
    return false;
  }
  return true;
}

let isChecking = false;

// Scan folder for new files and queue them
async function checkFolder() {
  if (isChecking) return;
  isChecking = true;

  try {
    logger.info('Polling Google Drive folder for updates...');
    const files = await drive.listFolderFiles();
    
    // Build map of existing JPGs
    const existingJpgs = new Map();
    for (const file of files) {
      const ext = getFileExtension(file.name);
      if (ext === 'jpg' || ext === 'jpeg') {
        existingJpgs.set(file.name.toLowerCase(), parseInt(file.size, 10) || 0);
      }
    }

    let addedCount = 0;
    
    for (const file of files) {
      const ext = getFileExtension(file.name);
      if (ext !== 'heic') continue;

      if (!isHeicCompatibleMime(file.mimeType)) continue;

      // Check if file is already in the database queue
      const inQueue = await db.get('SELECT file_id FROM conversion_queue WHERE file_id = ?', [file.id]);
      if (inQueue) continue;

      // Check if duplicate JPG already exists
      const targetFilename = getOutputFilename(file.name);
      const existingSize = existingJpgs.get(targetFilename.toLowerCase());
      if (existingSize !== undefined && existingSize > 0) {
        if (config.testMode) {
          logger.info(`[TEST MODE] Duplicate check: '${targetFilename}' already exists. Keeping '${file.name}'`);
        } else {
          logger.info(`Duplicate check: '${targetFilename}' already exists. Trashing '${file.name}'...`);
          try {
            await drive.trashFile(file.id);
          } catch (err) {
            logger.error(`Failed to trash duplicate original file ID ${file.id}: `, err);
          }
        }
        // Mark as SKIPPED in DB so we don't scan it again
        const now = Date.now();
        await db.run(`
          INSERT INTO conversion_queue 
          (file_id, filename, ext, mime_type, target_filename, status, attempts, last_error, created_at, updated_at, next_retry_at)
          VALUES (?, ?, ?, ?, ?, 'SKIPPED', 0, 'JPG duplicate exists', ?, ?, 0)
        `, [file.id, file.name, ext, file.mimeType, targetFilename, now, now]);
        continue;
      }

      // Add to queue
      try {
        await queue.addToQueue(file.id, file.name, ext, file.mimeType, targetFilename);
        logger.info(`Queued newly detected HEIC: ${file.name} (${file.id})`);
        addedCount++;
      } catch (dbErr) {
        logger.error(`Failed to add file ${file.name} to DB queue: `, dbErr);
      }
    }

    if (addedCount > 0) {
      logger.info(`Detected and queued ${addedCount} new candidate HEIC files.`);
    }

    // Trigger queue processor
    queue.processQueue().catch(err => logger.error('Error starting queue processing: ', err));

  } catch (err) {
    logger.error('Error during periodic folder check: ', err);
  } finally {
    isChecking = false;
  }
}

async function startDaemon() {
  logger.info('=== Starting HEIC to JPG Daemon ===');
  logger.info(`Folder ID: ${config.driveFolderId}`);
  logger.info(`Test Mode: ${config.testMode}`);
  logger.info(`Max Concurrency: ${config.maxConcurrentConversions}`);
  logger.info(`Poll Interval: ${config.pollIntervalMs / 1000}s`);

  // Global uncaught handlers to prevent unexpected process crashes
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception in daemon process: ', err);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection in daemon process: ', reason);
  });

  // Initialize DB
  await db.init();

  // Pre-warm OCR worker in background
  ocr.prewarmWorker();

  // Run startup cleanups
  queue.cleanupOrphanedTempFiles();

  // Run initial folder scan
  await checkFolder();

  // Set up periodic polling
  const intervalId = setInterval(checkFolder, config.pollIntervalMs);

  // Graceful shutdown handling
  async function gracefulShutdown(signal) {
    logger.info(`Received signal ${signal}. Starting graceful shutdown...`);
    clearInterval(intervalId);
    queue.shutdown();

    // Poll active workers until they hit 0 or timeout (10 seconds)
    const timeout = Date.now() + 10000;
    while (queue.getActiveCount() > 0 && Date.now() < timeout) {
      logger.info(`Awaiting completion of ${queue.getActiveCount()} active workers...`);
      await new Promise(r => setTimeout(r, 1000));
    }

    try {
      await ocr.terminateWorker();
    } catch (ocrErr) {
      logger.warn(`Error terminating OCR worker during shutdown: ${ocrErr.message}`);
    }

    logger.info('Closing database connection...');
    db.db.close(() => {
      logger.info('HEIC to JPG Daemon stopped cleanly.');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

startDaemon().catch(err => {
  logger.error('Daemon startup failed: ', err);
  process.exit(1);
});
