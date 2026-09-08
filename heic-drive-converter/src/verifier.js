const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const drive = require('./drive');
const ocr = require('./ocr');
const validator = require('./validator');
const queue = require('./queue');
const { performance } = require('perf_hooks');

// Verification & Auto-Repair configuration
// Enabled by default; can be disabled via ENABLE_AUTO_REPAIR=false or CLI --no-repair / --dry-run
const ENABLE_AUTO_REPAIR = process.env.ENABLE_AUTO_REPAIR !== 'false';
const VERIFY_THROTTLE_MS = parseInt(process.env.VERIFY_THROTTLE_MS, 10) || 500;
const VERIFY_TEMP_DIR = path.join(config.tempDir, 'verifier');

// Dedicated, isolated OCR pool for verification (Max concurrency = 1)
// Completely isolated from production conversion OCR pool
const verifyOcrPool = new ocr.OcrWorkerPool(1);

let isShuttingDown = false;

// Ensure dedicated verification temp directory exists
if (!fs.existsSync(VERIFY_TEMP_DIR)) {
  fs.mkdirSync(VERIFY_TEMP_DIR, { recursive: true });
}

/**
 * Sleeps for a specified number of milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Checks if the primary conversion queue has active or pending jobs.
 * Ensures the conversion pipeline ALWAYS maintains absolute priority.
 *
 * @returns {Promise<boolean>} True if conversion queue is completely idle
 */
async function isConversionQueueIdle() {
  const row = await db.get(
    "SELECT COUNT(*) as count FROM conversion_queue WHERE status IN ('PENDING', 'PROCESSING')"
  );
  return !row || row.count === 0;
}

/**
 * Checks whether a Drive file is a candidate for conversion verification.
 * Filters out HEIC files, QA files, test artifacts, and non-JPGs.
 *
 * @param {string} filename File name from Google Drive
 * @param {string} mimeType MIME type from Google Drive
 * @returns {boolean}
 */
function isVerifiableJpg(filename, mimeType) {
  if (!filename || typeof filename !== 'string') return false;

  const upper = filename.toUpperCase();

  // Exclude QA, debug, test artifacts, and temporary editor files
  if (upper.startsWith('QA_') || 
      upper.startsWith('TEST_') || 
      upper.startsWith('DEBUG_') || 
      upper.startsWith('._') || 
      upper.startsWith('~')) {
    return false;
  }

  // Must have jpg/jpeg extension
  if (!upper.endsWith('.JPG') && !upper.endsWith('.JPEG')) {
    return false;
  }

  return true;
}

/**
 * Extracts the expected jewelry catalog tag from a filename stem.
 * e.g., 'DER552.jpg' -> 'DER552'
 *       'DER55.jpg' -> 'DER55'
 *       'DBR336_1.jpg' -> 'DBR336'
 *       'IMG_4008.jpg' -> null
 *
 * @param {string} filename Base filename with extension
 * @returns {string|null} Expected tag or null if generic camera filename
 */
function extractExpectedTagFromFilename(filename) {
  if (!filename) return null;

  // Remove extension
  const lastDot = filename.lastIndexOf('.');
  let base = lastDot !== -1 ? filename.substring(0, lastDot) : filename;

  // Strip trailing numeric duplicates e.g. '_1', '_2'
  base = base.replace(/_\d+$/, '').trim().toUpperCase();

  // Check if base matches jewelry tag pattern: prefix followed by digits
  const match = base.match(/^([A-Z\s]+)(\d+)$/);
  if (!match) return null;

  const prefix = match[1].replace(/\s+/g, '');
  const digits = match[2];

  // Verify prefix against catalog prefixes
  const isKnown = ocr.JEWELRY_CATALOG_PREFIXES.some(p => p.replace(/\s+/g, '') === prefix);
  if (!isKnown) return null;

  return `${prefix}${digits}`;
}

/**
 * Verifies an individual converted JPG file downloaded from Google Drive and auto-repairs mismatches.
 *
 * @param {Object} file Google Drive file object { id, name, size, mimeType }
 * @param {Object} options Configuration options { autoRepair }
 * @returns {Promise<Object>} Verification audit result
 */
