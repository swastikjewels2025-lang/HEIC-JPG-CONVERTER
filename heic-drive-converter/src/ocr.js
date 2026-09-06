const path = require('path');
const fs = require('fs');
const { createWorker } = require('tesseract.js');
const config = require('./config');
const logger = require('./logger');

let sharp;
try {
  sharp = require('sharp');
  if (sharp) {
    sharp.cache(false);
    sharp.simd(true);
    sharp.concurrency(1);
  }
} catch (e) {
  sharp = null;
}

const OCR_TARGET_WIDTH = 1200;

/**
 * Worker pool to allow concurrent OCR recognition without blocking the entire queue.
 */
class OcrWorkerPool {
  constructor(size = 2) {
    this.poolSize = Math.max(1, size);
    this.availableWorkers = [];
    this.waitingQueue = [];
    this.allWorkers = [];
    this.isInitializing = false;
    this.initPromise = null;
  }

  async init() {
    if (this.initPromise) return this.initPromise;
    this.isInitializing = true;

    this.initPromise = (async () => {
      try {
        const localLangDir = path.resolve(__dirname, '..');
        const workerOptions = fs.existsSync(path.join(localLangDir, 'eng.traineddata'))
          ? { langPath: localLangDir, gzip: false }
          : {};

        const createPromises = [];
        for (let i = 0; i < this.poolSize; i++) {
          createPromises.push((async () => {
            const w = await createWorker('eng', 1, workerOptions);
            await w.setParameters({
              tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.',
              user_defined_dpi: '150'
            });
            return w;
          })());
        }
        this.allWorkers = await Promise.all(createPromises);
        this.availableWorkers = [...this.allWorkers];
        logger.info(`OCR Worker Pool initialized with ${this.allWorkers.length} parallel workers (Offline Local Mode, DPI 150).`);
      } catch (err) {
        logger.error(`Failed to initialize OCR Worker Pool: ${err.message}`);
      } finally {
        this.isInitializing = false;
      }
    })();

    return this.initPromise;
  }

  async acquireWorker() {
    if (this.allWorkers.length === 0) {
      await this.init();
    }

    if (this.availableWorkers.length > 0) {
      return this.availableWorkers.pop();
    }

    return new Promise((resolve) => {
      this.waitingQueue.push(resolve);
    });
  }

  releaseWorker(worker) {
    if (this.waitingQueue.length > 0) {
      const next = this.waitingQueue.shift();
      next(worker);
    } else {
      this.availableWorkers.push(worker);
    }
  }

  async terminateAll() {
    while (this.waitingQueue.length > 0) {
      const resolve = this.waitingQueue.shift();
      resolve(null);
    }
    const promises = this.allWorkers.map(async (w) => {
      try {
        await w.terminate();
      } catch (e) {}
    });
    await Promise.all(promises);
    this.allWorkers = [];
    this.availableWorkers = [];
    this.initPromise = null;
  }
}

const OCR_POOL_SIZE = Math.max(1, Math.min(config.maxConcurrentConversions || 2, 4));
const pool = new OcrWorkerPool(OCR_POOL_SIZE);

/**
 * Complete list of official catalog categories and jewelry prefixes.
 * Sorted by length descending so multi-word and longer prefixes take precedence over shorter substrings.
 */
const JEWELRY_CATALOG_PREFIXES = [
  // Multi-word gold prefixes
  'BN GOLD', 'CP GOLD', 'CS GOLD', 'LS GOLD', 'NS GOLD', 'PS GOLD',
  // 4-5 letters
  'ACCH', 'AADI', 'KADA', 'PAYAL', 'DKDA', 'GKDA', 'DJUM', 'GJUM', 'BALI',
  // 3 letters - Diamond (D)
  'DBN', 'DBR', 'DER', 'DGR', 'DLR', 'DMS', 'DNP', 'DNS', 'DPS', 'DCH', 'DNC', 'DTK', 'DPD',
  // 3 letters - Gold (G)
  'GBN', 'GBR', 'GER', 'GGR', 'GLR', 'GMS', 'GNP', 'GNS', 'GPS', 'GCH', 'GNC', 'GTK', 'GPD',
  // 3-4 letters - General
  'CVD', 'RNG', 'JUM', 'PAY', 'KDA',
  // 2 letters - Require 3+ digits to avoid false-positive reflections
  'BN', 'BR', 'ER', 'GR', 'LR', 'MS', 'NP', 'NS', 'PS', 'CP', 'CS', 'LS', 'TK', 'BA', 'CH', 'NC', 'DP', 'GP', 'PD'
].sort((a, b) => b.length - a.length);

