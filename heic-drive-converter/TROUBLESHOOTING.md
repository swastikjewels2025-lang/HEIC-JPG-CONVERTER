# Troubleshooting & Practical Debugging Manual
## HEIC Drive Converter — Engineering Diagnostics, Root Cause Analysis & Safe Fix Playbook

---

## 1. Overview & Diagnostic Principles

This document serves as the **operational troubleshooting manual** for the HEIC Drive Converter service. Every documented issue adheres to a strict diagnostic structure:

1. **Symptom**: Observable behavior in logs, terminal, or Google Drive folder.
2. **Root Cause**: Deep technical explanation of why the failure occurs.
3. **Where to Check**: Exact file, function, SQLite query, or log line.
4. **How to Diagnose**: Step-by-step CLI and diagnostic commands.
5. **Current Behavior & Implementation**: How the current codebase handles this condition.
6. **Correct Fix**: Specific code modifications if the issue recurs or regresses.
7. **Regression Test**: How to programmatically verify the fix.
8. **Status**: `FIXED`, `PARTIALLY FIXED`, `OPEN`, or `NOT CONFIRMED`.

---

## 2. Known Issues & Operational Playbooks

### Issue 1: Queue Processing Pauses While Unconverted Files Remain
- **Status**: `FIXED`
- **Symptom**: After converting 1 or 2 files, conversion halts. Unconverted HEIC files remain in Google Drive. Queue resumes only when the next Google Drive poll fires (60 seconds later).
- **Root Cause**: **Worker Claim Collision Race Condition**. When multiple concurrent worker loops attempted to claim a job from SQLite at the exact same millisecond, one worker acquired it (`result.changes === 1`) while the other worker received `result.changes === 0`. The colliding worker interpreted `claimNextPendingJob() === null` as an indication that the entire queue was empty and immediately exited (`break`), causing worker starvation.
- **Where to Check**:
  - File: [`src/queue.js`](file:///d:/automation/heic-drive-converter/src/queue.js) $\to$ `workerLoop()` (lines 257–285).
  - Database: `SELECT count(*) FROM conversion_queue WHERE status = 'PENDING';`
- **How to Diagnose**:
  1. Run `npm run status` to inspect `PENDING` vs `PROCESSING` counts.
  2. Check `logs/combined.log` for worker exit messages without corresponding completions.
- **Current Behavior**:
  In `src/queue.js`, when `claimNextPendingJob()` returns `null`, `workerLoop()` queries SQLite for remaining `PENDING` or eligible `RETRY_WAIT` jobs. If pending jobs exist, the worker yields 50 ms and retries the claim rather than terminating:
  ```javascript
  if (!job) {
    const now = Date.now();
    const countRow = await db.get(
      "SELECT COUNT(*) as count FROM conversion_queue WHERE status = 'PENDING' OR (status = 'RETRY_WAIT' AND next_retry_at <= ?)",
      [now]
    );
    if (countRow && countRow.count > 0 && !isGracefulShutdown) {
      await new Promise(r => setTimeout(r, 50));
      continue;
    }
    break;
  }
  ```
- **Correct Fix**:
  Ensure the count verification query and `setTimeout(r, 50)` yield remain in place before any `break` statement in `workerLoop()`.
- **Regression Test**:
  Upload 10 HEIC files simultaneously with `MAX_CONCURRENT_CONVERSIONS=4`. Verify that all 10 files convert continuously in a single burst without pausing between files.

---

### Issue 2: Google Drive Polling Dependency
- **Status**: `FIXED`
- **Symptom**: Backlog conversions only proceed in batches of `MAX_CONCURRENT_CONVERSIONS` every 60 seconds (throttled by `POLL_INTERVAL_SECONDS`).
- **Root Cause**: Queue processing was coupled to the Drive polling event handler instead of running an autonomous worker loop.
- **Where to Check**:
  - File: [`src/index.js`](file:///d:/automation/heic-drive-converter/src/index.js) $\to$ `checkFolder()` (lines 39–114).
  - File: [`src/queue.js`](file:///d:/automation/heic-drive-converter/src/queue.js) $\to$ `processQueue()` and `workerLoop()`.
- **How to Diagnose**:
  Check timestamps in `logs/combined.log`. If consecutive job starts are spaced exactly 60 seconds apart despite pending jobs in SQLite, worker loops are dying prematurely.
- **Current Behavior**:
  `checkFolder()` only discovers new files and inserts them into SQLite. `workerLoop()` runs autonomously, pulling directly from SQLite in a continuous `while (!isGracefulShutdown)` loop until all records are processed.
- **Correct Fix**:
  Maintain decoupling between `checkFolder()` (discovery only) and `workerLoop()` (continuous DB consumption).
- **Regression Test**:
  Run `npm run scan` on a folder with 50+ files. Verify that workers process the entire backlog at full throughput and exit only when remaining pending jobs hit 0.

---

### Issue 3: OCR Failure on Green/Dark Velvet Cushion Backgrounds
- **Status**: `FIXED`
- **Symptom**: Converted JPG is saved with its original iPhone filename (e.g., `IMG_9422.jpg`) instead of the jewelry tag number (`DBR334.jpg`), and logs display `[OCR Notice] No specific jewelry tag detected`.
- **Root Cause**: **Velvet Fabric Weave & Noise Interference**. High-resolution photos taken on velvet cushions contain micro-shadows and reflections from fabric weave. Full-frame OCR with a generic binarization threshold (135) converted the weave texture into speckled noise, obscuring white tag text.
- **Where to Check**:
  - File: [`src/ocr.js`](file:///d:/automation/heic-drive-converter/src/ocr.js) $\to$ `detectTagFromImage()` (lines 268–296).
  - Test Script: `node test_ocr.js <path_to_jpg>`
- **How to Diagnose**:
  Run `node test_ocr.js temp/sample_velvet.jpg`. If Pass 1 fails or returns null, inspect threshold and crop dimensions.
- **Current Behavior**:
  `src/ocr.js` implements a dedicated **Pass 1 Cushion Crop with Threshold 175 Negation**:
  1. Crops upper-center cushion region (85% width, 65% height, top offset 5%).
  2. Resizes to 1200 px width.
  3. Applies `sharp.grayscale().threshold(175).negate()`, converting green velvet cushion texture to pure solid white and white tag text to pure solid black.
  4. Runs Tesseract with `PSM 11` (Sparse Text).
- **Correct Fix**:
  Ensure threshold is set to **175** (not 128 or 135) and negation (`.negate()`) is applied so Tesseract receives black characters on a pure white background.
- **Regression Test**:
  Run `npm run test:speed`. Verify 100% match rate across all test catalog codes (`DBR336`, `DER564`, `DGR10278`, `CP1148`, `DNS291`).

---

### Issue 4: OCR Character Confusion & Ghost Characters
- **Status**: `FIXED`
- **Symptom**: Tag numbers misread: `0BR334` instead of `DBR334`, `DERS556` instead of `DER556`, or `DBR32B` instead of `DBR328`.
- **Root Cause**: Optical distortion, tag skew, and font similarities between `0`/`O`/`D` and `8`/`B`.
- **Where to Check**:
  - File: [`src/ocr.js`](file:///d:/automation/heic-drive-converter/src/ocr.js) $\to$ `normalizeOcrText()` and `extractTagPattern()` (lines 137–231).
- **How to Diagnose**:
  Inspect the raw OCR output string in `src/ocr.js` using debug logs: `logger.info("Raw OCR Text: " + cropText)`.
- **Current Behavior**:
  1. `normalizeOcrText()` replaces `\b[0OQ]\s*(BR|MS|NS|ER|GR|LR|PS|BN|NP|CH|NC|TK|PD|KDA|JUM)` with `D$1`.
  2. Repairs separated initials: `\b([DG])\s*[.\-_~,;:]*\s*(...)` $\to$ `$1$2`.
  3. Ghost character regex: `\\b${cleanPrefix}[S\\-_\\s]+(\\d{2,6})\\b` extracts clean prefix and digits.
  4. Trailing character substitution regex: replaces trailing `B` with `8`, `S` with `5`, `O` with `0`, `I` with `1`.
- **Correct Fix**:
  Maintain prefix normalization rules and trailing character regex replacements in `src/ocr.js`.
- **Regression Test**:
  Pass raw strings `'0BR334'`, `'OBR334'`, `'D.BR 334'`, `'DERS556'`, and `'DBR32B'` to `extractTagPattern()`. Verify all return normalized targets (`DBR334`, `DER556`, `DBR328`).

---

### Issue 5: Duplicate Filename Collisions on Google Drive
- **Status**: `FIXED`
- **Symptom**: Multiple photos containing the same jewelry tag (e.g., front and back angle of `DBR334`) overwrite each other in Google Drive.
- **Root Cause**: Uploading with a static filename (`DBR334.jpg`) without checking if that name already exists in the destination folder.
- **Where to Check**:
  - File: [`src/drive.js`](file:///d:/automation/heic-drive-converter/src/drive.js) $\to$ `getUniqueFilenameInFolder()` (lines 223–241).
- **How to Diagnose**:
  Check Google Drive folder for missing images or check `folderFilenameCache` contents.
- **Current Behavior**:
  `getUniqueFilenameInFolder()` queries `folderFilenameCache`:
  1. Checks if `DBR334.jpg` exists.
  2. If present, appends incremental suffix: `DBR334_1.jpg`, `DBR334_2.jpg`, up to `_100`.
  3. Registers the allocated name in `folderFilenameCache` immediately to prevent race conditions with concurrent uploads.
- **Correct Fix**:
  Always route upload filenames through `drive.getUniqueFilenameInFolder()` prior to calling `drive.uploadFile()`.
- **Regression Test**:
  Upload two identical photos containing `DBR334`. Verify output folder contains both `DBR334.jpg` and `DBR334_1.jpg`.

---

### Issue 6: Corrupted, Blank, or 0-Byte JPG Generation
- **Status**: `FIXED`
- **Symptom**: A 0-byte or incomplete JPG is uploaded to Google Drive, or original HEIC is trashed while the uploaded JPG is unreadable.
- **Root Cause**: Network interruption during download/upload, or conversion binary failure producing an empty file without throwing an exit code error.
- **Where to Check**:
  - File: [`src/validator.js`](file:///d:/automation/heic-drive-converter/src/validator.js) $\to$ `validateJpg()` (lines 19–77).
  - File: [`src/queue.js`](file:///d:/automation/heic-drive-converter/src/queue.js) $\to$ `processJob()` (lines 195–233).
- **How to Diagnose**:
  Check `logs/error.log` for `Validation failed: File size is too small or 0 bytes` or `Invalid JPEG header magic bytes`.
- **Current Behavior**:
  1. **Pre-Upload Validation**: `validator.validateJpg()` checks:
     - File exists and `stats.size >= 1024` bytes.
     - JPEG magic bytes header `0xFF, 0xD8, 0xFF`.
     - Valid width/height dimensions via `image-size`.
     - Color channels $\ge 3$ via Sharp metadata.
  2. **Post-Upload Drive Verification**: `drive.checkFileExists(uploadedFile.id)` confirms file is active on Drive.
  3. **Strict Trashing Guard**: If either validation fails, `processJob()` throws an exception, and the original HEIC is **NEVER** trashed.
- **Correct Fix**:
  Never remove `validateJpg()` or `checkFileExists()` calls in `processJob()`.
- **Regression Test**:
  Create a 0-byte dummy file at `temp/test.jpg` and pass to `validateJpg()`. Verify it returns `false` and triggers job retry.

---

### Issue 7: Color Profile Distortion / Washed-Out Colors / Green-Red Tile Artifacts
- **Status**: `FIXED`
- **Symptom**: Converted JPG photos look faded, colors appear desaturated compared to the iPhone screen, or dark green/red rectangular grid artifacts appear on the image.
- **Root Cause**:
  1. Apple iPhones capture in **Display P3 wide gamut with 10-bit HDR**.
  2. Standard decoders clip 10-bit HDR improperly, producing green/red rectangular grid tiling artifacts.
  3. Converting Display P3 pixel values directly to RGB without transforming color profiles results in washed-out sRGB rendering on web browsers.
- **Where to Check**:
  - File: [`src/convert_heic.py`](file:///d:/automation/heic-drive-converter/src/convert_heic.py) $\to$ `convert_heic_to_jpg()` (lines 6–70).
- **How to Diagnose**:
  Inspect converted JPG on a standard sRGB monitor. Check ICC profile using `sharp(file).metadata()`.
- **Current Behavior**:
  `src/convert_heic.py` implements the **Universal sRGB Color Pipeline**:
  1. `pillow_heif.open_heif(input_path, convert_hdr_to_8bit=True)` eliminates HDR grid artifacts.
  2. Extracts source ICC profile (`image.info.get("icc_profile")`).
  3. Transforms pixels from source gamut to standard sRGB via `ImageCms.profileToProfile()`.
  4. Sets `icc_profile` metadata strictly to `srgb_profile_bytes`.
  5. Flattens transparency onto a clean white background `(255, 255, 255)`.
  6. Saves JPEG with `subsampling=0` (4:4:4 chroma subsampling) for maximum color fidelity.
- **Correct Fix**:
  Ensure `convert_hdr_to_8bit=True` and `ImageCms.profileToProfile` remain active in `src/convert_heic.py`.
- **Regression Test**:
  Convert a Display P3 Apple 10-bit HEIC photo. Verify output JPEG metadata has color space sRGB, zero green/red tile artifacts, and sharp 4:4:4 chroma.

---

### Issue 8: Process Memory Leak / High RSS Growth Under Load
- **Status**: `FIXED`
- **Symptom**: Node.js process RSS memory increases continuously over hundreds of conversions until PM2 kills and restarts the process at `800M`.
- **Root Cause**: Retaining large image Buffer references in memory, unconstrained Sharp caching, or Tesseract worker leaks.
- **Where to Check**:
  - File: [`src/ocr.js`](file:///d:/automation/heic-drive-converter/src/ocr.js) (lines 17–103, 374–380).
  - File: [`src/converter.js`](file:///d:/automation/heic-drive-converter/src/converter.js) (lines 16–21).
  - File: [`ecosystem.config.js`](file:///d:/automation/heic-drive-converter/ecosystem.config.js).
- **How to Diagnose**:
  Monitor RSS memory via `pm2 monit` or `ps -aux | grep node` during a bulk conversion run of 50+ files.
- **Current Behavior**:
  1. `sharp.cache(false)` disables libvips internal memory buffer caching.
  2. `sharp.concurrency(1)` restricts libvips thread memory overhead.
  3. `imageBuffer` is explicitly set to `null` in `finally` blocks.
  4. OCR workers are pooled in `OcrWorkerPool(1)` and reused across jobs without re-allocating WebAssembly runtimes.
  5. Peak RSS memory verified at **~142 MB** under 3 concurrent conversions.
- **Correct Fix**:
  Keep `sharp.cache(false)` enabled and ensure all large buffer references are nulled in `finally` blocks.
- **Regression Test**:
  Run 100 conversions sequentially. Measure process RSS before and after. Verify memory returns to idle baseline (~112 MB) with 0 MB net leak.

---

### Issue 9: SQLite Database Lock Errors (`SQLITE_BUSY: database is locked`)
- **Status**: `FIXED`
- **Symptom**: Logs display `SQLITE_BUSY: database is locked` or unhandled promise rejection during concurrent worker execution.
- **Root Cause**: Multiple worker threads executing synchronous writes to a SQLite database running in default rollback journal mode.
- **Where to Check**:
  - File: [`src/db.js`](file:///d:/automation/heic-drive-converter/src/db.js) $\to$ `init()` (lines 51–82).
- **How to Diagnose**:
  Check `logs/error.log` for `SQLITE_BUSY`.
- **Current Behavior**:
  `src/db.js` enforces concurrency-safe pragmas on startup:
  1. `PRAGMA journal_mode = WAL;` (Write-Ahead Logging allows simultaneous readers and writer).
  2. `PRAGMA busy_timeout = 10000;` (Waits up to 10,000 ms for lock release before erroring).
  3. `PRAGMA synchronous = NORMAL;`
- **Correct Fix**:
  Ensure all three PRAGMA statements execute in `db.init()`.
- **Regression Test**:
  Execute 50 simultaneous parallel database updates using `Promise.all()`. Verify 0 `SQLITE_BUSY` errors occur.

---

### Issue 10: Orphaned Temporary Files Filling VPS Disk Space
- **Status**: `FIXED`
- **Symptom**: VPS disk space steadily decreases; hundreds of `.heic` and `.jpg` files accumulate in `temp/`.
- **Root Cause**: Job failures or unexpected server restarts leaving temporary download/conversion files on disk without cleanup.
- **Where to Check**:
  - File: [`src/queue.js`](file:///d:/automation/heic-drive-converter/src/queue.js) $\to$ `cleanTempFiles()` and `cleanupOrphanedTempFiles()` (lines 139–175).
  - Directory: `temp/`
- **How to Diagnose**:
  Run `ls -la temp/` or `dir temp`.
- **Current Behavior**:
  1. `cleanTempFiles(tempHeicPath, tempJpgPath)` runs in `processJob()` `finally` block on both success and failure.
  2. `cleanupOrphanedTempFiles()` executes on startup: scans `temp/` and unlinks any file older than 1 hour (3600000 ms).
- **Correct Fix**:
  Keep temp file cleanup in the `finally` block of `processJob()` and startup scan active.
- **Regression Test**:
  Verify `temp/` folder contains 0 files after queue reaches empty state.

---

### Issue 11: Google Drive API Rate Limits (HTTP 429 / 403 Rate Limit Exceeded)
- **Status**: `FIXED`
- **Symptom**: Logs display `Google Drive API error: User Rate Limit Exceeded` (HTTP 403/429).
- **Root Cause**: Repetitive calls to `drive.files.list()` on every single file upload to check if target filenames exist.
- **Where to Check**:
  - File: [`src/drive.js`](file:///d:/automation/heic-drive-converter/src/drive.js) $\to$ `folderFilenameCache` and `getUniqueFilenameInFolder()` (lines 39, 198–241).
- **How to Diagnose**:
  Check `logs/error.log` for Google API rate limit errors.
- **Current Behavior**:
  1. `drive.listFolderFiles()` populates in-memory `folderFilenameCache` (`Set`) during polling.
  2. `checkFilenameExistsInFolder()` checks the Set in **0 ms** with zero Google Drive API calls.
  3. `folderFilenameCache.add()` updates the cache locally upon upload.
- **Correct Fix**:
  Never execute network API list queries inside the per-image filename resolution path; always use the in-memory cache.
- **Regression Test**:
  Upload 30 files rapidly. Inspect Google Cloud Console API metrics to confirm list API calls remain capped at 1 call per poll interval.

---

### Issue 12: HEIC Files Skipped Due to Case Sensitivity or MIME Mismatch
- **Status**: `FIXED`
- **Symptom**: Files named `IMG_9422.HEIC` (uppercase) or uploaded with generic `application/octet-stream` MIME type are ignored.
- **Root Cause**: Strict lowercase string comparison on extensions or overly restrictive MIME filters.
- **Where to Check**:
  - File: [`src/index.js`](file:///d:/automation/heic-drive-converter/src/index.js) $\to$ `getFileExtension()` and `isHeicCompatibleMime()` (lines 8–34).
  - File: [`src/scanner.js`](file:///d:/automation/heic-drive-converter/src/scanner.js) (lines 7–33).
- **How to Diagnose**:
  Check `logs/combined.log` for `Skipping due to incompatible MIME type`.
- **Current Behavior**:
  1. `getFileExtension()` applies `.toLowerCase()`, handling `.heic`, `.HEIC`, `.Heic`.
  2. `isHeicCompatibleMime()` uses a blacklist approach: allows generic/undefined MIME types and only rejects known non-image types (`text/*`, `audio/*`, `video/*`, `application/pdf`, `application/zip`, `application/json`).
- **Correct Fix**:
  Maintain case-insensitivity on extension extraction and permissive MIME compatibility checks.
- **Regression Test**:
  Upload `TEST.HEIC` with `mimeType: application/octet-stream`. Verify it is discovered and queued successfully.

---

### Issue 13: Truncated or Mismatched Filenames on Dark-Background Images
- **Status**: `FIXED`
- **Symptom**: Images with dark backgrounds are renamed with truncated numbers (e.g. `DER55.jpg`, `DER46.jpg`) when the physical tag inside the image reads `DER552` or `DER461`.
- **Root Cause**: Tesseract OCR splits digits on dark/reflective backgrounds (reading `"DER 55 2"`). The regex terminated at the space boundary before the trailing digit, matching only the first 2 digits (`"DER 55"`).
- **Where to Check**:
  - File: [`src/ocr.js`](file:///d:/automation/heic-drive-converter/src/ocr.js) $\to$ `extractTagPattern()` (lines 184–212).
  - File: [`src/queue.js`](file:///d:/automation/heic-drive-converter/src/queue.js) $\to$ `verifyTagSanity()` (lines 26–65).
  - File: [`src/verifier.js`](file:///d:/automation/heic-drive-converter/src/verifier.js) $\to$ `verifySingleFile()`.
- **How to Diagnose**:
  Run `npm run verify:folder --report` to inspect all detected tags vs filenames.
- **Current Behavior**:
  1. `splitRegex` captures separated digit groups (e.g. `"DER 55 2"` $\to$ `"DER552"`).
  2. Candidate scoring prioritizes 3–5 digit catalog numbers over partial 2-digit matches.
  3. `verifyTagSanity()` enforces prefix length and digit rules before renaming.
  4. `src/verifier.js` independently audits already converted Drive JPGs.
- **Correct Fix**:
  Preserve split-digit reconnection and candidate ranking in `ocr.js`, plus pre-upload tag sanity in `queue.js`.

---

### Issue 14: Folder Verification Starving Active Conversions or Locking Workers
- **Status**: `FIXED`
- **Symptom**: Running folder-level verification slows down or blocks new incoming HEIC conversions.
- **Root Cause**: Verification sharing the main conversion OCR worker pool or running concurrently on limited VPS CPU.
- **Where to Check**:
  - File: [`src/verifier.js`](file:///d:/automation/heic-drive-converter/src/verifier.js) $\to$ `verifyOcrPool` (line 19) and `isConversionQueueIdle()` (lines 35–45).
  - File: [`src/ocr.js`](file:///d:/automation/heic-drive-converter/src/ocr.js) $\to$ `OcrWorkerPool` injection in `detectTagFromImage()`.
- **How to Diagnose**:
  Check logs for `[Verifier] Conversion queue active — yielding to conversion workers`.
- **Current Behavior**:
  1. Verification uses its own dedicated, isolated single-worker OCR pool (`verifyOcrPool = new ocr.OcrWorkerPool(1)`), completely separate from production conversion workers.
  2. Before processing each file, `isConversionQueueIdle()` queries SQLite. If `PENDING > 0` or `PROCESSING > 0`, verification pauses and yields 100% of VPS resources to conversion workers.
- **Correct Fix**:
  Never share the OCR pool between conversion and verification; enforce idle gating.

---

### Issue 15: Filename Mismatch Auto-Repair & Target Collision Handling
- **Status**: `FIXED`
- **Symptom**: A converted JPG has an outdated or truncated filename (e.g. `DER55.jpg` or `IMG_9422.jpg`) while the image contains `DER552` or `DBR334`.
- **Root Cause**: Past conversions created prior to Option 2 fixes or camera filenames that bypassed OCR renaming.
- **Where to Check**:
  - File: [`src/verifier.js`](file:///d:/automation/heic-drive-converter/src/verifier.js) $\to$ `verifySingleFile()`.
  - File: [`src/drive.js`](file:///d:/automation/heic-drive-converter/src/drive.js) $\to$ `getFileByNameInFolder()` and `renameFile()`.
- **How to Diagnose**:
  Run `npm run verify:folder --report` to inspect all `REPAIRED` and `REPAIR_CONFLICT` records.
- **Current Behavior**:
  1. If detected tag passes `verifyTagSanity()` and differs from current filename, verifier automatically renames the Drive file to `<detectedTag>.jpg` in place.
  2. Before renaming, `getFileByNameInFolder()` checks if `<detectedTag>.jpg` already exists. If a collision is found, renaming is prevented and status is set to `REPAIR_CONFLICT`.
  3. If Drive API fails, status transitions to `REPAIR_FAILED` without crashing the daemon.
  4. Subsequent scans find exact match and record `VERIFIED` with zero duplicate renames.
- **Correct Fix**:
  Maintain in-place Drive metadata renaming, sanity checks, and collision detection in `src/verifier.js`.

---

## 3. Summary of Issue Resolutions

| # | Known Issue / Scenario | Root Cause | Resolution in Current Codebase | Status |
|---|---|---|---|---|
| 1 | Queue pauses with pending items | Worker claim collision race condition | Count-check before break + 50ms yield in `workerLoop()` | **FIXED** |
| 2 | Polling dependency throttling queue | Poller coupled to worker lifecycle | Autonomous SQLite worker loop decoupled from poller | **FIXED** |
| 3 | OCR fails on green velvet cushions | Fabric weave noise at low threshold (135) | Upper cushion crop + threshold 175 negation in `ocr.js` | **FIXED** |
| 4 | Character misreads (`0BR` $\to$ `DBR`) | Font similarity & ghost characters | Regex normalization, ghost removal & trailing digit fixes | **FIXED** |
| 5 | Duplicate name overwrites on Drive | Static filename assignment | In-memory `folderFilenameCache` + `_1`, `_2` suffixing | **FIXED** |
| 6 | Blank or corrupted JPGs uploaded | Unvalidated conversion output | Pre-upload magic bytes/dimension check + post-upload verify | **FIXED** |
| 7 | Washed out colors & green/red tiles | Display P3 HDR 10-bit clipping | `convert_hdr_to_8bit=True` + `ImageCms` sRGB in Python | **FIXED** |
| 8 | Process RAM leak under load | Retained buffers & unbounded Sharp cache | `sharp.cache(false)` + buffer nulling + pooled OCR worker | **FIXED** |
| 9 | SQLite database lock errors | Rollback journal lock contention | WAL mode + `busy_timeout = 10000` + `synchronous = NORMAL` | **FIXED** |
| 10 | Temp files filling VPS disk | Orphaned temp files on failure | `finally` unlink + startup sweep of files > 1 hour | **FIXED** |
| 11 | Google Drive API rate limits | Repetitive list calls per file | In-memory `Set` caching for 0ms filename lookups | **FIXED** |
| 12 | Uppercase `.HEIC` skipped | Strict case comparison & MIME filter | `.toLowerCase()` extension parsing + permissive MIME check | **FIXED** |
| 13 | Truncated tags on dark images (`DER55`) | Tesseract digit splitting on dark cushions | Split-digit reconnection + candidate scoring + tag sanity guard | **FIXED** |
| 14 | Verifier starving conversion workers | Shared OCR worker pool & concurrency | Dedicated `verifyOcrPool(1)` + Architecture C idle gating | **FIXED** |
| 15 | Filename mismatch & collision safety | Camera names / pre-Option 2 truncations | In-place Drive rename + collision check (`REPAIR_CONFLICT`) | **FIXED** |