async function verifySingleFile(file, options = {}) {
  const localPath = path.join(VERIFY_TEMP_DIR, `${file.id}.jpg`);
  const expectedTag = extractExpectedTagFromFilename(file.name);
  const autoRepair = options.autoRepair !== undefined ? options.autoRepair : ENABLE_AUTO_REPAIR;
  const now = Date.now();

  try {
    // 1. Mark status as VERIFYING in audit table
    await db.run(`
      INSERT OR REPLACE INTO verification_audit 
      (file_id, filename, expected_tag, detected_tag, status, mismatch_reason, is_valid_jpg, ocr_time_ms, repaired_filename, conflicting_file_id, verified_at, updated_at)
      VALUES (?, ?, ?, NULL, 'VERIFYING', NULL, 1, 0, NULL, NULL, ?, ?)
    `, [file.id, file.name, expectedTag, now, now]);

    // 2. Download file from Google Drive
    logger.info(`[Verifier] Verifying ${file.name} (ID: ${file.id})...`);
    await drive.downloadFile(file.id, localPath);

    // 3. Conversion Validity Check (Headers, non-zero, dimensions, readable)
    const isValidJpg = await validator.validateJpg(localPath);
    if (!isValidJpg) {
      const reason = 'Corrupt or unreadable JPEG: failed header/dimension checks';
      logger.warn(`[Verifier] ${file.name} -> FAILED (${reason})`);
      await db.run(`
        UPDATE verification_audit 
        SET status = 'FAILED', is_valid_jpg = 0, mismatch_reason = ?, updated_at = ?
        WHERE file_id = ?
      `, [reason, Date.now(), file.id]);
      return { status: 'FAILED', reason, filename: file.name };
    }

    // 4. Run independent OCR on actual downloaded JPG using isolated pool
    const ocrStart = performance.now();
    const rawDetectedTag = await ocr.detectTagFromImage(localPath, verifyOcrPool);
    const ocrTimeMs = performance.now() - ocrStart;
    const detectedTag = rawDetectedTag ? rawDetectedTag.trim().toUpperCase() : null;

    let status = 'REVIEW_REQUIRED';
    let reason = null;
    let repairedFilename = null;
    let conflictingFileId = null;

    // 5. Exact Tag vs Filename Comparison (Strict: Substring matching strictly prohibited)
    if (expectedTag && detectedTag) {
      if (expectedTag === detectedTag) {
        status = 'VERIFIED';
        reason = 'Filename tag exactly matches detected image tag';
        logger.info(`[Verifier] Detected Tag: ${detectedTag} | Filename Tag: ${expectedTag} -> VERIFIED`);
      } else {
        // Tag differs: check detected tag sanity
        const sanity = queue.verifyTagSanity(detectedTag);
        if (sanity.valid) {
          const targetFilename = `${detectedTag}.jpg`;
          logger.info(`[Verifier] MISMATCH: File: ${file.name} | Detected Tag: ${detectedTag} | Expected Filename: ${targetFilename}`);

          if (autoRepair) {
            // Safety Check: Collision / Duplicate Protection on Google Drive
            try {
              const existingFile = await drive.getFileByNameInFolder(targetFilename);
              if (existingFile && existingFile.id !== file.id) {
                // Conflict detected: Target filename already exists on Google Drive
                status = 'REPAIR_CONFLICT';
                conflictingFileId = existingFile.id;
                reason = `Target filename '${targetFilename}' already exists on Google Drive (ID: ${existingFile.id}). Auto-repair skipped to prevent collision.`;
                logger.warn(`[Verifier] REPAIR_CONFLICT: Target already exists: ${targetFilename} (ID: ${existingFile.id}) for file ${file.name}`);
              } else {
                // No conflict: Safe to auto-rename
                logger.info(`[Verifier] AUTO-REPAIR: Renaming: ${file.name} -> ${targetFilename}`);
                await drive.renameFile(file.id, targetFilename);
                drive.updateFilenameInCache(file.name, targetFilename);

                // Post-rename verification: verify file exists on Drive
                const exists = await drive.checkFileExists(file.id);
                if (!exists) {
                  throw new Error(`File ID ${file.id} not verified on Drive after rename`);
                }

                status = 'REPAIRED';
                repairedFilename = targetFilename;
                reason = `Auto-repaired: Renamed from '${file.name}' to '${targetFilename}'`;
                logger.info(`[Verifier] REPAIRED: ${file.name} -> ${targetFilename}`);
              }
            } catch (repairErr) {
              status = 'REPAIR_FAILED';
              reason = `Drive rename failed: ${repairErr.message}`;
              logger.error(`[Verifier] REPAIR_FAILED: File: ${file.name} | Reason: ${repairErr.message}`);
            }
          } else {
            status = 'MISMATCH';
            reason = `Image tag '${detectedTag}' does not match filename tag '${expectedTag}' (Auto-repair disabled)`;
            logger.warn(`[Verifier] ${file.name} -> MISMATCH (Auto-repair disabled)`);
          }
        } else {
          status = 'REVIEW_REQUIRED';
          reason = `Ambiguous tag detected ('${detectedTag}') differs from '${expectedTag}', but failed sanity: ${sanity.reason}`;
          logger.warn(`[Verifier] ${file.name} -> REVIEW_REQUIRED (${reason})`);
        }
      }
    } else if (!expectedTag && detectedTag) {
      // Un-renamed generic camera filename (e.g. IMG_9422.jpg, IMG_4008.jpg) contains a readable tag
      const sanity = queue.verifyTagSanity(detectedTag);
      if (sanity.valid) {
        const targetFilename = `${detectedTag}.jpg`;
        logger.info(`[Verifier] MISMATCH: File: ${file.name} | Detected Tag: ${detectedTag} | Expected Filename: ${targetFilename}`);

        if (autoRepair) {
          try {
            const existingFile = await drive.getFileByNameInFolder(targetFilename);
            if (existingFile && existingFile.id !== file.id) {
              status = 'REPAIR_CONFLICT';
              conflictingFileId = existingFile.id;
              reason = `Target filename '${targetFilename}' already exists on Google Drive (ID: ${existingFile.id}). Auto-repair skipped to prevent collision.`;
              logger.warn(`[Verifier] REPAIR_CONFLICT: Target already exists: ${targetFilename} (ID: ${existingFile.id}) for file ${file.name}`);
            } else {
              logger.info(`[Verifier] AUTO-REPAIR: Renaming: ${file.name} -> ${targetFilename}`);
              await drive.renameFile(file.id, targetFilename);
              drive.updateFilenameInCache(file.name, targetFilename);

              const exists = await drive.checkFileExists(file.id);
              if (!exists) {
                throw new Error(`File ID ${file.id} not verified on Drive after rename`);
              }

              status = 'REPAIRED';
              repairedFilename = targetFilename;
              reason = `Auto-repaired: Renamed un-renamed file '${file.name}' to '${targetFilename}'`;
              logger.info(`[Verifier] REPAIRED: ${file.name} -> ${targetFilename}`);
            }
          } catch (repairErr) {
            status = 'REPAIR_FAILED';
            reason = `Drive rename failed: ${repairErr.message}`;
            logger.error(`[Verifier] REPAIR_FAILED: File: ${file.name} | Reason: ${repairErr.message}`);
          }
        } else {
          status = 'MISMATCH';
          reason = `Un-renamed camera filename contains detected catalog tag '${detectedTag}' (Auto-repair disabled)`;
          logger.warn(`[Verifier] Generic filename '${file.name}' contains detected tag '${detectedTag}' -> MISMATCH`);
        }
      } else {
        status = 'REVIEW_REQUIRED';
        reason = `Un-renamed file produced ambiguous tag '${detectedTag}': ${sanity.reason}`;
      }
    } else if (expectedTag && !detectedTag) {
      // Filename had expected tag, but OCR detected no tag in image
      status = 'NO_TAG_DETECTED';
      reason = `No jewelry catalog tag detected inside image to confirm '${expectedTag}'`;
      logger.warn(`[Verifier] No tag detected in '${file.name}' (expected '${expectedTag}') -> NO_TAG_DETECTED`);
    } else {
      // Neither filename nor image has tag
      status = 'NO_TAG_DETECTED';
      reason = 'No jewelry tag in filename or image';
      logger.info(`[Verifier] No tag in '${file.name}' -> NO_TAG_DETECTED`);
    }

    // 6. Record final audit verdict
    const verifiedAt = Date.now();
    await db.run(`
      UPDATE verification_audit 
      SET detected_tag = ?, status = ?, mismatch_reason = ?, is_valid_jpg = 1, ocr_time_ms = ?, repaired_filename = ?, conflicting_file_id = ?, verified_at = ?, updated_at = ?
      WHERE file_id = ?
    `, [detectedTag, status, reason, ocrTimeMs, repairedFilename, conflictingFileId, verifiedAt, verifiedAt, file.id]);

    return {
      status,
      filename: file.name,
      expectedTag,
      detectedTag,
      repairedFilename,
      conflictingFileId,
      ocrTimeMs,
      reason
    };

  } catch (err) {
    logger.error(`[Verifier] Error verifying file ${file.name}: `, err);
    await db.run(`
      UPDATE verification_audit 
      SET status = 'FAILED', mismatch_reason = ?, updated_at = ?
      WHERE file_id = ?
    `, [err.message, Date.now(), file.id]);
    return { status: 'FAILED', reason: err.message, filename: file.name };
  } finally {
    // Immediate cleanup of temporary verification image
    if (fs.existsSync(localPath)) {
      try {
        fs.unlinkSync(localPath);
      } catch (e) {}
    }
  }
}

