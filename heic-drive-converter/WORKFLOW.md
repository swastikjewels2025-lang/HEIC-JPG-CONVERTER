# Complete End-to-End Workflow
## HEIC Drive Converter — Step-by-Step Execution Guide & Workflow Diagrams

---

## 1. High-Level System Flow

The system operates as an event-driven and worker-driven asynchronous pipeline:

```mermaid
flowchart TD
    Start([Daemon Start / PM2 Boot]) --> InitDB[Initialize SQLite DB & WAL Pragmas]
    InitDB --> Recover[Auto-Recover Orphaned PROCESSING Jobs to PENDING]
    Recover --> PrewarmOCR[Pre-warm Offline OCR Worker Pool]
    PrewarmOCR --> CleanTemp[Cleanup Orphaned Temp Files > 1 hr]
    CleanTemp --> PollerLoop[Start Google Drive Polling Loop]
    
    subgraph "Drive Discovery Phase"
        PollerLoop --> ListFiles[drive.listFolderFiles: List Drive Files]
        ListFiles --> BuildCache[Populate folderFilenameCache & JPG Map]
        BuildCache --> FilterHEIC{Is File .heic & Valid MIME?}
        FilterHEIC -->|No| SkipFile[Ignore non-HEIC File]
        FilterHEIC -->|Yes| CheckDup{Duplicate JPG Exists on Drive?}
        CheckDup -->|Yes| MarkSkip[Record SKIPPED in DB & Trash HEIC if TEST_MODE=false]
        CheckDup -->|No| InsertDB[queue.addToQueue: Insert PENDING into SQLite]
    end

    InsertDB --> TriggerQueue[queue.processQueue: Launch Worker Loops]

    subgraph "Worker Execution Phase"
        TriggerQueue --> ClaimJob[claimNextPendingJob: Atomic Optimistic Claim]
        ClaimJob --> HasJob{Job Claimed?}
        HasJob -->|No, but DB has pending| YieldWorker[Yield 50ms & Retry Claim]
        YieldWorker --> ClaimJob
        HasJob -->|No, DB truly empty| ExitWorker[Worker Loop Exits Cleanly]
        HasJob -->|Yes| DownloadHEIC[drive.downloadFile: Stream to temp/file_id.heic]
        DownloadHEIC --> ConvertImg[converter.convertHeicToJpg: Python pillow-heif sRGB]
        ConvertImg --> ValidateJPG[validator.validateJpg: Check Magic Bytes & Size]
        ValidateJPG --> ScanOCR[ocr.detectTagFromImage: Multi-Pass Targeted OCR]
        ScanOCR --> HasTag{Tag Detected?}
        HasTag -->|Yes| GenUniqueTag[drive.getUniqueFilenameInFolder: Tag SKU Name]
        HasTag -->|No| GenUniqueOrig[drive.getUniqueFilenameInFolder: Original Name]
        GenUniqueTag --> UploadDrive[drive.uploadFile: Stream JPG to Google Drive]
        GenUniqueOrig --> UploadDrive
        UploadDrive --> VerifyDrive[drive.checkFileExists: Confirm File Active on Drive]
        VerifyDrive --> CheckTestMode{TEST_MODE == true?}
        CheckTestMode -->|Yes| SkipTrash[Preserve Original HEIC]
        CheckTestMode -->|No| TrashHEIC[drive.trashFile: Move HEIC to Drive Trash]
        SkipTrash --> MarkDone[updateJobStatus: Mark COMPLETED in DB]
        TrashHEIC --> MarkDone
        MarkDone --> CleanJobTemp[cleanTempFiles: Delete local .heic and .jpg]
        CleanJobTemp --> LoopNext[Worker Immediately Claims Next Job]
        LoopNext --> ClaimJob
    end
```

---

## 2. Step-by-Step Execution Walkthrough

### STEP 1: Service Initialization & Bootstrap
1. Node.js process starts via PM2 (`ecosystem.config.js`) or `npm start` (`src/index.js`).
2. Global exception interceptors (`process.on('uncaughtException')`, `process.on('unhandledRejection')`) are attached.
3. `db.init()` is invoked:
   - Sets SQLite PRAGMAs: `journal_mode = WAL`, `busy_timeout = 10000`, `synchronous = NORMAL`.
   - Creates table `conversion_queue` if not present.
   - Executes crash recovery: `UPDATE conversion_queue SET status = 'PENDING' WHERE status = 'PROCESSING'`, auto-recovering any jobs interrupted by a crash.
