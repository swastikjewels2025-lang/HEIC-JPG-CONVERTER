const path = require('path');
const fs = require('fs');
const ocr = require('./src/ocr');

async function test() {
  const targetImage = process.argv[2];
  if (!targetImage) {
    console.log('Usage: node test_ocr.js <path_to_image.jpg>');
    process.exit(1);
  }

  const resolvedPath = path.resolve(targetImage);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: File not found at ${resolvedPath}`);
    process.exit(1);
  }

  console.log(`\n--- Testing Local OCR on: ${path.basename(resolvedPath)} ---`);
  console.log('Running Tesseract local OCR engine...');
  const startTime = Date.now();

  const tag = await ocr.detectTagFromImage(resolvedPath);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log(`\n=== Results (${elapsed}s) ===`);
  if (tag) {
    console.log(`\x1b[32m✔ SUCCESS: Detected Tag Code -> '${tag}'\x1b[0m`);
    console.log(`Suggested Rename: ${tag}.jpg`);
  } else {
    console.log(`\x1b[33m✖ No specific tag pattern matched.\x1b[0m`);
  }

  await ocr.terminateWorker();
}

test();
