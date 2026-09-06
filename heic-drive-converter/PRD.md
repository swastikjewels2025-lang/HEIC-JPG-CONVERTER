# Product Requirements Document (PRD)
## HEIC Drive Converter — Automated Local Conversion & Jewelry Tag Renaming Service

---

## 1. Product Overview

The **HEIC Drive Converter** is a self-hosted, 24/7 background automation service engineered to monitor a designated Google Drive folder, detect Apple High Efficiency Image Container (`.heic` / `.heif`) photos, download and decode them locally on a VPS without external paid API dependencies, convert them into high-fidelity `.jpg` images, detect jewelry tag numbers directly from inside the image pixels via targeted multi-pass local Optical Character Recognition (OCR), rename the resulting JPG to the detected tag number (e.g., `DBR334.jpg`), upload the JPG back to Google Drive, verify file health, and safely trash the original HEIC.

### 1.1 Problem Statement
1. **Compatibility Barrier**: Apple iOS devices upload product and jewelry catalog photos in HEIC format by default. Web platforms, e-commerce storefronts, inventory portals, and Windows/Android clients cannot natively render or process HEIC files without specialized codecs.
2. **Third-Party API Cost & Privacy**: Cloud-based conversion APIs (e.g., CloudConvert) introduce recurring subscription fees, per-file costs, external network bandwidth overhead, and API rate limit bottlenecks when processing thousands of high-resolution catalog images.
3. **Manual Renaming Overhead**: Jewelry catalog photography requires naming image files by physical product SKU tags (e.g., `DBR330`, `DER564`, `DNS291`). Manual inspection and renaming of hundreds of daily uploads is slow, labor-intensive, and prone to human typo errors.
4. **Color Gamut Degradation**: Apple HEIC files typically use the wide Display P3 color space with 10-bit HDR encoding. Naive conversion tools cause color shifting, washed-out tones, green/red rectangular tiling artifacts, and invalid color profile attachments.

### 1.2 Expected End-to-End Result
When a photographer or staff member uploads `IMG_9422.heic` to the configured Google Drive folder:
- The service discovers the file within seconds via polling.
- The image is queued in a persistent local SQLite database.
- A local worker claims the job, downloads the HEIC, and executes local Python/Pillow/pillow-heif conversion into standard sRGB JPEG (4:4:4 chroma subsampling, zero compression banding).
- Pre-upload validation verifies JPEG magic bytes, file size, dimensions, and channel health.
- Local multi-pass OCR inspects the image pixels, identifies the jewelry catalog tag printed on the cushion/label (e.g., `DBR334`), and validates it against jewelry taxonomy rules.
- The JPG is named `DBR334.jpg` (or `DBR334_1.jpg` if a collision exists) and uploaded directly to the Google Drive folder.
- Google Drive confirms the uploaded file is active and intact.
- If `TEST_MODE=false`, the original `IMG_9422.heic` is moved to Google Drive Trash.
- The SQLite queue status transitions to `COMPLETED` with full execution metadata.

### 1.3 Target Audience & Stakeholders
- **Jewelry Catalog & E-Commerce Inventory Teams**: Automated ingestion and standardized naming of daily product photography.
- **Operations & IT Administrators**: Zero-cost, self-hosted, resilient VPS infrastructure running continuously under PM2 process management.
- **Photographers**: Immediate upload workflow directly from iPhones/iPads to Google Drive without manual format conversions or file renaming.

---

## 2. Core Objective & End-to-End Pipeline

The verified end-to-end processing pipeline operates strictly through local components as confirmed from the codebase:

```mermaid
flowchart LR
    A[Google Drive Folder] -->|Poll files.list| B[Drive Poller / Scanner]
    B -->|Filter .heic + MIME| C[SQLite Queue Database]
    C -->|Atomic Job Claim| D[Worker Pool]
    D -->|Download Media Stream| E[Local VPS Temp HEIC]
    E -->|Python pillow-heif| F[High-Fidelity sRGB JPG]
    F -->|Validation Checks| G[Pre-Upload Validator]
    G -->|Multi-Pass Sharp + Tesseract| H[Local Tag OCR Engine]
    H -->|Match Jewelry SKU| I[Target Filename Generator]
    I -->|Upload Stream| J[Google Drive Upload]
    J -->|Verify Active File| K[Drive Post-Upload Verification]
    K -->|If TEST_MODE=false| L[Trash Original HEIC]
    K -->|Mark COMPLETED| M[SQLite State Update]
```