4. `ocr.prewarmWorker()` initializes `tesseract.js` worker pool asynchronously with local `eng.traineddata`.
5. `queue.cleanupOrphanedTempFiles()` scans `temp/` and unlinks any residual files older than 1 hour.
6. Initial `checkFolder()` is executed, and periodic polling is scheduled via `setInterval(checkFolder, config.pollIntervalMs)`.

### STEP 2: Google Drive Polling & Pagination
1. `src/index.js:checkFolder()` acquires single-execution lock (`if (isChecking) return`).
2. Calls `drive.listFolderFiles()` (`src/drive.js`):
   - Authenticates using Service Account (`credentials.json`) or OAuth2 refresh tokens.
   - Executes `drive.files.list()` with query: `'<FOLDER_ID>' in parents and trashed = false`.
   - Traverses pagination using `pageToken` and `pageSize: 1000` until all files in the folder are collected.
   - Automatically supports shared drives (`supportsAllDrives: true`, `includeItemsFromAllDrives: true`, `corpora: 'allDrives'`).
3. Re-populates `folderFilenameCache` (`Set` of all lowercase file names currently in the folder) for 0 ms lookups.

### STEP 3: File Filtering & Duplicate Detection
1. Builds an in-memory `Map` of existing JPG files (`lowercase filename` $\to$ `file size`).
2. Iterates over discovered Drive files:
   - **Extension Check**: Extracts extension via `getFileExtension(file.name)`. If `ext !== 'heic'`, skips immediately.
   - **MIME Check**: Calls `isHeicCompatibleMime(file.mimeType)`. Rejects non-image MIME types (`text/*`, `audio/*`, `video/*`, `application/pdf`, etc.).
   - **Database Check**: Queries `SELECT file_id FROM conversion_queue WHERE file_id = ?`. If already in database, skips.
   - **Duplicate Output Check**: Computes expected base output filename (e.g., `IMG_9422.jpg`). Checks if `existingJpgs.get('img_9422.jpg') > 0`:
     - If duplicate exists and `TEST_MODE=false`: calls `drive.trashFile(file.id)` to clean up the original HEIC.
     - Inserts record into `conversion_queue` with status `'SKIPPED'` and error `'JPG duplicate exists'`.

### STEP 4: Queue Insertion
1. For eligible candidate HEIC files, calls `queue.addToQueue(file.id, file.name, ext, file.mimeType, targetFilename)`.
2. Executes SQL:
   ```sql
   INSERT OR IGNORE INTO conversion_queue 
   (file_id, filename, ext, mime_type, target_filename, status, attempts, last_error, created_at, updated_at, next_retry_at)
   VALUES (?, ?, ?, ?, ?, 'PENDING', 0, NULL, ?, ?, 0);
   ```
3. Logs: `[INFO] Queued newly detected HEIC: IMG_9422.heic (1a2b3c4d...)`.
4. Triggers worker loop processing: `queue.processQueue()`.

### STEP 5: Worker Concurrency & Atomic Job Claiming
1. `queue.processQueue()` evaluates `activeConversions < config.maxConcurrentConversions`.
2. Spawns persistent worker loops (`workerLoop()`) up to the configured concurrency cap (e.g., 2 or 4).
3. Each worker calls `claimNextPendingJob()`:
   - Queries oldest `PENDING` job or `RETRY_WAIT` job where `next_retry_at <= Date.now()`.
   - Atomically executes optimistic locking update:
     ```sql
     UPDATE conversion_queue 
     SET status = 'PROCESSING', started_at = ?, updated_at = ?
     WHERE file_id = ? AND status = ?;
     ```
   - If `result.changes === 1`, worker successfully owns the job and proceeds to `processJob(job)`.
   - If `result.changes === 0` (collision with another worker), worker queries pending count:
     - If pending count > 0: yields 50 ms and retries claim.
     - If pending count === 0: cleanly exits loop.

