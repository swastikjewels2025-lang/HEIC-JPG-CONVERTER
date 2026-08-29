# Google Drive HEIC → JPG Automatic Conversion System

This system uses **Google Apps Script** and the **CloudConvert API v2** to automatically convert images uploaded to a specific Google Drive folder into JPG format. 

> [!IMPORTANT]
> The automation converts ONLY HEIC (.heic) images to JPG. All other file formats are skipped.

To process high volumes of files (1,000+ images) without timing out or exceeding API rate limits, it uses an **asynchronous queue architecture** powered by Apps Script's `PropertiesService`.

---

## Architecture & How It Works

```
                     GOOGLE DRIVE FOLDER
                              │
          ┌───────────────────┴───────────────────┐
          │                                       │
    Bulk Backlog                            New Uploads
   (1000+ Images)                           (HEIC, PNG, etc.)
          │                                       │
          └───────────────────┬───────────────────┘
                              │
                              ▼
                         Apps Script
                     (1-minute Trigger)
                              │
                              ▼
                        Queue Manager
                              │
     ┌────────────────────────┴────────────────────────┐
     ▼ (Process Completions)                           ▼ (Submit New Jobs)
[Check Active Queue]                              [Scan Folder Candidates]
  - Query CloudConvert task statuses                - Filter out queued/blocked files
  - For 'finished' jobs:                            - Sort descending by date (newest first)
    - Download JPG and upload to Drive              - Verify if valid JPG already exists
    - Verify non-zero size                          - Create CloudConvert job (import/convert/export)
    - Safe-delete original (if TEST_MODE is false)   - Upload original file to CloudConvert
    - Remove from active queue                      - Save job info to persistent queue
  - For 'error' jobs:                               - Limit submissions to MAX_CONCURRENT_JOBS
    - Drop from queue and blocklist for 1 hour      - Respect MAX_NEW_JOBS_PER_RUN limit
```

### Key Queue & Optimization Features
1. **Asynchronous Execution**: The script never blocks or polls waiting for a conversion to finish. It submits jobs, records their details in script properties, and exits immediately. Completed jobs are checked and processed in subsequent runs.
2. **Date-Based Prioritization**: Convertible files are sorted by creation date descending (newest first). This ensures new uploads are processed within 1-2 minutes and do not get starved by a massive existing backlog.
3. **Single-Pass Folder Scanning**: To prevent exceeding Drive API quotas, the folder is scanned once per run. Existing files and sizes are cached in an in-memory map to optimize duplicate checks and candidates filtering.
4. **Apps Script safety limit (`MAX_EXECUTION_TIME_MS`)**: The script monitors its execution duration and stops starting new tasks when getting close to the limit (default: 4 minutes), ensuring it exits gracefully before a hard GAS timeout occurs.
5. **Strict Deletion Guard**: Original images are never moved to the Google Drive Trash unless the resulting JPG is successfully saved and verified (exists and size > 0).
6. **Self-Healing Duplicate Cleanup**: If a previous run converted a file but terminated before deleting the original, the script detects the valid JPG during scanning, skips re-conversion, and safely cleans up the original.
7. **Resilient Failure Handling**: Failed conversions are blocklisted using `CacheService` for 1 hour. A single corrupt image will not block the remaining queue.

---

## Configuration Reference

Customize the behavior of the system by editing the `CONFIG` object at the top of `Code.js`:

| Config Property | Default | Description |
| :--- | :--- | :--- |
| `DRIVE_FOLDER_ID` | `"PASTE_FOLDER_ID_HERE"` | The Google Drive Folder ID to monitor. |
| `CLOUDCONVERT_API_KEY_PROPERTY` | `"CLOUDCONVERT_API_KEY"` | The Script Properties key storing your API key. |
| `MAX_CONCURRENT_JOBS` | `20` | Maximum active CloudConvert jobs tracked in the queue at once. |
| `MAX_NEW_JOBS_PER_RUN` | `20` | Maximum new conversions submitted in a single script run. |
| `MAX_COMPLETIONS_PER_RUN` | `20` | Maximum finished JPGs downloaded and saved in a single run. |
| `TRIGGER_INTERVAL_MINUTES` | `1` | Trigger interval. A time-driven trigger executes the script every 1 minute. |
| `TEST_MODE` | `true` | If true, original files are **not** moved to Trash (useful for safe testing). |
| `MAX_EXECUTION_TIME_MS` | `240000` | Safety execution threshold (4 minutes) after which the script exits cleanly. |
| `JOB_TIMEOUT_MS` | `7200000` | Time (2 hours in ms) after which stuck jobs are timed out and removed. |