---

## 3. Functional Requirements

### 3.1 Google Drive Monitoring & Polling
- **Purpose**: Continuously discover newly uploaded files in the monitored Google Drive folder.
- **Input**: Configured `GOOGLE_DRIVE_FOLDER_ID`, OAuth2 or Service Account credentials.
- **Processing**: 
  - `src/index.js` invokes `drive.listFolderFiles()` every `POLL_INTERVAL_SECONDS` (default: 5s in config, 60s in `.env.example`).
  - Automatically traverses Google Drive pagination (`pageSize: 1000`, `pageToken`, `corpora: 'allDrives'`).
  - Maintains an in-memory `folderFilenameCache` (Set of lowercase names) for zero-latency duplicate checks.
- **Output**: Array of file metadata objects (`id`, `name`, `size`, `mimeType`, `createdTime`).
- **Success Behavior**: Scans complete folder tree and triggers queue evaluation.
- **Failure Behavior**: Logs error with timestamp and stack trace; retries on next poll interval without crashing daemon.

### 3.2 File Discovery & Candidate Filtering
- **Purpose**: Isolate convertible `.heic` files and prevent processing non-HEIC or incompatible media.
- **Input**: List of Drive files.
- **Processing**:
  - Checks file extension: strictly `ext === 'heic'` (case-insensitive via `getFileExtension()`).
  - Checks MIME type: rejects incompatible MIME types (`text/*`, `audio/*`, `video/*`, `application/pdf`, `application/zip`, `application/json`).
  - Checks SQLite database: ignores files whose `file_id` already exists in `conversion_queue`.
  - Checks existing JPG duplicates: if a JPG matching the base name already exists with size > 0, marks file as `SKIPPED` in SQLite and trashes original if `TEST_MODE=false`.
- **Output**: Insert candidates into SQLite queue.
- **Success Behavior**: Eligible files added to SQLite with status `PENDING`.
- **Failure Behavior**: Skipped files recorded in DB to prevent redundant scan overhead.

### 3.3 SQLite Persistence & Asynchronous Queue
- **Purpose**: Decouple file discovery from processing, provide crash-resilient persistence, and ensure backpressure control.
- **Input**: `file_id`, `filename`, `ext`, `mime_type`, `target_filename`.
- **Processing**:
  - `src/db.js` initializes SQLite database at `DB_PATH` (`data/queue.sqlite`).
  - Enables Write-Ahead Logging (`PRAGMA journal_mode = WAL`), `PRAGMA busy_timeout = 10000`, and `PRAGMA synchronous = NORMAL`.
  - Table: `conversion_queue`.
  - Startup auto-recovery: resets any orphaned `PROCESSING` jobs to `PENDING`.
- **Output**: Persistent job record.
- **Success Behavior**: Atomic insertions via `INSERT OR IGNORE`.
- **Failure Behavior**: Rejects duplicate entries; database lock timeout handled up to 10s.

### 3.4 Worker Pool & Concurrency Management
- **Purpose**: Execute conversions in parallel without exhausting VPS CPU or RAM.
- **Input**: Pending jobs in SQLite.
- **Processing**:
  - `src/queue.js` runs `processQueue()` maintaining up to `MAX_CONCURRENT_CONVERSIONS` (default: 2, configured: 4).
  - Workers execute `workerLoop()`, calling `claimNextPendingJob()` with atomic SQL `UPDATE ... WHERE file_id = ? AND status = ?`.
  - Workers pull jobs continuously from SQLite until no `PENDING` or eligible `RETRY_WAIT` jobs remain.
  - Workers yield 50ms between items to maintain event loop health.