/**
 * False-positive noise words from textures/facets.
 */
const BLACKLIST = new Set([
  'PHOTO', 'IMAGE', 'HEIC', 'JPEG', 'STOCK', 'ARTICLE', 'JEWEL', 
  'CAMERA', 'APPLE', 'IPHONE', 'WIDTH', 'HEIGHT', 'SOOT', 'NN', 'RING', 'GOLD', 'HOP'
]);

/**
 * Normalizes common OCR misreads and spacing variations in jewelry text.
 */
function normalizeOcrText(rawText) {
  if (!rawText) return '';
  let text = rawText.toUpperCase();

  // Normalize common OCR character confusions for jewelry prefix starters (0/O/Q -> D when followed by jewelry code)
  // e.g. 0BR334 -> DBR334, OBR334 -> DBR334, 0MS189 -> DMS189, OMS189 -> DMS189, 0NS -> DNS
  text = text.replace(/\b[0OQ]\s*(BR|MS|NS|ER|GR|LR|PS|BN|NP|CH|NC|TK|PD|KDA|JUM)/g, 'D$1');

  // Normalize separated initial D/G letters: e.g. "D BR 334" or "D.BR 334" or "D-BR" -> "DBR 334"
  text = text.replace(/\b([DG])\s*[.\-_~,;:]*\s*(BN|BR|ER|GR|LR|MS|NP|NS|PS|CH|NC|TK|PD|KDA|JUM)/g, '$1$2');

  // Replace punctuation except within text
  text = text.replace(/[.,;:_~|/\\]+/g, ' ');
  return text;
}

/**
 * Extracts and cleans jewelry tag numbers from recognized text.
 * Matches patterns like DER564, DBR298, DBR336, DMS189, DNS291, DLR1212, CP1148, etc.
 * 
 * @param {string} rawText Raw OCR output
 * @returns {string|null} Normalized tag code or null
 */
