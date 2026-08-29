const fs = require('fs');
const sizeOf = require('image-size');
const logger = require('./logger');

/**
 * Validates the output JPG image by verifying it exists, has non-zero size,
 * and can be parsed successfully (can read dimensions).
 * 
 * @param {string} filePath Path to the generated JPG file
 * @returns {boolean} True if the image is valid, false otherwise
 */
function validateJpg(filePath) {
  try {
    // 1. Check if file exists
    if (!fs.existsSync(filePath)) {
      logger.warn(`Validation failed: File does not exist at ${filePath}`);
      return false;
    }

    // 2. Check file size
    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      logger.warn(`Validation failed: File size is 0 bytes at ${filePath}`);
      return false;
    }

    // 3. Attempt to decode image dimensions using image-size
    const dimensions = sizeOf(filePath);
    if (!dimensions || !dimensions.width || !dimensions.height) {
      logger.warn(`Validation failed: Could not read image dimensions for ${filePath}`);
      return false;
    }

    logger.info(`Validation successful: Image is valid (${dimensions.width}x${dimensions.height}, ${stats.size} bytes)`);
    return true;

  } catch (err) {
    logger.warn(`Validation failed with error for ${filePath}: ${err.message}`);
    return false;
  }
}

module.exports = {
  validateJpg
};