### STEP 6: HEIC File Download
1. Worker creates isolated local file paths:
   - HEIC Source: `temp/${job.file_id}.heic`
   - JPG Target: `temp/${job.file_id}.jpg`
2. Invokes `drive.downloadFile(job.file_id, tempHeicPath)`:
   - Opens local write stream `fs.createWriteStream(tempHeicPath)`.
   - Calls `drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' })`.
   - Pipes HTTP media stream directly to disk.
   - Cleans up and destroys stream if an error occurs.

### STEP 7: Local HEIC Conversion & Color Normalization
1. Worker calls `converter.convertHeicToJpg(tempHeicPath, tempJpgPath)`.
2. Executes Python script `src/convert_heic.py` via `python3` / virtualenv:
   - `pillow_heif.open_heif(input_path, convert_hdr_to_8bit=True)` decodes Apple 10-bit HDR HEIC without green/red tile artifacts.
   - `ImageOps.exif_transpose(image)` handles EXIF rotation.
   - `ImageCms.profileToProfile(image, input_profile, srgb_profile, outputMode="RGB")` converts pixels from Display P3 color space to standard sRGB.
   - Embeds sRGB ICC profile metadata.
   - Flattens transparency onto a clean white `(255, 255, 255)` background.
   - Saves JPEG with `subsampling=0` (4:4:4 chroma subsampling) and `quality=95`.
3. If Python fails, cascades through `ffmpeg-native`, `sharp-direct`, and WASM fallback engines.

### STEP 8: Pre-Upload Quality & Integrity Validation
1. Worker calls `validator.validateJpg(tempJpgPath)` (`src/validator.js`):
   - **File Existence**: Confirms file exists on disk.
   - **File Size**: Confirms `stats.size >= 1024` bytes (> 1 KB).
   - **Magic Bytes**: Reads first 3 bytes and verifies `0xFF, 0xD8, 0xFF`.
   - **Dimension Check**: Parses width and height using `image-size`.
   - **Channel Sanity**: Sharp metadata inspects channel count ($\ge 3$).
2. If any check fails, throws validation error and halts upload.

### STEP 9: Multi-Pass Targeted OCR & Jewelry Tag Detection
1. Worker calls `ocr.detectTagFromImage(tempJpgPath)` (`src/ocr.js`).
2. Reads image buffer into memory once (`imageBuffer`).
3. Acquires worker from `OcrWorkerPool`.
4. **Pass 1 (Velvet Cushion Crop)**:
   - Crops upper/center cushion region (85% width, 65% height).
   - Resizes to 1200 px width, converts to grayscale, applies **binary threshold 175**, and negates (pure black text on pure white).
   - Runs Tesseract with `PSM 11` (Sparse Text).
   - Evaluates text with `extractTagPattern()`. If tag found (e.g., `DBR334`), returns immediately.
5. **Pass 2 (Full-Frame High-Res)**:
   - If Pass 1 found nothing, runs full-frame normalized image with `PSM 11`, followed by `PSM 6`.
6. **Pass 3 & 4 (High/Medium Contrast Inversion)**:
   - Evaluates full-frame threshold 165 and threshold 125.
7. Normalizes detected text:
   - Corrects `0BR334` $\to$ `DBR334`.
   - Repairs separated prefixes (`D.BR 334` $\to$ `DBR334`).
   - Fixes ghost characters (`DERS556` $\to$ `DER556`) and trailing digit substitutions (`DBR32B` $\to$ `DBR328`).
8. Releases OCR worker back to pool and frees buffer memory.

### STEP 10: Target Filename Generation & Collision Handling
1. If tag detected (e.g., `DBR334`):
   - Calls `drive.getUniqueFilenameInFolder('DBR334', '.jpg')`.
   - Checks `folderFilenameCache` for `DBR334.jpg`. If already present in folder, increments counter: `DBR334_1.jpg`, `DBR334_2.jpg`, etc.
   - Sets `uploadFilename = 'DBR334.jpg'` and `renameType = 'TAG_OCR'`.
2. If NO tag detected:
   - Uses base filename: `drive.getUniqueFilenameInFolder('IMG_9422', '.jpg')` $\to$ `IMG_9422.jpg`.
   - Sets `renameType = 'ORIGINAL_NAME'`.