function extractTagPattern(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  const normalized = normalizeOcrText(rawText);
  const lines = normalized.split(/[\r\n]+/);

  // Group prefixes by length: 3+ letters first (e.g. DBR, DMS), then 2 letters (e.g. BR, MS)
  const primaryPrefixes = JEWELRY_CATALOG_PREFIXES.filter(p => p.replace(/\s+/g, '').length >= 3);
  const secondaryPrefixes = JEWELRY_CATALOG_PREFIXES.filter(p => p.replace(/\s+/g, '').length < 3);
  const orderedPrefixes = [...primaryPrefixes, ...secondaryPrefixes];

  for (const prefix of orderedPrefixes) {
    const cleanPrefix = prefix.replace(/\s+/g, '');
    const escapedPrefix = prefix.replace(/\s+/g, '\\s*');

    const minDigits = cleanPrefix.length <= 2 ? 3 : 2;
    // Match prefix followed by contiguous digits (prevents merging stray background numbers like "PS1554 8" -> "PS1554")
    const regex = new RegExp(`\\b${escapedPrefix}\\s*[-_]?\\s*(\\d{${minDigits},6})\\b`, 'i');

    for (const line of lines) {
      const match = regex.exec(line);
      if (match) {
        return `${cleanPrefix}${match[1]}`;
      }
    }

    // Ghost character handling (e.g. DERS556 -> DER556)
    if (cleanPrefix.length >= 3) {
      const ghostRegex = new RegExp(`\\b${escapedPrefix}[S\\-_\\s]+(\\d{${minDigits},6})\\b`, 'i');
      for (const line of lines) {
        const match = ghostRegex.exec(line);
        if (match) {
          return `${cleanPrefix}${match[1]}`;
        }
      }

      // Trailing B/S/O/I misread as digit (e.g. DBR32B -> DBR328, DBR32S -> DBR325)
      const trailingSubstRegex = new RegExp(`\\b${escapedPrefix}\\s*[-_]?\\s*(\\d{2,5})([BSOI])\\b`, 'i');
      for (const line of lines) {
        const match = trailingSubstRegex.exec(line);
        if (match) {
          let char = match[2];
          if (char === 'B') char = '8';
          else if (char === 'S') char = '5';
          else if (char === 'O') char = '0';
          else if (char === 'I') char = '1';
          return `${cleanPrefix}${match[1]}${char}`;
        }
      }
    }
  }

  // Priority 2: General jewelry catalog prefix matching
  const generalRegex = /\b([A-Z]{3,5})\s*[-_]?\s*(\d{2,6})\b/;
  for (const line of lines) {
    const match = generalRegex.exec(line);
    if (match) {
      const candidatePrefix = match[1];
      const digits = match[2];
      if (!BLACKLIST.has(candidatePrefix)) {
        for (const known of JEWELRY_CATALOG_PREFIXES) {
          const cleanKnown = known.replace(/\s+/g, '');
          if (cleanKnown.length >= 3 && candidatePrefix.startsWith(cleanKnown)) {
            return `${cleanKnown}${digits}`;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Runs multi-pass targeted local OCR on a converted JPG file to detect jewelry catalog tag numbers.
 * 
 * @param {string} imagePath Absolute path to the local JPG image
 * @returns {Promise<string|null>} Detected tag number or null if none found
 */
async function detectTagFromImage(imagePath) {
  let ocrWorker = null;
  let imageBuffer = null;
  let sharedGrayBuf = null;

  try {
    ocrWorker = await pool.acquireWorker();
    if (!ocrWorker) return null;

    // Read image into memory buffer once to prevent any race condition with temporary file deletion
    try {
      imageBuffer = await fs.promises.readFile(imagePath);
    } catch (readErr) {
      logger.warn(`Failed to read image buffer for OCR: ${readErr.message}`);
      return null;
    }

    let metadata = null;
    let width = 2000;
    let height = 2000;

    if (sharp) {
      try {
        metadata = await sharp(imageBuffer).metadata();
        width = metadata.width || 2000;
        height = metadata.height || 2000;
      } catch (e) {
        metadata = null;
      }
    }

    // Pass 1: Upper/Center Cushion Crop with High-Contrast Binary Thresholding (threshold 175, inverted)
    // Directly targets white printed tags on green velvet cushions/pillows (DBR330, DBR334, DBR340, etc.)
    // Strips out 100% of fabric weave and reflection noise, delivering instant, highly accurate OCR
    if (sharp && metadata) {
      try {
        const cropWidth = Math.max(100, Math.floor(width * 0.85));
        const cropHeight = Math.max(100, Math.floor(height * 0.65));
        const cropLeft = Math.max(0, Math.floor((width - cropWidth) / 2));
        const cropTop = Math.max(0, Math.floor(height * 0.05));

        const cushionCropBuf = await sharp(imageBuffer)
          .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
          .resize({ width: OCR_TARGET_WIDTH, withoutEnlargement: true })
          .grayscale()
          .threshold(175)
          .negate() // Black text on white background
          .toBuffer();

        await ocrWorker.setParameters({ tessedit_pageseg_mode: '11' });
        const { data: { text: cropText } } = await ocrWorker.recognize(cushionCropBuf);
        const tagCrop = extractTagPattern(cropText);
        if (tagCrop) {
          logger.info(`OCR Tag Match (Pass 1 - Velvet Cushion Crop): Found tag '${tagCrop}'`);
          return tagCrop;
        }
      } catch (cropErr) {
        logger.warn(`Pass 1 (Cushion Crop) notice: ${cropErr.message}`);
      }
    }

    // Create single shared grayscale & resized intermediate buffer for Passes 2, 3, and 4
    if (sharp && metadata) {
      try {
        sharedGrayBuf = await sharp(imageBuffer)
          .resize({ width: OCR_TARGET_WIDTH, withoutEnlargement: true })
          .grayscale()
          .toBuffer();
      } catch (sharedErr) {
        logger.warn(`Shared grayscale OCR buffer notice: ${sharedErr.message}`);
        sharedGrayBuf = null;
      }
    }

    // Pass 2: Full-Frame High-Res (width 1200px) with PSM 11 and fallback to PSM 6
    // Handles white label tags, barcode stickers, and overlays anywhere in the image
    try {
      let pass2Input = sharedGrayBuf || imageBuffer;
      if (sharp && sharedGrayBuf) {
        pass2Input = await sharp(sharedGrayBuf)
          .normalise()
          .toBuffer();
      } else if (sharp && metadata) {
        pass2Input = await sharp(imageBuffer)
          .resize({ width: OCR_TARGET_WIDTH, withoutEnlargement: true })
          .grayscale()
          .normalise()
          .toBuffer();
      }

      await ocrWorker.setParameters({ tessedit_pageseg_mode: '11' });
      const { data: { text: textPsm11 } } = await ocrWorker.recognize(pass2Input);
      const tagPsm11 = extractTagPattern(textPsm11);
      if (tagPsm11) {
        logger.info(`OCR Tag Match (Pass 2 - Full-Frame PSM 11): Found tag '${tagPsm11}'`);
        return tagPsm11;
      }

      // Fast fallback to PSM 6 on same buffer if PSM 11 found nothing
      await ocrWorker.setParameters({ tessedit_pageseg_mode: '6' });
      const { data: { text: textPsm6 } } = await ocrWorker.recognize(pass2Input);
      const tagPsm6 = extractTagPattern(textPsm6);
      if (tagPsm6) {
        logger.info(`OCR Tag Match (Pass 2 - Full-Frame PSM 6): Found tag '${tagPsm6}'`);
        return tagPsm6;
      }
    } catch (pass2Err) {
      logger.warn(`Pass 2 (Full Frame) notice: ${pass2Err.message}`);
    }

    // Pass 3: Full-Frame High-Threshold Binary Inversion (threshold 165)
    // Isolates white text on dark velvet, black gloves, or dark display surfaces anywhere on the frame
    if (sharp && metadata) {
      try {
        await new Promise(r => setImmediate(r));
        let thresh165Buf;
        if (sharedGrayBuf) {
          thresh165Buf = await sharp(sharedGrayBuf)
            .threshold(165)
            .negate()
            .toBuffer();
        } else {
          thresh165Buf = await sharp(imageBuffer)
            .resize({ width: OCR_TARGET_WIDTH, withoutEnlargement: true })
            .grayscale()
            .threshold(165)
            .negate()
            .toBuffer();
        }

        await ocrWorker.setParameters({ tessedit_pageseg_mode: '11' });
        const { data: { text: th165Text } } = await ocrWorker.recognize(thresh165Buf);
        const tag165 = extractTagPattern(th165Text);
        if (tag165) {
          logger.info(`OCR Tag Match (Pass 3 - Full-Frame Contrast 165): Found tag '${tag165}'`);
          return tag165;
        }

        // Pass 4: Full-Frame Medium-Threshold Binary Inversion (threshold 125)
        // For lighter/medium cushions (DBR336, DBR298)
        let thresh125Buf;
        if (sharedGrayBuf) {
          thresh125Buf = await sharp(sharedGrayBuf)
            .threshold(125)
            .negate()
            .toBuffer();
        } else {
          thresh125Buf = await sharp(imageBuffer)
            .resize({ width: OCR_TARGET_WIDTH, withoutEnlargement: true })
            .grayscale()
            .threshold(125)
            .negate()
            .toBuffer();
        }

        const { data: { text: th125Text } } = await ocrWorker.recognize(thresh125Buf);
        const tag125 = extractTagPattern(th125Text);
        if (tag125) {
          logger.info(`OCR Tag Match (Pass 4 - Full-Frame Contrast 125): Found tag '${tag125}'`);
          return tag125;
        }
      } catch (prepErr) {
        logger.warn(`Sharp OCR preprocessing passes 3/4 skipped: ${prepErr.message}`);
      }
    }

    return null;
  } catch (err) {
    logger.warn(`OCR text detection failed on ${imagePath}: ${err.message}`);
    return null;
  } finally {
    sharedGrayBuf = null;
    imageBuffer = null;
    if (ocrWorker) {
      pool.releaseWorker(ocrWorker);
    }
  }
}

/**
 * Pre-warms the OCR worker pool at service startup so the first images have zero delay.
 */
function prewarmWorker() {
  pool.init().catch(err => {
    logger.warn(`OCR worker pool prewarm notice: ${err.message}`);
  });
}

/**
 * Terminates all OCR workers on graceful shutdown.
 */
async function terminateWorker() {
  await pool.terminateAll();
}

module.exports = {
  detectTagFromImage,
  extractTagPattern,
  terminateWorker,
  prewarmWorker,
  JEWELRY_CATALOG_PREFIXES
};
