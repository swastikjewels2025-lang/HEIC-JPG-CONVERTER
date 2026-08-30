const fs = require('fs');
const { execFile } = require('child_process');
const config = require('./config');
const logger = require('./logger');

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  sharp = null;
}

let heicConvert;
try {
  heicConvert = require('heic-convert');
} catch (e) {
  heicConvert = null;
}

/**
 * Executes a CLI conversion command wrapped in a Promise.
 */
function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        return reject({ error, stderr, code: error.code });
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Converts HEIC to JPG using sharp (Node.js native binding).
 */
async function convertWithSharp(inputPath, outputPath, quality) {
  if (!sharp) throw new Error('sharp module not loaded');
  await sharp(inputPath)
    .rotate() // Auto-orient based on EXIF
    .jpeg({ quality: parseInt(quality, 10) || 92, mozjpeg: true })
    .toFile(outputPath);
}

/**
 * Converts HEIC to JPG using pure JS/WASM heic-convert npm library.
 */
async function convertWithHeicConvertNpm(inputPath, outputPath, quality) {
  if (!heicConvert) throw new Error('heic-convert npm module not loaded');
  const inputBuffer = await fs.promises.readFile(inputPath);
  const qFloat = Math.min(Math.max((parseInt(quality, 10) || 92) / 100, 0.1), 1.0);
  const outputBuffer = await heicConvert({
    buffer: inputBuffer,
    format: 'JPEG',
    quality: qFloat
  });
  await fs.promises.writeFile(outputPath, outputBuffer);
}

/**
 * Converts HEIC to JPG using heif-convert CLI.
 */
async function convertWithHeifConvert(inputPath, outputPath, quality) {
  await runCommand('heif-convert', ['-q', quality, inputPath, outputPath]);
}

/**
 * Converts HEIC to JPG using ImageMagick (magick or convert).
 */
async function convertWithImageMagick(inputPath, outputPath, quality) {
  try {
    await runCommand('magick', [inputPath, '-quality', quality, outputPath]);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Try older 'convert' binary
      await runCommand('convert', [inputPath, '-quality', quality, outputPath]);
    } else {
      throw err;
    }
  }
}

/**
 * Converts HEIC to JPG using FFmpeg.
 */
async function convertWithFfmpeg(inputPath, outputPath) {
  await runCommand('ffmpeg', ['-y', '-i', inputPath, '-q:v', '2', outputPath]);
}

/**
 * Converts a HEIC file to JPG using a multi-engine fallback strategy:
 * 1. Sharp (Native libvips - supports Apple HDR / alpha channels / fast)
 * 2. heif-convert (libheif-examples)
 * 3. ImageMagick (magick / convert)
 * 4. FFmpeg
 * 
 * @param {string} inputPath Absolute path to the source HEIC file
 * @param {string} outputPath Absolute path to the target JPG file
 * @returns {Promise<string>} Path to the generated JPG file
 */
async function convertHeicToJpg(inputPath, outputPath) {
  const quality = String(config.jpegQuality || 92);
  logger.info(`Starting HEIC conversion (Quality: ${quality}): ${inputPath} -> ${outputPath}`);

  const errors = [];

  // Engine 1: Sharp
  if (sharp) {
    try {
      logger.info('Attempting conversion via Sharp...');
      await convertWithSharp(inputPath, outputPath, quality);
      logger.info(`Conversion successful via Sharp: ${outputPath}`);
      return outputPath;
    } catch (err) {
      logger.warn(`Sharp conversion attempt failed: ${err.message}. Trying next engine...`);
      errors.push(`Sharp: ${err.message}`);
    }
  }

  // Engine 2: Pure Node.js WASM / libde265 (heic-convert npm)
  if (heicConvert) {
    try {
      logger.info('Attempting conversion via heic-convert (Node.js WASM / libde265)...');
      await convertWithHeicConvertNpm(inputPath, outputPath, quality);
      logger.info(`Conversion successful via heic-convert npm: ${outputPath}`);
      return outputPath;
    } catch (err) {
      logger.warn(`heic-convert npm attempt failed: ${err.message}. Trying next engine...`);
      errors.push(`heic-convert-npm: ${err.message}`);
    }
  }

  // Engine 3: heif-convert (CLI)
  try {
    logger.info('Attempting conversion via heif-convert CLI...');
    await convertWithHeifConvert(inputPath, outputPath, quality);
    logger.info(`Conversion successful via heif-convert CLI: ${outputPath}`);
    return outputPath;
  } catch (err) {
    const msg = err.stderr || (err.error && err.error.message) || err;
    logger.warn(`heif-convert CLI attempt failed: ${msg}. Trying next engine...`);
    errors.push(`heif-convert-cli: ${msg}`);
  }

  // Engine 3: ImageMagick
  try {
    logger.info('Attempting conversion via ImageMagick...');
    await convertWithImageMagick(inputPath, outputPath, quality);
    logger.info(`Conversion successful via ImageMagick: ${outputPath}`);
    return outputPath;
  } catch (err) {
    const msg = err.stderr || (err.error && err.error.message) || err;
    logger.warn(`ImageMagick attempt failed: ${msg}. Trying next engine...`);
    errors.push(`ImageMagick: ${msg}`);
  }

  // Engine 4: FFmpeg
  try {
    logger.info('Attempting conversion via FFmpeg...');
    await convertWithFfmpeg(inputPath, outputPath);
    logger.info(`Conversion successful via FFmpeg: ${outputPath}`);
    return outputPath;
  } catch (err) {
    const msg = err.stderr || (err.error && err.error.message) || err;
    logger.warn(`FFmpeg attempt failed: ${msg}.`);
    errors.push(`FFmpeg: ${msg}`);
  }

  // If all failed
  const aggregatedErrors = errors.join(' | ');
  logger.error(`All conversion engines failed for ${inputPath}: ${aggregatedErrors}`);
  throw new Error(`HEIC conversion failed across all engines. Details: ${aggregatedErrors}`);
}

module.exports = {
  convertHeicToJpg
};