### STEP 11: Google Drive Upload
1. Calls `drive.uploadFile(uploadFilename, tempJpgPath)`:
   - Creates read stream `fs.createReadStream(tempJpgPath)`.
   - Calls `drive.files.create()` with `parents: [config.driveFolderId]` and `mimeType: 'image/jpeg'`.
   - Adds uploaded filename to `folderFilenameCache`.
2. Receives uploaded file metadata (`id`, `name`, `size`).

### STEP 12: Post-Upload Verification on Google Drive
1. Calls `drive.checkFileExists(uploadedFile.id)`:
   - Calls `drive.files.get({ fileId: uploadedFile.id, fields: 'id, name, size, trashed' })`.
   - Confirms the file exists in Google Drive, has non-zero size, and is `trashed === false`.
2. If verification fails, throws error; the original HEIC file is **NEVER** touched.

### STEP 13: Safe Deletion of Original HEIC
1. Checks `config.testMode`:
   - If `TEST_MODE=true`: logs `[TEST MODE] Skipping trashing of original file: IMG_9422.heic`.
   - If `TEST_MODE=false`: calls `drive.trashFile(job.file_id)` to move original HEIC to Google Drive Trash.

### STEP 14: Job Completion & SQLite Update
1. Calls `updateJobStatus(job.file_id, 'COMPLETED', uploadFilename)`:
   ```sql
   UPDATE conversion_queue 
   SET status = 'COMPLETED', target_filename = ?, completed_at = ?, updated_at = ?
   WHERE file_id = ?;
   ```
2. Logs: `[INFO] Successfully completed & verified job for IMG_9422.heic -> DBR334.jpg [TAG_OCR]`.

### STEP 15: Temp File Cleanup
1. In `processJob()` `finally` block:
   - Calls `cleanTempFiles(tempHeicPath, tempJpgPath)`.
   - Unlinks `temp/${job.file_id}.heic` and `temp/${job.file_id}.jpg`.
2. Ensures 0 disk space leakage per completed conversion.

### STEP 16: Immediate Next Job Execution
1. Worker yields 50 ms to keep event loop balanced.
2. Loops back to `claimNextPendingJob()` to immediately claim the next pending file without waiting for the Drive polling timer.

---

## 3. Workflow Diagrams

### 3.1 Google Drive to Queue Flow

```mermaid
flowchart TD
    Poller[Drive Poller / checkFolder] --> API[Google Drive API: files.list]
    API --> Filter{Check Each File}
    Filter -->|ext !== 'heic'| DropNonHeic[Skip non-HEIC]
    Filter -->|Incompatible MIME| DropMime[Skip MIME]
    Filter -->|Valid HEIC| CheckDB{In SQLite Queue?}
    CheckDB -->|Yes| DropDB[Skip already recorded]
    CheckDB -->|No| CheckJpg{Duplicate JPG in Folder?}
    CheckJpg -->|Yes & TEST_MODE=false| TrashOrig[Trash duplicate original HEIC]
    CheckJpg -->|Yes| InsertSkip[Insert as SKIPPED in DB]
    CheckJpg -->|No| InsertPending[Insert as PENDING in DB]
    InsertPending --> TriggerWorkers[Trigger queue.processQueue]
```

---

### 3.2 Worker Processing & Concurrency Flow

```mermaid
flowchart TD
    subgraph "Worker Loop Thread"
        StartLoop[workerLoop Invocation] --> Claim[claimNextPendingJob]
        Claim --> CheckClaim{Job Claimed?}
        CheckClaim -->|No| CheckRemaining{DB has PENDING or RETRY_WAIT?}
        CheckRemaining -->|Yes| SleepYield[Yield 50ms lock backoff] --> Claim
        CheckRemaining -->|No| Terminate[Worker Loop Exits Cleanly]
        
        CheckClaim -->|Yes| Download[Download HEIC Stream to temp/]
        Download --> Convert[Convert to sRGB JPG via Python]
        Convert --> Validate[Validate Magic Bytes & Dimensions]
        Validate --> OCR[Run Multi-Pass Local OCR]
        OCR --> NameGen[Generate Unique Filename]
        NameGen --> Upload[Upload JPG to Google Drive]
        Upload --> PostVerify[Verify File Active on Drive]
        PostVerify --> TrashDecision{TEST_MODE == false?}
        TrashDecision -->|Yes| TrashOriginal[Move Original HEIC to Trash]
        TrashDecision -->|No| KeepOriginal[Preserve Original HEIC]
        TrashOriginal --> MarkDone[Mark COMPLETED in SQLite]
        KeepOriginal --> MarkDone
        MarkDone --> CleanupFiles[Delete Local Temp Files]
        CleanupFiles --> YieldNext[Yield 50ms] --> Claim
    end
```