/**
 * Runs a complete verification scan across converted JPGs in the Google Drive folder.
 * Implements Architecture C (Idle Gating) + Architecture D (Process & Worker Isolation).
 *
 * @param {Object} options Configuration options { limit, reverifyAll, autoRepair }
 */
async function runVerification(options = {}) {
  const { limit = 0, reverifyAll = false, autoRepair = ENABLE_AUTO_REPAIR } = options;

  logger.info(`=== Starting Folder-Level Converted Image Verification (Auto-Repair: ${autoRepair ? 'ENABLED' : 'DISABLED'}) ===`);
  await db.init();

  // 1. Fetch all files from Google Drive target folder
  logger.info('[Verifier] Scanning Google Drive folder for converted JPGs...');
  let driveFiles = [];
  try {
    driveFiles = await drive.listFolderFiles();
  } catch (err) {
    logger.error('[Verifier] Failed to list Drive folder files: ', err);
    return;
  }

  // 2. Filter to valid converted JPGs
  const jpgCandidates = driveFiles.filter(f => isVerifiableJpg(f.name, f.mimeType));
  logger.info(`[Verifier] Found ${driveFiles.length} total files in Drive, ${jpgCandidates.length} verifiable JPG candidates.`);

  // 3. Query existing verification status from SQLite to guarantee idempotency
  const existingAuditRows = await db.all('SELECT file_id, filename, status FROM verification_audit');
  const auditMap = new Map();
  for (const row of existingAuditRows) {
    auditMap.set(row.file_id, row);
  }

  // 4. Determine queue of unverified files
  const filesToVerify = [];
  for (const file of jpgCandidates) {
    const audit = auditMap.get(file.id);
    if (!reverifyAll && audit && (audit.status === 'VERIFIED' || audit.status === 'REPAIRED')) {
      logger.info(`[Verifier] Skipping already VERIFIED/REPAIRED file: ${file.name}`);
      continue;
    }
    if (!reverifyAll && audit && (audit.status === 'NO_TAG_DETECTED' || audit.status === 'REPAIR_CONFLICT')) {
      logger.info(`[Verifier] Skipping previously audited file: ${file.name} [${audit.status}]`);
      continue;
    }
    filesToVerify.push(file);
  }

  logger.info(`[Verifier] Total files needing verification: ${filesToVerify.length}`);

  const targetFiles = limit > 0 ? filesToVerify.slice(0, limit) : filesToVerify;
  const results = {
    total: targetFiles.length,
    verified: 0,
    repaired: 0,
    repairConflict: 0,
    repairFailed: 0,
    mismatch: 0,
    noTag: 0,
    reviewRequired: 0,
    failed: 0,
    skipped: jpgCandidates.length - targetFiles.length
  };

  // 5. Process files with Idle-Aware Gating and Throttling
  for (let i = 0; i < targetFiles.length; i++) {
    if (isShuttingDown) break;

    const file = targetFiles[i];

    // Gating Check: Ensure conversion queue is idle before each verification file
    let isIdle = await isConversionQueueIdle();
    while (!isIdle && !isShuttingDown) {
      logger.info('[Verifier] Conversion queue active — yielding to conversion workers');
      logger.info('[Verifier] Verification paused');
      await sleep(5000);
      isIdle = await isConversionQueueIdle();
      if (isIdle) {
        logger.info('[Verifier] Conversion queue idle — resuming verification');
      }
    }

    if (isShuttingDown) break;

    logger.info(`[Verifier] [${i + 1}/${targetFiles.length}] Processing ${file.name}...`);
    const res = await verifySingleFile(file, { autoRepair });

    if (res.status === 'VERIFIED') results.verified++;
    else if (res.status === 'REPAIRED') results.repaired++;
    else if (res.status === 'REPAIR_CONFLICT') results.repairConflict++;
    else if (res.status === 'REPAIR_FAILED') results.repairFailed++;
    else if (res.status === 'MISMATCH') results.mismatch++;
    else if (res.status === 'NO_TAG_DETECTED') results.noTag++;
    else if (res.status === 'REVIEW_REQUIRED') results.reviewRequired++;
    else if (res.status === 'FAILED') results.failed++;

    // Throttling: Small sleep between Drive operations to prevent rate limit spikes
    if (VERIFY_THROTTLE_MS > 0 && i < targetFiles.length - 1) {
      await sleep(VERIFY_THROTTLE_MS);
    }
  }

  // 6. Output Final Audit Summary
  console.log('\n=============================================================');
  console.log('            CONVERTED IMAGE VERIFICATION AUDIT REPORT        ');
  console.log('=============================================================');
  console.log(`Total Candidates Found:     ${jpgCandidates.length}`);
  console.log(`Audited in this run:        ${results.total}`);
  console.log(`Skipped (Already Verified): ${results.skipped}`);
  console.log(`VERIFIED (Exact Match):     \x1b[32m${results.verified}\x1b[0m`);
  console.log(`REPAIRED (Auto-Renamed):    \x1b[32m${results.repaired}\x1b[0m`);
  console.log(`REPAIR_CONFLICT:            \x1b[33m${results.repairConflict}\x1b[0m`);
  console.log(`REPAIR_FAILED:              \x1b[31m${results.repairFailed}\x1b[0m`);
  console.log(`MISMATCH (Unrepaired):      \x1b[31m${results.mismatch}\x1b[0m`);
  console.log(`NO_TAG_DETECTED:            \x1b[33m${results.noTag}\x1b[0m`);
  console.log(`REVIEW_REQUIRED:            \x1b[35m${results.reviewRequired}\x1b[0m`);
  console.log(`FAILED (Corrupt/Read Err):  \x1b[31m${results.failed}\x1b[0m`);
  console.log('=============================================================\n');

  return results;
}