---

## Setup Instructions

### Step 1: Prepare Google Drive Folder
1. Create or open the folder in Google Drive where you want images to be processed.
2. Copy the **Folder ID** from your browser's address bar (the string at the end of the URL).
3. Open `Code.js` and paste the Folder ID into the `CONFIG` block:
   ```javascript
   DRIVE_FOLDER_ID: "YOUR_FOLDER_ID",
   ```

### Step 2: SECURE API Key Storage
1. Go to the [CloudConvert Dashboard](https://cloudconvert.com/) and create a new API key.
2. Store it securely in Apps Script properties:
   - Click the **Gear icon (Project Settings)** on the left sidebar of the Apps Script Editor.
   - Scroll to **Script Properties** and click **Add script property**.
   - Name the property `CLOUDCONVERT_API_KEY` and paste your key as the value. Click **Save**.

### Step 3: Setup the Automation Trigger
1. In the Apps Script editor toolbar, select the function `setupTrigger` and click **Run**.
2. This creates a time-driven trigger that executes `processNewImages()` every 1 minute.

---

## Queue Operations & Diagnostics

The script offers dedicated tools to check queue status and reset state:

### 1. Show Queue Status
Select the function `showQueueStatus` from the editor's function list and click **Run** (or select **Show Queue Status** from the spreadsheet/document menu). It prints a diagnostic report in the logs:
- **Total Files in Folder**: Total file count.
- **Existing JPG/JPEG Files**: Converted files.
- **Active Jobs in Queue**: Currently active jobs tracked in `Script Properties`.
- **Jobs Currently Processing**: Active jobs found in folder.
- **Eligible Images Pending Submission**: Unconverted images ready to start.
- **Files Temporarily Blocked**: Files that failed recently and are blocked for 1 hour.

### 2. Reset Queue
If you ever want to clear the pending queue and start fresh, run the `resetQueue` function from the editor dropdown (or the document menu). This deletes the `CLOUDCONVERT_QUEUE` Script Property safely.

---

## Step-by-Step Testing Plan

Before processing 1,000+ files, follow this sequence to verify setup:

1. **Test 1 (Single HEIC, TEST_MODE = true)**:
   - Upload 1 HEIC file.
   - Run `processNewImages()`. It creates a job and uploads the file.
   - Run `processNewImages()` again 1 minute later. It downloads the JPG, verifies its size, and preserves the original HEIC.
2. **Test 2 (Bulk HEIC, TEST_MODE = true)**:
   - Upload 5–10 HEIC files.
   - Run `processNewImages()`. It submits all jobs.
   - Wait 1 minute and run again. Verify that all JPGs are created and no originals are deleted.
3. **Test 3 (New Upload Priority)**:
   - While backlog is queued, upload a new HEIC.
   - Run `processNewImages()`. Check the logs to verify that the new file's job is submitted first.
4. **Test 4 (Failure Isolation)**:
   - Upload a corrupted file.
   - Run the script and verify that it logs the failure, blocks it, and continues processing other files without stalling.
5. **Test 5 (Duplicate Prevention)**:
   - Place a `photo.HEIC` and `photo.jpg` in the folder.
   - Run the script. It must skip converting and leave the JPG untouched.
6. **Test 6 (Production Deletion)**:
   - Set `TEST_MODE: false` in `CONFIG`.
   - Upload a HEIC and run the script.
   - Verify the JPG is created, and the original HEIC is moved to the Google Drive **Trash**.