---

### 3.3 Multi-Pass Local OCR Flow

```mermaid
flowchart TD
    In[temp/file_id.jpg] --> ReadBuf[Read Image Buffer into Memory]
    ReadBuf --> PoolAcquire[Acquire Tesseract Worker]
    
    subgraph "Pass 1: Velvet Cushion Crop"
        PoolAcquire --> P1_Crop["Crop Upper/Center Cushion (85%w x 65%h)"]
        P1_Crop --> P1_Thresh["Resize 1800w | Grayscale | Threshold 175 | Negate"]
        P1_Thresh --> P1_Tess["Tesseract OCR (PSM 11)"]
        P1_Tess --> P1_Check{Valid Tag Pattern?}
    end

    subgraph "Pass 2: Full-Frame High-Res"
        P1_Check -->|No| P2_Prep["Full Frame Resize 1800w | Grayscale | Normalise"]
        P2_Prep --> P2_Tess11["Tesseract OCR (PSM 11)"]
        P2_Tess11 --> P2_Check11{Valid Tag Pattern?}
        P2_Check11 -->|No| P2_Tess6["Tesseract OCR (PSM 6)"]
        P2_Tess6 --> P2_Check6{Valid Tag Pattern?}
    end

    subgraph "Pass 3 & 4: Multi-Contrast Fallback"
        P2_Check6 -->|No| P3_Thresh["Full Frame Threshold 165 | Negate | PSM 11"]
        P3_Thresh --> P3_Check{Valid Tag Pattern?}
        P3_Check -->|No| P4_Thresh["Full Frame Threshold 125 | Negate | PSM 11"]
        P4_Thresh --> P4_Check{Valid Tag Pattern?}
    end

    P1_Check -->|Yes| Success[Return Normalized Tag SKU]
    P2_Check11 -->|Yes| Success
    P2_Check6 -->|Yes| Success
    P3_Check -->|Yes| Success
    P4_Check -->|Yes| Success
    P4_Check -->|No| Fail[Return null -> Fallback to Original Name]

    Success & Fail --> PoolRelease[Release Tesseract Worker to Pool]
```

---

### 3.4 Tag to Filename Mapping & Suffix Flow

```mermaid
flowchart TD
    InputTag[OCR Detected Tag / Fallback Base] --> CheckCache{Exists in folderFilenameCache?}
    CheckCache -->|No| AssignOriginal["filename = tag + '.jpg'"]
    AssignOriginal --> UpdateCache["folderFilenameCache.add(filename)"]
    UpdateCache --> ReturnName[Return Unique Filename]

    CheckCache -->|Yes| InitCounter["counter = 1"]
    InitCounter --> CheckSuffix{"Exists tag + '_' + counter + '.jpg'?"}
    CheckSuffix -->|Yes| IncCounter["counter++"] --> CheckSuffix
    CheckSuffix -->|No| AssignSuffix["filename = tag + '_' + counter + '.jpg'"]
    AssignSuffix --> UpdateCache
```

---

### 3.5 Error, Retry & Backoff Flow

```mermaid
flowchart TD
    ErrorThrown[Job Processing Throws Error] --> LogErr[logger.error: Log Message & Stack]
    LogErr --> GetAttempts[Query Current Job attempts from DB]
    GetAttempts --> IncAttempts["newAttempts = attempts + 1"]
    IncAttempts --> CheckMax{newAttempts >= MAX_ATTEMPTS (4)?}
    
    CheckMax -->|Yes| MarkFail["status = 'FAILED'<br/>next_retry_at = 0"]
    CheckMax -->|No| CalcBackoff["backoff = [60s, 120s, 300s, 900s][attempts-1]<br/>next_retry_at = Date.now() + backoff<br/>status = 'RETRY_WAIT'"]
    
    MarkFail --> UpdateDB["UPDATE conversion_queue SET status, attempts, last_error, next_retry_at"]
    CalcBackoff --> UpdateDB
    UpdateDB --> CleanTemp[cleanTempFiles: Delete local .heic/.jpg]
    CleanTemp --> NextJob[Worker immediately claims next available job]
```

