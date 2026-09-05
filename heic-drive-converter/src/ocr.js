const { createWorker } = require('tesseract.js');
const logger = require('./logger');

let sharp;
try {
  sharp = require('sharp');
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

const pool = new OcrWorkerPool(4);

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
 * Extracts and cleans jewelry tag numbers from recognized text.
 * Matches patterns like DER564, DBR298, DBR336, DMS189, DNS291, DLR1212, CP1148, etc.
 * 
 * @param {string} rawText Raw OCR output
 * @returns {string|null} Normalized tag code or null
 */
function extractTagPattern(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  const cleanText = rawText.toUpperCase().replace(/[.,;:]+/g, ' ');
  const lines = cleanText.split(/[\r\n]+/);

  // Priority 1: Match against the exact official jewelry prefixes
  for (const prefix of JEWELRY_CATALOG_PREFIXES) {
    const cleanPrefix = prefix.replace(/\s+/g, '');
    const escapedPrefix = prefix.replace(/\s+/g, '\\s*');
    
    // For 2-letter prefixes (CP, CS, BN, NS, PS, LS, BR, ER, TK, BA), require 3+ digits to avoid 2-digit reflections
    const minDigits = cleanPrefix.length <= 2 ? 3 : 2;
    const prefixRegex = new RegExp(`\\b${escapedPrefix}\\s*[-_]?\\s*(\\d{${minDigits},7})\\b`, 'i');
    
    for (const line of lines) {
      const match = prefixRegex.exec(line);
      if (match) {
        return `${cleanPrefix}${match[1]}`;
      }
    }

    // Ghost character or letter overlap between prefix and digits (e.g. DERS556 -> DER556)
    if (cleanPrefix.length >= 3) {
      const ghostRegex = new RegExp(`\\b${escapedPrefix}[S\\-_\\s]+(\\d{${minDigits},7})\\b`, 'i');
      for (const line of lines) {
        const match = ghostRegex.exec(line);
        if (match) {
          return `${cleanPrefix}${match[1]}`;
        }
      }
    }
  }

  // Priority 2: General jewelry model format: 3-5 uppercase letters + 2-7 digits (e.g. AADI10286)
  const generalRegex = /\b([A-Z]{3,5})\s*[-_]?\s*(\d{2,7})\b/;
  for (const line of lines) {
    const match = generalRegex.exec(line);
    if (match) {
      let p = match[1];
      const digits = match[2];
      if (!BLACKLIST.has(p)) {
        // If candidate prefix starts with a known catalog prefix (e.g. DERS -> DER), normalize to official prefix
        for (const known of JEWELRY_CATALOG_PREFIXES) {
          const cleanKnown = known.replace(/\s+/g, '');
          if (cleanKnown.length >= 3 && p.startsWith(cleanKnown)) {
            p = cleanKnown;
            break;
          }
        }
        return `${p}${digits}`;
      }
    }
  }

  return null;
}

/**
 * Runs multi-pass targeted local OCR on a converted JPG file to detect the jewelry tag number.
 * 
 * Multi-band targeted scanning:
 * - Pass 1: Upper 60% Crop (~1000px) with PSM 6/11 - Lightning fast (<0.2s), avoids bottom jewelry reflections
 * - Pass 2: Middle-Upper Band (20% to 55%) Brightness Thresholding (170) - Isolates white text from cushion/velvet fabric
 * - Pass 3: Upper Band (8% to 48%) Normalized Inversion with PSM 11 - Detects rings, tags, cards
 * - Pass 4: Middle Bust Red Channel Threshold (160) - Detects necklace tags on dark/velvet bust stands
 * 
 * @param {string} imagePath Absolute path to the local JPG image
 * @returns {Promise<string|null>} Detected tag number or null if none found
 */
async function detectTagFromImage(imagePath) {
  let ocrWorker = null;
  try {
    ocrWorker = await pool.acquireWorker();
    if (!ocrWorker) return null;

    let metadata = null;
    let width = 2000;
    let height = 2000;

    if (sharp) {
      try {
        metadata = await sharp(imagePath).metadata();
        width = metadata.width || 2000;
        height = metadata.height || 2000;
      } catch (e) {
        metadata = null;
      }
    }

    // Pass 1: Upper 60% Focused Crop (~1000px) with PSM 6
    // Eliminates all bottom jewelry reflections (rings, bracelets, chains) and reads overlays in ~0.15s
    try {
      let pass1Input = imagePath;
      if (sharp && metadata) {
        pass1Input = await sharp(imagePath)
          .extract({
            left: 0,
            top: 0,
            width: width,
            height: Math.floor(height * 0.65)
          })
          .resize({ width: 1000, withoutEnlargement: true })
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

      await ocrWorker.setParameters({ tessedit_pageseg_mode: '11' });
      const { data: { text: textPsm11 } } = await ocrWorker.recognize(pass1Input);
      const tagPsm11 = extractTagPattern(textPsm11);
      if (tagPsm11) {
        logger.info(`OCR Tag Match (Pass 1 - Upper PSM 11): Found tag '${tagPsm11}'`);
        return tagPsm11;
      }
    } catch (pass1Err) {
      logger.warn(`Pass 1 (Upper Focus) notice: ${pass1Err.message}`);
    }

    if (sharp && metadata) {
      try {
        // Pass 2: Middle-Upper Band (20% to 55%) Brightness Thresholding
        // Thresholding at 170 strips fabric texture (green velvet, cushion fibers) leaving pure white text
        try {
          const threshBuf = await sharp(imagePath)
            .extract({
              left: Math.floor(width * 0.10),
              top: Math.floor(height * 0.15),
              width: Math.floor(width * 0.80),
              height: Math.floor(height * 0.45)
            })
            .resize({ width: 1000, withoutEnlargement: true })
            .grayscale()
            .threshold(160)
            .toBuffer();

          await ocrWorker.setParameters({ tessedit_pageseg_mode: '6' });
          const { data: { text: thText6 } } = await ocrWorker.recognize(threshBuf);
          const tagTh6 = extractTagPattern(thText6);
          if (tagTh6) {
            logger.info(`OCR Tag Match (Pass 2 - Threshold PSM 6): Found tag '${tagTh6}'`);
            return tagTh6;
          }

          await ocrWorker.setParameters({ tessedit_pageseg_mode: '11' });
          const { data: { text: thText11 } } = await ocrWorker.recognize(threshBuf);
          const tagTh11 = extractTagPattern(thText11);
          if (tagTh11) {
            logger.info(`OCR Tag Match (Pass 2 - Threshold PSM 11): Found tag '${tagTh11}'`);
            return tagTh11;
          }
        } catch (pass2Err) {
          logger.warn(`Pass 2 (Threshold) notice: ${pass2Err.message}`);
        }

        // Pass 3: Upper Band (8% to 48%) Normalized Inversion with PSM 11 (Cards, rings, tags)
        try {
          const topBuffer = await sharp(imagePath)
            .extract({
              left: 0,
              top: Math.floor(height * 0.08),
              width: width,
              height: Math.floor(height * 0.40)
            })
            .resize({ width: 1000, withoutEnlargement: true })
            .grayscale()
            .negate()
            .normalise()
            .toBuffer();

          await ocrWorker.setParameters({ tessedit_pageseg_mode: '11' });
          const { data: { text: text3 } } = await ocrWorker.recognize(topBuffer);
          const tag3 = extractTagPattern(text3);
          if (tag3) {
            logger.info(`OCR Tag Match (Pass 3 - Upper Band Inverted PSM 11): Found tag '${tag3}'`);
            return tag3;
          }
        } catch (pass3Err) {
          logger.warn(`Pass 3 (Upper Band) notice: ${pass3Err.message}`);
        }

        // Pass 4: Middle Bust (20% to 50%) - Red Channel Threshold (Necklaces: CP1148, CP1152)
        try {
          const midA = await sharp(imagePath)
            .extract({
              left: Math.floor(width * 0.15),
              top: Math.floor(height * 0.20),
              width: Math.floor(width * 0.70),
              height: Math.floor(height * 0.30)
            })
            .extractChannel('red')
            .threshold(160)
            .negate()
            .toBuffer();

          await ocrWorker.setParameters({ tessedit_pageseg_mode: '6' });
          const { data: { text: text4 } } = await ocrWorker.recognize(midA);
          const tag4 = extractTagPattern(text4);
          if (tag4) {
            logger.info(`OCR Tag Match (Pass 4 - Middle Red Channel PSM 6): Found tag '${tag4}'`);
            return tag4;
          }
        } catch (pass4Err) {
          logger.warn(`Pass 4 (Middle Red Channel) notice: ${pass4Err.message}`);
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
