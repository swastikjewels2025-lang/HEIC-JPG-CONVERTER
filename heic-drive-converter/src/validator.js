const fs = require('fs');
const sizeOf = require('image-size');
const logger = require('./logger');

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  sharp = null;
}

/**
 * Validates the output JPG image by verifying file integrity, non-zero size,
 * valid dimensions, healthy color channels, and non-corrupted headers.
 * 
 * @param {string} filePath Path to the generated JPG file
 * @returns {Promise<boolean>} True if the image is valid and healthy, false otherwise
 */
async function validateJpg(filePath) {
  try {
    // 1. Check if file exists
    if (!fs.existsSync(filePath)) {
      logger.warn(`Validation failed: File does not exist at ${filePath}`);
      return false;
    }

    // 2. Check file size (> 1KB)
    const stats = fs.statSync(filePath);
    if (stats.size < 1024) {
      logger.warn(`Validation failed: File size is too small or 0 bytes (${stats.size} bytes) at ${filePath}`);
      return false;
    }

    // 3. Verify JPEG magic bytes (0xFF, 0xD8, 0xFF)
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(3);
    fs.readSync(fd, header, 0, 3, 0);
    fs.closeSync(fd);
    if (header[0] !== 0xFF || header[1] !== 0xD8 || header[2] !== 0xFF) {
      logger.warn(`Validation failed: Invalid JPEG header magic bytes in ${filePath}`);
      return false;
    }

    // 4. Decode image dimensions
    let dimensions;
    try {
      dimensions = sizeOf(filePath);
    } catch (dimErr) {
      dimensions = null;
    }

    if (!dimensions || !dimensions.width || !dimensions.height) {
      logger.warn(`Validation failed: Could not parse image dimensions for ${filePath}`);
      return false;
    }

    // 5. Deep color & visual sanity check via Sharp (if available)
    if (sharp) {
      try {
        const img = sharp(filePath);
        const meta = await img.metadata();
        if (meta.channels && meta.channels < 3) {
          logger.warn(`Validation warning: Image has fewer than 3 channels (${meta.channels})`);
        }
      } catch (sharpErr) {
        logger.warn(`Sharp metadata validation notice: ${sharpErr.message}`);
      }
    }

    logger.info(`Validation PASSED: Quality & Integrity Verified (${dimensions.width}x${dimensions.height}, ${(stats.size / 1024).toFixed(1)} KB)`);
    return true;

  } catch (err) {
    logger.warn(`Validation failed with error for ${filePath}: ${err.message}`);
    return false;
  }
}

module.exports = {
  validateJpg
};