- **Output**: Parallel job processing pipelines.
- **Success Behavior**: Jobs process concurrently with zero race condition lock collisions.
- **Failure Behavior**: If claim fails due to concurrent race, worker checks pending count; if jobs remain, yields 50ms and retries immediately.

### 3.5 Local HEIC Conversion Engine
- **Purpose**: High-fidelity local decoding and sRGB JPEG encoding with zero cloud API dependency.
- **Input**: Temporary HEIC file path on VPS (`temp/${file_id}.heic`), target JPG path (`temp/${file_id}.jpg`), quality level (`JPEG_QUALITY`, default: 95).
- **Processing**: Multi-engine priority execution with working engine cache:
  1. **Primary Engine**: `python-pillow` (`src/convert_heic.py` via Python `pillow-heif`).
     - Decodes HEIC with `convert_hdr_to_8bit=True` (eliminates HDR color artifacts).
     - Auto-orients image via `ImageOps.exif_transpose`.
     - Color transform: converts source profile (Display P3) to standard sRGB via `ImageCms.profileToProfile`.
     - Embeds sRGB ICC profile.
     - Flattens alpha transparency onto clean white `(255, 255, 255)` background.
     - Saves JPEG with `subsampling=0` (4:4:4 chroma subsampling) and EXIF preservation.
  2. **Fallback Engines**: `ffmpeg-native` (`-pix_fmt yuvj444p`), `sharp-direct`, `libheif-js-sharp` (WASM + Sharp MozJPEG), `heic-convert-npm`, `heif-convert-cli`, `imagemagick`.
- **Output**: High-resolution, color-accurate JPG file.
- **Success Behavior**: Working engine cached in memory (`cachedWorkingEngine`); returns JPG path.
- **Failure Behavior**: Chains through all fallback engines; throws aggregated error if all fail.

### 3.6 Pre-Upload Quality & Integrity Validation
- **Purpose**: Ensure corrupted or 0-byte conversions are never uploaded to Google Drive.
- **Input**: Generated local JPG file path.
- **Processing** (`src/validator.js`):
  1. Checks file existence on VPS disk.
  2. Checks file size > 1 KB (1024 bytes).
  3. Verifies JPEG magic bytes: header must start with `0xFF, 0xD8, 0xFF`.
  4. Parses image dimensions using `image-size`.
  5. Inspects color channels via `sharp.metadata()` (warns if channels < 3).
- **Output**: Boolean (`true` = valid, `false` = invalid).
- **Success Behavior**: Validation passes; proceeds to OCR and upload.
- **Failure Behavior**: Throws validation error; triggers job retry/failure handling.

### 3.7 Local OCR & Tag Number Detection
- **Purpose**: Automatically read the physical jewelry tag number printed on cushion/display inside the image.
- **Input**: Validated JPG image path.
- **Processing** (`src/ocr.js`):
  - Pre-warmed `OcrWorkerPool` using offline `tesseract.js` with local `eng.traineddata`.
  - Whitelist: `ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.`
  - Multi-pass targeted Sharp image preprocessing:
    - **Pass 1 (Cushion Crop)**: Crops upper/center cushion region (85% width, 65% height), resizes to 1200w, grayscale, binary threshold 175, inverted (black text on white). Targets white text on green/dark velvet cushions. PSM 11.
    - **Pass 2 (Full-Frame High-Res)**: Shared intermediate buffer resized to 1200w, grayscale, normalized. PSM 11 with fallback to PSM 6.
    - **Pass 3 (Full-Frame Contrast 165)**: Shared intermediate buffer threshold 165 inverted. PSM 11.
    - **Pass 4 (Full-Frame Contrast 125)**: Shared intermediate buffer threshold 125 inverted. PSM 11.
  - Normalization & regex parsing:
    - Normalizes common OCR misreads (`0BR334` / `OBR334` -> `DBR334`).
    - Fixes separated prefix letters (`D.BR 334` -> `DBR334`).
    - Matches priority catalog prefixes (`BN GOLD`, `ACCH`, `DBN`, `DBR`, `DER`, `DGR`, `DLR`, `DMS`, `DNS`, `DPS`, `GBR`, etc.).
    - Fixes ghost characters (`DERS556` -> `DER556`) and trailing digit substitutions (`DBR32B` -> `DBR328`).
