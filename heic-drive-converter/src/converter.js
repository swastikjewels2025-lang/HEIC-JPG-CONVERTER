const { execFile } = require('child_process');
const config = require('./config');
const logger = require('./logger');

/**
 * Converts a HEIC file to JPG locally using the heif-convert command-line tool.
 * 
 * @param {string} inputPath Absolute path to the source HEIC file
 * @param {string} outputPath Absolute path to the target JPG file
 * @returns {Promise<string>} Path to the generated JPG file
 */
function convertHeicToJpg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const quality = String(config.jpegQuality);
    logger.info(`Starting local HEIC conversion (Quality: ${quality}): ${inputPath} -> ${outputPath}`);
    
    // Spawn heif-convert process safely
    execFile('heif-convert', ['-q', quality, inputPath, outputPath], (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') {
          return reject(new Error(`heif-convert utility was not found. Please ensure 'libheif-examples' is installed on your VPS (run: sudo apt-get install -y libheif-examples)`));
        }
        logger.error(`heif-convert execution error for ${inputPath}:`, error);
        logger.error(`stderr output: ${stderr}`);
        return reject(new Error(`heif-convert failed: ${stderr || error.message}`));
      }
      
      logger.info(`Local HEIC conversion successful: ${outputPath}`);
      resolve(outputPath);
    });
  });
}

module.exports = {
  convertHeicToJpg
};
