const { createWorker } = require('tesseract.js');
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
        const createPromises = [];
        for (let i = 0; i < this.poolSize; i++) {
          createPromises.push((async () => {
            const w = await createWorker('eng');
            await w.setParameters({
              tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.'
            });
            return w;
          })());
        }
        this.allWorkers = await Promise.all(createPromises);
        this.availableWorkers = [...this.allWorkers];
        logger.info(`OCR Worker Pool initialized with ${this.allWorkers.length} parallel workers.`);
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

const pool = new OcrWorkerPool(1);

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
    // Allow digits with optional single spaces between them (e.g. "DBR32 8" -> "DBR328", "DBR 334" -> "DBR334")
    const regex = new RegExp(`\\b${escapedPrefix}\\s*[-_]?\\s*(\\d(?:\\s*\\d){${minDigits - 1},7})\\b`, 'i');

    for (const line of lines) {
      const match = regex.exec(line);
      if (match) {
        const digits = match[1].replace(/\s+/g, '');
        if (digits.length >= minDigits) {
          return `${cleanPrefix}${digits}`;
        }
      }
    }

    // Ghost character handling (e.g. DERS556 -> DER556)
    if (cleanPrefix.length >= 3) {
      const ghostRegex = new RegExp(`\\b${escapedPrefix}[S\\-_\\s]+(\\d(?:\\s*\\d){${minDigits - 1},7})\\b`, 'i');
      for (const line of lines) {
        const match = ghostRegex.exec(line);
        if (match) {
          const digits = match[1].replace(/\s+/g, '');
          return `${cleanPrefix}${digits}`;
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

  // Priority 2: General jewelry catalog prefix matching (prevents random noise like DDOY000)
  const generalRegex = /\b([A-Z]{3,5})\s*[-_]?\s*(\d{2,7})\b/;
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

const fs = require('fs');

/**
 * Runs multi-pass targeted local OCR on a converted JPG file to detect jewelry catalog tag numbers.
 * 
 * @param {string} imagePath Absolute path to the local JPG image
 * @returns {Promise<string|null>} Detected tag number or null if none found
 */
async function detectTagFromImage(imagePath) {
  let ocrWorker = null;
  try {
    ocrWorker = await pool.acquireWorker();
    if (!ocrWorker) return null;

    // Read image into memory buffer once to prevent any race condition with temporary file deletion
    let imageBuffer;
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

    // Pass 1: Upper-Middle 70% Crop (~900px) with PSM 6
    // Reads digital overlays (DER564, DBR298, DMS189, DNS291, DGR10286, DGR10282) in ~0.15s
    try {
      let pass1Input = imageBuffer;
      if (sharp && metadata) {
        pass1Input = await sharp(imageBuffer)
          .extract({
            left: 0,
            top: 0,
            width: width,
            height: Math.floor(height * 0.70)
          })
          .resize({ width: 900, withoutEnlargement: true })
          .grayscale()
          .normalise()
          .toBuffer();
      }

      await ocrWorker.setParameters({ tessedit_pageseg_mode: '6' });
      const { data: { text: textPsm6 } } = await ocrWorker.recognize(pass1Input);
      const tagPsm6 = extractTagPattern(textPsm6);
      if (tagPsm6) {
        logger.info(`OCR Tag Match (Pass 1 - Upper PSM 6): Found tag '${tagPsm6}'`);
        return tagPsm6;
      }
    } catch (pass1Err) {
      logger.warn(`Pass 1 (Upper Focus) notice: ${pass1Err.message}`);
    }

    if (sharp && metadata) {
      try {
        await new Promise(r => setImmediate(r));

        // Pass 2: Center-Middle Band (10% to 75%) Brightness Thresholding
        // Thresholding at 145 strips green velvet & cushion fabric leaving pure white text (e.g. DBR336)
        try {
          const threshBuf = await sharp(imageBuffer)
            .extract({
              left: 0,
              top: Math.floor(height * 0.10),
              width: width,
              height: Math.floor(height * 0.65)
            })
            .resize({ width: 900, withoutEnlargement: true })
            .grayscale()
            .threshold(145)
            .toBuffer();

          const { data: { text: thText6 } } = await ocrWorker.recognize(threshBuf);
          const tagTh6 = extractTagPattern(thText6);
          if (tagTh6) {
            logger.info(`OCR Tag Match (Pass 2 - Threshold PSM 6): Found tag '${tagTh6}'`);
            return tagTh6;
          }
        } catch (pass2Err) {
          logger.warn(`Pass 2 (Threshold) notice: ${pass2Err.message}`);
        }

        await new Promise(r => setImmediate(r));

        // Pass 3: Inverted & Normalized (Cards, rings, dark tags, fan ornaments)
        try {
          const topBuffer = await sharp(imageBuffer)
            .extract({
              left: 0,
              top: Math.floor(height * 0.05),
              width: width,
              height: Math.floor(height * 0.55)
            })
            .resize({ width: 900, withoutEnlargement: true })
            .grayscale()
            .negate()
            .normalise()
            .toBuffer();

          await ocrWorker.setParameters({ tessedit_pageseg_mode: '11' });
          const { data: { text: text3 } } = await ocrWorker.recognize(topBuffer);
          const tag3 = extractTagPattern(text3);
          if (tag3) {
            logger.info(`OCR Tag Match (Pass 3 - Inverted PSM 11): Found tag '${tag3}'`);
            return tag3;
          }
        } catch (pass3Err) {
          logger.warn(`Pass 3 (Inverted) notice: ${pass3Err.message}`);
        }

      } catch (prepErr) {
        logger.warn(`Sharp OCR preprocessing pass skipped: ${prepErr.message}`);
      }
    }

    return null;
  } catch (err) {
    logger.warn(`OCR text detection failed on ${imagePath}: ${err.message}`);
    return null;
  } finally {
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