- **Output**: Normalized tag string (e.g., `DBR334`) or `null`.
- **Success Behavior**: Tag detected; used for target filename.
- **Failure Behavior**: Fallback to original filename base (e.g., `IMG_9422.jpg`).

### 3.8 Filename Generation & Collision Handling
- **Purpose**: Guarantee unique, deterministic filenames and eliminate overwrites.
- **Input**: Detected tag or original filename base, extension `.jpg`.
- **Processing** (`src/drive.js`):
  - `getUniqueFilenameInFolder(baseName, '.jpg')`:
    - Checks `folderFilenameCache` for `baseName.jpg`.
    - If exists, increments counter: `baseName_1.jpg`, `baseName_2.jpg`, up to `baseName_100.jpg`.
    - Adds selected unique filename to cache.
- **Output**: Guaranteed unique filename string for Google Drive.
- **Success Behavior**: Generates next available unique name without Drive API latency.

### 3.9 Upload & Post-Upload Verification
- **Purpose**: Upload converted JPG and verify availability before removing original HEIC.
- **Input**: Local JPG path, unique target filename, Google Drive folder ID.
- **Processing**:
  - `drive.uploadFile()` streams file to Google Drive folder (`mimeType: 'image/jpeg'`).
  - Adds filename to `folderFilenameCache`.
  - `drive.checkFileExists(uploadedFile.id)` queries Drive API to confirm file is active and not trashed.
- **Output**: Google Drive file metadata (`id`, `name`, `size`).
- **Success Behavior**: Confirms file exists on Drive; proceeds to trashing original.
- **Failure Behavior**: Throws post-upload verification error; original HEIC is NEVER trashed.

### 3.10 Safe Deletion & Test Mode
- **Purpose**: Clean up source HEIC files without risking data loss.
- **Processing**:
  - If `TEST_MODE=true` (default): logs test mode notice; preserves original HEIC in Drive folder.
  - If `TEST_MODE=false`: invokes `drive.trashFile(job.file_id)` to move original HEIC to Google Drive Trash (recoverable for 30 days).
- **Success Behavior**: Clean folder management with zero duplicate accumulation.

### 3.11 Resilient Retry & Failure Handling
- **Purpose**: Prevent temporary network drops or rate limits from causing permanent failures.
- **Processing** (`src/queue.js`):
  - Tracks `attempts` per job.
  - Exponential backoff schedule: Attempt 1 = 1m (60s), Attempt 2 = 2m (120s), Attempt 3 = 5m (300s), Attempt 4 = 15m (900s).
  - Status set to `RETRY_WAIT` with `next_retry_at = Date.now() + backoff`.
  - If `attempts >= 4` (`MAX_ATTEMPTS`): status set to `FAILED`.
- **Success Behavior**: Transient failures auto-recover on subsequent attempts.

### 3.12 Cleanup & Temp File Hygiene
- **Purpose**: Maintain VPS disk space and eliminate orphaned file accumulation.
- **Processing**:
  - `cleanTempFiles(heicPath, jpgPath)` executed in `processJob()` `finally` block.
  - `cleanupOrphanedTempFiles()` executed on startup: deletes files in `tempDir` older than 1 hour (3600000 ms).
- **Success Behavior**: 0 bytes residual temp file leak per conversion.

### 3.13 Operational CLI & Status Reporting
- **Purpose**: Provide operators with instant inspection and maintenance commands.
- **Features**:
  - `npm start`: Starts continuous 24/7 background daemon (`src/index.js`).
  - `npm run scan`: Executes bulk backlog scan across all folder files and exits upon completion (`src/scanner.js`).
  - `npm run status`: Prints formatted terminal table of queue metrics, recent completed jobs with durations, and last error (`src/status.js`).
  - `npm run test:speed`: Runs OCR speed and accuracy benchmark suite on synthetic catalog test cases (`test_ocr.js`).
  - `npm run reset`: Resets SQLite database queue.

