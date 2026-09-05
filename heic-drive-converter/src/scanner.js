const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const drive = require('./drive');
const queue = require('./queue');

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
  if (!mimeType) return true; // Generic/unknown allowed
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

async function runScan() {
  logger.info('=== Starting Bulk Scan ===');
  
  // 1. Init DB
  await db.init();
  
  // 2. Fetch Drive folder files
  logger.info('Scanning Google Drive folder...');
  let files;
  try {
    files = await drive.listFolderFiles();
  } catch (err) {
    logger.error('Failed to list files from Google Drive: ', err);
    process.exit(1);
  }
  
  logger.info(`Discovered ${files.length} total files in Drive folder.`);
  
  // 3. Build in-memory map of existing JPG files to optimize duplicate checks
  const existingJpgs = new Map(); // lowercase name -> size
  for (const file of files) {
    const ext = getFileExtension(file.name);
    if (ext === 'jpg' || ext === 'jpeg') {
      existingJpgs.set(file.name.toLowerCase(), parseInt(file.size, 10) || 0);
    }
  }
  
  // 4. Process files and queue candidates
  let candidateCount = 0;
  let skippedCount = 0;
  
  for (const file of files) {
    const ext = getFileExtension(file.name);
    
    // Only convert HEIC
    if (ext !== 'heic') {
      continue;
    }
    
    // Check MIME type
    if (!isHeicCompatibleMime(file.mimeType)) {
      logger.warn(`Skipping '${file.name}' due to incompatible MIME type: ${file.mimeType}`);
      continue;
    }
    
    const targetFilename = getOutputFilename(file.name);
    
    // Check duplicate JPG
    const existingSize = existingJpgs.get(targetFilename.toLowerCase());
    if (existingSize !== undefined && existingSize > 0) {
      skippedCount++;
      if (config.testMode) {
        logger.info(`[TEST MODE] Duplicate found: '${targetFilename}' already exists. Keeping original HEIC: '${file.name}'`);
      } else {
        logger.info(`Duplicate found: '${targetFilename}' already exists. Trashing original HEIC: '${file.name}'...`);
        try {
          await drive.trashFile(file.id);
        } catch (err) {
          logger.error(`Failed to trash duplicate original file ID ${file.id}: `, err);
        }
      }
      continue;
    }
    
    // Add to SQLite queue
    try {
      await queue.addToQueue(file.id, file.name, ext, file.mimeType, targetFilename);
      candidateCount++;
    } catch (dbErr) {
      logger.error(`Failed to add file ${file.name} to DB queue: `, dbErr);
    }
  }
  
  logger.info(`Bulk Scan Complete: Queued ${candidateCount} candidates, skipped ${skippedCount} duplicate files.`);
  
  if (candidateCount === 0) {
    logger.info('No pending files to convert. Exiting scanner.');
    process.exit(0);
  }
  
  // 5. Start queue workers to process the backlog
  logger.info('Starting queue workers to process bulk backlog...');
  queue.processQueue().catch(err => logger.error('Error in bulk queue processing: ', err));
  
  // Keep the process alive and monitor completion status
  const monitorInterval = setInterval(async () => {
    const active = queue.getActiveCount();
    
    // Count remaining pending jobs in DB
    const now = Date.now();
    const row = await db.get(`
      SELECT COUNT(*) as count FROM conversion_queue 
      WHERE status = 'PENDING' OR (status = 'RETRY_WAIT' AND next_retry_at <= ?)
    `, [now]);
    
    const pending = row ? row.count : 0;
    
    logger.info(`Bulk Progress Status: Active workers: ${active} | Remaining pending jobs: ${pending}`);
    
    if (active === 0 && pending === 0) {
      clearInterval(monitorInterval);
      logger.info('All bulk conversion jobs completed. Exiting scanner.');
      db.db.close(() => {
        process.exit(0);
      });
    }
  }, 5000);
}

runScan().catch(err => {
  logger.error('Bulk scan failed with error: ', err);
  process.exit(1);
});