---

### 3.6 Graceful Shutdown Flow

```mermaid
flowchart TD
    Signal[Receive SIGTERM / SIGINT Signal] --> LogShutdown[Log Shutdown Notice]
    LogShutdown --> StopTimer[clearInterval Polling Loop]
    StopTimer --> SetShutdownFlag["queue.shutdown(): isGracefulShutdown = true"]
    SetShutdownFlag --> PollWorkers{activeConversions > 0 AND elapsed < 10s?}
    PollWorkers -->|Yes| WaitYield[Sleep 1000ms] --> PollWorkers
    PollWorkers -->|No / Timeout| TerminateOCR[ocr.terminateWorker: Kill Tesseract Workers]
    TerminateOCR --> CloseDB[db.db.close: Release SQLite Database Locks]
    CloseDB --> ExitProcess[process.exit(0): Daemon Exits Cleanly]
```

---

### 3.7 Folder-Level Converted Image Verification & Auto-Repair Flow

```mermaid
flowchart TD
    Start["Run npm run verify:folder (Separate Process)"] --> InitDB[Initialize SQLite DB & verification_audit]
    InitDB --> InitPool["Create Dedicated OCR Pool (Concurrency = 1)"]
    InitPool --> ListDrive[Query Google Drive folder for JPGs]
    ListDrive --> FilterJPG[Filter non-JPGs & QA files]
    FilterJPG --> CheckAuditTable{Already VERIFIED or REPAIRED?}
    CheckAuditTable -->|Yes| Skip[Skip redundant download & OCR]
    CheckAuditTable -->|No| CheckQueueIdle{Conversion Queue Idle?<br/>PENDING == 0 & PROCESSING == 0}
    CheckQueueIdle -->|No| YieldSleep[Yield to Conversions: Sleep 5s] --> CheckQueueIdle
    CheckQueueIdle -->|Yes| DownloadJPG[Download JPG to temp/verifier/]
    DownloadJPG --> ValidateJPG[Validate JPEG Headers & Dimensions]
    ValidateJPG -->|Corrupt/Invalid| MarkFailed["Record status = 'FAILED'"]
    ValidateJPG -->|Valid| RunOCR["Run Local OCR via verifyOcrPool (Isolated)"]
    RunOCR --> ExtractNameTag[Extract Expected Tag from Filename]
    ExtractNameTag --> CompareTags{Exact Equality Check:<br/>expectedTag === detectedTag?}
    CompareTags -->|Exact Match| MarkVerified["Record status = 'VERIFIED'"]
    CompareTags -->|Differs or Generic Name| ValidateSanity{verifyTagSanity passed?}
    ValidateSanity -->|No| MarkReview["Record status = 'REVIEW_REQUIRED'"]
    ValidateSanity -->|Yes| CheckCollision{Target &lt;tag&gt;.jpg exists on Drive?}
    CheckCollision -->|Yes| MarkConflict["Record status = 'REPAIR_CONFLICT'<br/>(Prevent Overwrite)"]
    CheckCollision -->|No| DriveRename["drive.renameFile(fileId, targetFilename)"]
    DriveRename -->|Success| VerifyDrive["drive.checkFileExists(fileId)"] --> MarkRepaired["Record status = 'REPAIRED'"]
    DriveRename -->|Failure| MarkRepairFailed["Record status = 'REPAIR_FAILED'"]
    CompareTags -->|No Tag Found| MarkNoTag["Record status = 'NO_TAG_DETECTED'"]
    MarkFailed & MarkVerified & MarkRepaired & MarkConflict & MarkRepairFailed & MarkReview & MarkNoTag --> CleanTemp[Delete local temp JPG]
    CleanTemp --> Throttle[Sleep 500ms Throttle]
    Throttle --> NextFile{More files in batch?}
    NextFile -->|Yes| CheckQueueIdle
    NextFile -->|No| TerminateVerify[Terminate verifyOcrPool & Print Report]
```