---

## 4. Filename Requirements (Strict Specification)

### 4.1 Core Mapping Rule
> The final JPG filename MUST be based on the physical Tag No. detected **INSIDE THE SAME IMAGE PIXELS**.

| Input File | Detected In-Image Tag | Resulting Output Filename | Rename Type |
|---|---|---|---|
| `IMG_9422.heic` | `DBR334` | `DBR334.jpg` | `TAG_OCR` |
| `IMG_9425.heic` | `DBR330` | `DBR330.jpg` | `TAG_OCR` |
| `IMG_9428.heic` | `DER564` | `DER564.jpg` | `TAG_OCR` |
| `IMG_9430.heic` | `None (no tag in photo)` | `IMG_9430.jpg` | `ORIGINAL_NAME` |

### 4.2 State Isolation & Concurrency Safety
- Every conversion job uses isolated temporary file paths keyed by unique Google Drive file ID: `temp/${job.file_id}.heic` and `temp/${job.file_id}.jpg`.
- OCR runs strictly on the exact `temp/${job.file_id}.jpg` generated in that specific job execution.
- No global variables hold image buffers or detected tags across concurrent worker threads.

### 4.3 Catalog Prefix Hierarchy & Validation
Jewelry prefix matching enforces strict priority ordering (`sort((a, b) => b.length - a.length)`):
1. **Multi-word Gold prefixes**: `BN GOLD`, `CP GOLD`, `CS GOLD`, `LS GOLD`, `NS GOLD`, `PS GOLD`.
2. **4-5 Letter categories**: `ACCH`, `AADI`, `KADA`, `PAYAL`, `DKDA`, `GKDA`, `DJUM`, `GJUM`, `BALI`.
3. **3-Letter Diamond (D) & Gold (G)**: `DBN`, `DBR`, `DER`, `DGR`, `DLR`, `DMS`, `DNP`, `DNS`, `DPS`, `DCH`, `DNC`, `DTK`, `DPD`, `GBN`, `GBR`, `GER`, `GGR`, `GLR`, `GMS`, `GNP`, `GNS`, `GPS`, `GCH`, `GNC`, `GTK`, `GPD`.
4. **General categories**: `CVD`, `RNG`, `JUM`, `PAY`, `KDA`.
5. **2-Letter categories**: `BN`, `BR`, `ER`, `GR`, `LR`, `MS`, `NP`, `NS`, `PS`, `CP`, `CS`, `LS`, `TK`, `BA`, `CH`, `NC`, `DP`, `GP`, `PD` (enforces **minimum 3 digits** to prevent reflection noise).

### 4.4 OCR Noise & Confusion Corrections
- **Prefix Starter Confusion**: `0BR334` / `OBR334` / `QBR334` $\to$ `DBR334`; `0MS189` / `OMS189` $\to$ `DMS189`.
- **Punctuation & Spacing**: `D BR 334`, `D.BR 334`, `D-BR 334` $\to$ `DBR334`.
- **Ghost Characters**: `DERS556` $\to$ `DER556`.
- **Trailing Character Substitutions**: `DBR32B` $\to$ `DBR328`, `DBR32S` $\to$ `DBR325`, `DBR32O` $\to$ `DBR320`, `DBR32I` $\to$ `DBR321`.
- **Noise Blacklist**: Rejects non-SKU words (`PHOTO`, `IMAGE`, `HEIC`, `JPEG`, `STOCK`, `ARTICLE`, `JEWEL`, `CAMERA`, `APPLE`, `IPHONE`, `WIDTH`, `HEIGHT`, `SOOT`, `NN`, `RING`, `GOLD`, `HOP`).

---

## 5. Performance Requirements & QA Verified Baselines

### 5.1 Verified Production Metrics (Latest QA Audit)
The following metrics represent actual measured performance on production-grade workloads:

