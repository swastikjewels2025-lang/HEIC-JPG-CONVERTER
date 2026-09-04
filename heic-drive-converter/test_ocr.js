const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ocr = require('./src/ocr');

async function runBenchmarkSuite() {
  console.log('\x1b[36m%s\x1b[0m', '=== Running Automatic OCR Speed & Accuracy Benchmark ===\n');

  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const testCases = [
    { label: 'Diamond Ring', tag: 'DGR10278' },
    { label: 'Diamond Earring', tag: 'DER564' },
    { label: 'Diamond Bracelet', tag: 'DBR336' },
    { label: 'Choker Pendant', tag: 'CP1148' },
    { label: 'Diamond Necklace', tag: 'DNS291' }
  ];

  let totalTime = 0;

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const testImgPath = path.join(tempDir, `speed_test_${tc.tag}.jpg`);
    const svg = `<svg width="2000" height="2000"><rect width="100%" height="100%" fill="white"/><text x="50%" y="30%" font-size="80" font-family="Arial" font-weight="bold" fill="black" text-anchor="middle">${tc.tag}</text></svg>`;

    await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toFile(testImgPath);

    const startTime = Date.now();
    const detected = await ocr.detectTagFromImage(testImgPath);
    const elapsed = (Date.now() - startTime) / 1000;
    totalTime += elapsed;

    const status = detected === tc.tag ? '\x1b[32m✔ MATCH\x1b[0m' : `\x1b[31m✖ MISMATCH (Got: ${detected})\x1b[0m`;
    console.log(`[Test ${i + 1}/${testCases.length}] ${tc.label.padEnd(18)} | Tag: ${tc.tag.padEnd(10)} | Result: ${status.padEnd(20)} | Time: \x1b[33m${elapsed.toFixed(2)}s\x1b[0m`);

    if (fs.existsSync(testImgPath)) fs.unlinkSync(testImgPath);
  }

  const avgTime = (totalTime / testCases.length).toFixed(2);
  console.log('\n---------------------------------------------------------');
  console.log(`\x1b[32m✔ Benchmark Complete! Average Detection Time: ${avgTime}s / image\x1b[0m`);
  console.log('---------------------------------------------------------');
}

async function testSingleImage(targetImage) {
  const resolvedPath = path.resolve(targetImage);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`\x1b[31mError: File not found at ${resolvedPath}\x1b[0m`);
    process.exit(1);
  }

  console.log(`\n--- Testing Local OCR on: ${path.basename(resolvedPath)} ---`);
  console.log('Running optimized Tesseract OCR engine...');
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
}

async function main() {
  const targetImage = process.argv[2];
  if (targetImage) {
    await testSingleImage(targetImage);
  } else {
    await runBenchmarkSuite();
  }
  await ocr.terminateWorker();
}

main().catch(err => {
  console.error('Test execution error: ', err);
  process.exit(1);
});
