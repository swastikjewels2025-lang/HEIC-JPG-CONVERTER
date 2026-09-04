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

const path = require('path');
const pythonScriptPath = path.join(__dirname, 'convert_heic.py');

/**
 * Converts HEIC to JPG using Python pillow-heif (Industry gold standard for 10-bit HDR Apple HEIC).
 * Normalizes HDR color gamuts, uses subsampling=0 (4:4:4), and guarantees zero green/red tile artifacts.
 */
async function convertWithPythonPillow(inputPath, outputPath, quality) {
  const venvPython = path.join(__dirname, '../venv/bin/python3');
  let pythonCmd = 'python3';
  if (fs.existsSync(venvPython)) {
    pythonCmd = venvPython;
  } else if (process.platform === 'win32') {
    pythonCmd = 'python';
  }
  await runCommand(pythonCmd, [pythonScriptPath, inputPath, outputPath, String(quality || 95)]);
}

let cachedWorkingEngine = null;

/**
 * Converts a HEIC file to JPG using a multi-engine fallback strategy:
 * 1. Python pillow-heif (Artifact-Free HDR & Tile Decoding)
 * 2. Official libheif-js WASM Decoder + Sharp 4:4:4 Encoder
 * 3. FFmpeg (Static or system binary)
 * 4. Pure WASM Raw HEIC Decode + Sharp 4:4:4
 * 5. Sharp Direct
 * 6. heic-convert npm
 * 7. heif-convert CLI
 * 8. ImageMagick
 * 
 * @param {string} inputPath Absolute path to the source HEIC file
 * @param {string} outputPath Absolute path to the target JPG file
 * @returns {Promise<string>} Path to the generated JPG file
 */
async function convertHeicToJpg(inputPath, outputPath) {
  const quality = String(config.jpegQuality || 95);
  logger.info(`Starting HEIC conversion (Quality: ${quality}): ${inputPath} -> ${outputPath}`);

  const engines = [
    {
      name: 'python-pillow',
      fn: () => convertWithPythonPillow(inputPath, outputPath, quality)
    },
    {
      name: 'libheif-js-sharp',
      fn: () => (libheif && sharp ? convertWithLibheifJsSharp(inputPath, outputPath, quality) : Promise.reject(new Error('libheif/sharp not loaded')))
    },
    {
      name: 'ffmpeg',
      fn: () => convertWithFfmpeg(inputPath, outputPath, quality)
    },
    {
      name: 'sharp-direct',
      fn: () => (sharp ? convertWithSharp(inputPath, outputPath, quality) : Promise.reject(new Error('sharp not loaded')))
    },
    {
      name: 'heic-convert-npm',
      fn: () => (heicConvert ? convertWithHeicConvertNpm(inputPath, outputPath, quality) : Promise.reject(new Error('heic-convert not loaded')))
    },
    {
      name: 'heif-convert-cli',
      fn: () => convertWithHeifConvert(inputPath, outputPath, quality)
    },
    {
      name: 'imagemagick',
      fn: () => convertWithImageMagick(inputPath, outputPath, quality)
    }
  ];

  // Fast-path: If we already know which engine works in this environment, try it first
  if (cachedWorkingEngine) {
    const cachedObj = engines.find(e => e.name === cachedWorkingEngine);
    if (cachedObj) {
      try {
        await cachedObj.fn();
        logger.info(`Conversion successful via cached engine [${cachedWorkingEngine}]: ${outputPath}`);
        return outputPath;
      } catch (cachedErr) {
        logger.warn(`Cached engine [${cachedWorkingEngine}] failed: ${cachedErr.message || cachedErr}. Re-testing engines...`);
        cachedWorkingEngine = null;
      }
    }
  }

  const errors = [];

  for (const engine of engines) {
    try {
      logger.info(`Attempting conversion via ${engine.name}...`);
      await engine.fn();
      cachedWorkingEngine = engine.name;
      logger.info(`Conversion successful via ${engine.name} (cached as default): ${outputPath}`);
      return outputPath;
    } catch (err) {
      const msg = err.stderr || (err.error && err.error.message) || err.message || err;
      logger.warn(`${engine.name} attempt failed: ${msg}. Trying next engine...`);
      errors.push(`${engine.name}: ${msg}`);
    }
  }

  // If all failed
  const aggregatedErrors = errors.join(' | ');
  logger.error(`All conversion engines failed for ${inputPath}: ${aggregatedErrors}`);
  throw new Error(`HEIC conversion failed across all engines. Details: ${aggregatedErrors}`);
}

module.exports = {
  convertHeicToJpg
};