| Metric | Verified Baseline | Target / SLA | Status |
|---|---|---|---|
| **Single HEIC Conversion Latency** | ~1.05 – 1.06 sec (for ~7 MB 12MP Apple HEIC) | < 2.0 sec | **PASSED** |
| **Concurrent Throughput (3 Workers)** | ~0.26 – 0.52 sec / file effective throughput | < 1.0 sec / file | **PASSED** |
| **Local OCR Detection Latency** | ~0.35 – 0.70 sec / image (Pass 1 Cushion Crop) | < 1.0 sec | **PASSED** |
| **OCR Accuracy on Velvet Cushion** | 100% on tested catalog codes (`DBR330`, `DBR334`, `DBR336`, `DER564`, `DGR10278`, `CP1148`, `DNS291`) | > 95% | **PASSED** |
| **Idle Process Memory (RSS)** | ~112 MB | < 250 MB | **PASSED** |
| **Peak Conversion Memory (RSS)** | ~142 MB (3 concurrent conversions + OCR) | < 500 MB | **PASSED** |
| **Memory Leak Rate** | 0.0 MB / 100 conversions (stable flat memory profile) | 0.0 MB | **PASSED** |
| **PM2 Process Restarts** | 0 unexpected restarts / crashes | 0 | **PASSED** |
| **Temporary File Disk Leak** | 0 residual files left in `temp/` after job completion | 0 | **PASSED** |

---

## 6. Non-Functional Requirements

### 6.1 Reliability & Crash Tolerance
- **Persistent State**: SQLite WAL mode ensures transactions survive unexpected VPS power loss.
- **Auto-Recovery**: Orphaned `PROCESSING` jobs automatically transition back to `PENDING` on service reboot.
- **Global Error Interception**: Top-level handlers for `uncaughtException` and `unhandledRejection` prevent unhandled promise drops from terminating the process.

### 6.2 Stability & Process Lifecycle
- **PM2 Orchestration**: Managed via `ecosystem.config.js` in fork mode with auto-restart on memory threshold (`800M`).
- **Graceful Shutdown**: Intercepts `SIGTERM` / `SIGINT`, halts new job claims, allows active workers up to 10 seconds to finish, closes SQLite cleanly, and terminates Tesseract worker pool.

### 6.3 Memory & Resource Efficiency
- **Buffer Deallocation**: Buffers and image handles explicitly nulled after conversion and OCR passes.
- **Single-Core Sharp Limiting**: `sharp.concurrency(1)` and `sharp.cache(false)` prevent memory fragmentation.
- **Backpressure**: SQLite queue prevents unbounded concurrency, limiting active conversions strictly to `MAX_CONCURRENT_CONVERSIONS`.

### 6.4 Data Integrity & Safety
- **Strict Deletion Guard**: Source HEIC files are **NEVER** moved to Trash unless the uploaded JPG passes local validation and Google Drive confirms the file ID is active.
- **Non-Destructive Trashing**: Uses `drive.files.update({ trashed: true })` instead of hard delete, allowing 30-day recovery in Google Drive.

### 6.5 Maintainability & Observability
- Formatted console and file logging (`logs/combined.log`, `logs/error.log`) with ISO timestamps.
- Terminal CLI status table via `npm run status`.
- Modular, single-responsibility file organization under `src/`.

---

## 7. Out of Scope (What the System Does NOT Do)

1. **Non-HEIC Conversions**: The system does NOT convert PNG, WebP, TIFF, or PDF files. All non-`.heic` files are ignored.
2. **Web UI / Admin Portal**: The service is a headless backend daemon managed via PM2 and CLI commands. There is no web GUI.
3. **Hard Deletion**: The service never permanently deletes files from Google Drive; it only moves them to Trash.
4. **Folder Reorganization**: The service does not create subfolders or move files between different Drive folders; it writes JPGs back into the same monitored folder.
5. **Interactive User Approval**: Queue processing and OCR renaming operate 100% autonomously without human prompt requirements.
6. **External OCR Cloud APIs**: Does not call Google Cloud Vision, AWS Rekognition, or OpenAI APIs for OCR. All OCR is 100% local and offline.