/**
 * Prints a formatted audit table from the SQLite verification_audit records.
 */
async function printAuditReport() {
  await db.init();
  const rows = await db.all('SELECT * FROM verification_audit ORDER BY updated_at DESC');

  console.log('\n=== CURRENT VERIFICATION AUDIT DATABASE RECORDS ===\n');
  if (rows.length === 0) {
    console.log('No verification records found in database.\n');
    return;
  }

  console.log(
    'Filename'.padEnd(18) + ' | ' +
    'Expected'.padEnd(10) + ' | ' +
    'Detected'.padEnd(10) + ' | ' +
    'Status'.padEnd(16) + ' | ' +
    'Repaired Name'.padEnd(16) + ' | ' +
    'OCR Time'.padEnd(10) + ' | ' +
    'Reason'
  );
  console.log('-'.repeat(115));

  for (const r of rows) {
    const isSuccess = r.status === 'VERIFIED' || r.status === 'REPAIRED';
    const isWarn = r.status === 'REPAIR_CONFLICT' || r.status === 'NO_TAG_DETECTED' || r.status === 'REVIEW_REQUIRED';
    const color = isSuccess ? '\x1b[32m' : (isWarn ? '\x1b[33m' : '\x1b[31m');
    const reset = '\x1b[0m';
    console.log(
      r.filename.padEnd(18) + ' | ' +
      (r.expected_tag || 'N/A').padEnd(10) + ' | ' +
      (r.detected_tag || 'NONE').padEnd(10) + ' | ' +
      `${color}${r.status.padEnd(16)}${reset} | ` +
      (r.repaired_filename || '-').padEnd(16) + ' | ' +
      `${(r.ocr_time_ms || 0).toFixed(0)} ms`.padEnd(10) + ' | ' +
      (r.mismatch_reason || 'OK')
    );
  }
  console.log('-'.repeat(115) + '\n');
}

/**
 * CLI Entry point
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--report')) {
    await printAuditReport();
    await verifyOcrPool.terminateAll();
    process.exit(0);
  }

  let limit = 0;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10) || 0;
  }

  const reverifyAll = args.includes('--reverify');
  const noRepair = args.includes('--no-repair') || args.includes('--dry-run');
  const autoRepair = noRepair ? false : ENABLE_AUTO_REPAIR;

  const shutdownHandler = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('[Verifier] Graceful shutdown requested...');
    await verifyOcrPool.terminateAll();
    process.exit(0);
  };

  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);

  try {
    await runVerification({ limit, reverifyAll, autoRepair });
  } finally {
    await verifyOcrPool.terminateAll();
  }
}

if (require.main === module) {
  main().catch(err => {
    logger.error('[Verifier] Fatal error: ', err);
    process.exit(1);
  });
}

module.exports = {
  runVerification,
  verifySingleFile,
  isConversionQueueIdle,
  extractExpectedTagFromFilename,
  isVerifiableJpg,
  verifyOcrPool,
  ENABLE_AUTO_REPAIR
};
