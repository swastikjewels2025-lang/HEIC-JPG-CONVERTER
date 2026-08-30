const fs = require('fs');
const { execFile } = require('child_process');
const config = require('./config');
const logger = require('./logger');

let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (e) {
  ffmpegPath = null;
}

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  sharp = null;
}

let libheif;
try {
  libheif = require('libheif-js');
} catch (e) {
  libheif = null;
}

let heicDecode;
try {
  heicDecode = require('heic-decode');
} catch (e) {
  heicDecode = null;
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
 * Official libheif-js WASM Decoder + Sharp MozJPEG Encoder
 * Selects highest-resolution primary image (never dark depth map),
 * normalizes to sRGB, and uses 4:4:4 chroma subsampling for zero color artifacts.
 */
async function convertWithLibheifJsSharp(inputPath, outputPath, quality) {
  if (!libheif) throw new Error('libheif-js module not loaded');
  if (!sharp) throw new Error('sharp module not loaded');

  const inputBuffer = await fs.promises.readFile(inputPath);
  const decoder = new libheif.HeifDecoder();
  const data = decoder.decode(inputBuffer);
  if (!data || !data.length) {
    throw new Error('No images found in HEIF file');
  }

  // Find the primary high-resolution image (skips thumbnails & depth maps)
  let primaryImage = data[0];
  for (const img of data) {
    if (img.get_width() > primaryImage.get_width()) {
      primaryImage = img;
    }
  }

  const width = primaryImage.get_width();
  const height = primaryImage.get_height();
  const displayData = {
    data: new Uint8ClampedArray(width * height * 4),
    width: width,
    height: height
  };

  const rawData = await new Promise((resolve, reject) => {
    primaryImage.display(displayData, (result) => {
      if (!result || !result.data) {
        return reject(new Error('Failed to decode HEIF display frame'));
      }
      resolve(result.data);
    });
  });

  const q = Math.max(parseInt(quality, 10) || 95, 92);
  await sharp(Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength), {
    raw: {
      width,
      height,
      channels: 4
    }
  })
    .toColorspace('srgb')
    .jpeg({
      quality: q,
      mozjpeg: true,
      chromaSubsampling: '4:4:4'
    })
    .toFile(outputPath);
}

/**
 * Converts HEIC to JPG using sharp (Node.js native binding).
 */
async function convertWithSharp(inputPath, outputPath, quality) {
  if (!sharp) throw new Error('sharp module not loaded');
  await sharp(inputPath)
    .rotate() // Auto-orient based on EXIF
    .jpeg({ quality: parseInt(quality, 10) || 95, mozjpeg: true, chromaSubsampling: '4:4:4' })
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
 * Converts HEIC to JPG using FFmpeg (Highest color accuracy, zero green/red tile artifacts).
 */
async function convertWithFfmpeg(inputPath, outputPath, quality) {
  const binary = ffmpegPath || 'ffmpeg';
  await runCommand(binary, ['-y', '-i', inputPath, '-frames:v', '1', '-q:v', '2', outputPath]);
}

/**
 * Converts a HEIC file to JPG using a multi-engine fallback strategy:
 * 1. Official libheif-js WASM Decoder + Sharp 4:4:4 Encoder (Primary high-res frame, accurate color, no tile artifacts, no blank depth maps)
 * 2. FFmpeg (Static or system binary)
 * 3. Sharp Direct
 * 4. heic-convert npm
 * 5. heif-convert CLI
 * 6. ImageMagick
 * 
 * @param {string} inputPath Absolute path to the source HEIC file
 * @param {string} outputPath Absolute path to the target JPG file
 * @returns {Promise<string>} Path to the generated JPG file
 */
async function convertHeicToJpg(inputPath, outputPath) {
  const quality = String(config.jpegQuality || 95);
  logger.info(`Starting HEIC conversion (Quality: ${quality}): ${inputPath} -> ${outputPath}`);

  const errors = [];

  // Engine 1: Official libheif-js WASM + Sharp MozJPEG 4:4:4
  if (libheif && sharp) {
    try {
      logger.info('Attempting conversion via libheif-js + Sharp (High-Res Primary Frame, 4:4:4)...');
      await convertWithLibheifJsSharp(inputPath, outputPath, quality);
      logger.info(`Conversion successful via libheif-js + Sharp: ${outputPath}`);
      return outputPath;
    } catch (err) {
      logger.warn(`libheif-js + Sharp attempt failed: ${err.message}. Trying next engine...`);
      errors.push(`libheif-js: ${err.message}`);
    }
  }

  // Engine 2: FFmpeg (Static or System)
  try {
    logger.info('Attempting conversion via FFmpeg...');
    await convertWithFfmpeg(inputPath, outputPath, quality);
    logger.info(`Conversion successful via FFmpeg: ${outputPath}`);
    return outputPath;
  } catch (err) {
    const msg = err.stderr || (err.error && err.error.message) || err.message || err;
    logger.warn(`FFmpeg attempt failed: ${msg}. Trying next engine...`);
    errors.push(`FFmpeg: ${msg}`);
  }

  // Engine 2: Pure WASM Raw HEIC Decode + Sharp 4:4:4 High-Fidelity sRGB Encoder
  if (heicDecode && sharp) {
    try {
      logger.info('Attempting conversion via high-fidelity HEIC Decode + Sharp 4:4:4...');
      await convertWithHeicDecodeSharp(inputPath, outputPath, quality);
      logger.info(`Conversion successful (High Fidelity 4:4:4): ${outputPath}`);
      return outputPath;
    } catch (err) {
      logger.warn(`HEIC Decode + Sharp attempt failed: ${err.message}. Trying next engine...`);
      errors.push(`HeicDecodeSharp: ${err.message}`);
    }
  }

  // Engine 3: Sharp Direct
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

  // Engine 4: heic-convert fallback
  if (heicConvert) {
    try {
      logger.info('Attempting conversion via heic-convert npm...');
      await convertWithHeicConvertNpm(inputPath, outputPath, quality);
      logger.info(`Conversion successful via heic-convert npm: ${outputPath}`);
      return outputPath;
    } catch (err) {
      logger.warn(`heic-convert npm attempt failed: ${err.message}. Trying next engine...`);
      errors.push(`heic-convert-npm: ${err.message}`);
    }
  }

  // Engine 5: heif-convert (CLI)
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

  // Engine 6: ImageMagick
  try {
    logger.info('Attempting conversion via ImageMagick...');
    await convertWithImageMagick(inputPath, outputPath, quality);
    logger.info(`Conversion successful via ImageMagick: ${outputPath}`);
    return outputPath;
  } catch (err) {
    const msg = err.stderr || (err.error && err.error.message) || err;
    logger.warn(`ImageMagick attempt failed: ${msg}.`);
    errors.push(`ImageMagick: ${msg}`);
  }

  // If all failed
  const aggregatedErrors = errors.join(' | ');
  logger.error(`All conversion engines failed for ${inputPath}: ${aggregatedErrors}`);
  throw new Error(`HEIC conversion failed across all engines. Details: ${aggregatedErrors}`);
}

module.exports = {
  convertHeicToJpg
};
