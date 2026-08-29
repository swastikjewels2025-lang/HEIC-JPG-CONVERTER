# HEIC to JPG Google Drive Converter Service (Self-Hosted on VPS)

A Node.js production-grade service running 24/7 on a VPS to automatically list, convert, and manage HEIC image uploads in a specific Google Drive folder. Image decoding is done locally on the VPS, requiring zero external API usage or subscription costs.

---

## Key Features
- **Local Conversion**: Decodes HEIC files locally on the VPS using system-level `heif-convert` (part of `libheif-examples` Ubuntu libraries) for efficient performance.
- **Asynchronous Queue**: Uses a local, persistent **SQLite database** to coordinate candidate jobs. Concurrency is limited (`MAX_CONCURRENT_CONVERSIONS`), providing backpressure and preventing server resource exhaustion.
- **Resilient Retry Handling**: Tracks attempts and reschedules temporary failures (network drops, API rate limits) using exponential backoff (1m, 2m, 5m, 15m) up to 4 attempts.
- **MIME & Extension Security**: Only converts files ending in `.heic` (case-insensitive) and validates MIME types to ignore non-image uploads.
- **Safe Original Deletion**: Original files are only moved to Google Drive Trash after the uploaded JPG is verified on Drive.
- **TEST_MODE**: Configurable safety mode to test conversion outputs without deleting original HEIC files.
- **Process Management**: Integrated with PM2 for automatic reboots and graceful shutdown hooks (releasing DB locks and cleaning up temp files).

---

## 1. System Requirements & System Packages (VPS Ubuntu)

To run the converter, the VPS must have Node.js (v18+) and system HEIC decoding libraries installed.

Log in to your Hostinger VPS and install `libheif-examples` and `build-essential`:
```bash
sudo apt-get update
sudo apt-get install -y libheif-examples build-essential
```
*Note: This command registers the `heif-convert` binary globally.*

---

## 2. Google Cloud Platform & Service Account Configuration

This service utilizes a Service Account to access Google Drive server-to-server.

### Step A: Enable APIs on Google Cloud Console
1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g., `heic-drive-converter`).
3. Navigate to **APIs & Services > Library**.
4. Search for **Google Drive API** and click **Enable**.

### Step B: Create a Service Account
1. Navigate to **APIs & Services > Credentials**.
2. Click **Create Credentials** at the top and select **Service Account**.
3. Fill in the service account details (e.g. name: `drive-converter-vps`) and click **Create and Continue**.
4. Skip optional roles and click **Done**.

### Step C: Create & Download Credentials JSON Key
1. In the Service Accounts list, click on the email address of the service account you just created.
2. Click on the **Keys** tab.
3. Click **Add Key > Create New Key**.
4. Select **JSON** format and click **Create**.
5. Save the downloaded JSON file as `credentials.json` and place it securely in the project's root folder (`heic-drive-converter/credentials.json`).
   *DO NOT commit this file to Git. It is automatically ignored by the `.gitignore`.*

### Step D: Share target Google Drive Folder
1. Open Google Drive in your browser.
2. Locate the folder you want to monitor, right-click, and select **Share**.
3. Copy the **Service Account email address** (found in your `credentials.json` or Cloud Console, ending with `@...gserviceaccount.com`).
4. Paste it as a new collaborator, grant **Editor** permissions, and click **Share**.
   *Note: Google Drive folders must be explicitly shared with the service account email, or it will be unable to see files.*

---

## 3. Installation & Local Development

1. Clone or copy the project folder to the Hostinger VPS.
2. Navigate into the directory and install Node.js dependencies:
   ```bash
   cd heic-drive-converter
   npm install
   ```
3. Copy the environment template:
   ```bash
   cp .env.example .env
   ```
4. Edit the `.env` file and replace the folder ID and path variables:
   ```ini
   GOOGLE_DRIVE_FOLDER_ID=your_shared_drive_folder_id
   GOOGLE_APPLICATION_CREDENTIALS=credentials.json
   TEST_MODE=true
   MAX_CONCURRENT_CONVERSIONS=4
   JPEG_QUALITY=92
   ```

---

## 4. Operational Scripts & Monitoring

### Standard Daemon Run
Runs the folder scanner once and schedules a polling loop every `POLL_INTERVAL_SECONDS` (default: 60) to check for updates:
```bash
npm start
```

### Initial/Bulk Backlog Scan
To sweep a folder containing 1,000+ files for the first time, run the dedicated bulk scan CLI tool. It populates the queue database, skips already converted JPG files, and processes remaining items in batches until the backlog is fully completed, then exits cleanly:
```bash
npm run scan
```

### Check Queue Status & Metrics
Retrieve queue summary stats, errors, and recent success records from the SQLite database:
```bash
npm run status
```

---

## 5. Deployment with PM2 (Graceful shutdowns and reboots)

To run the application continuously 24/7 on the VPS:

1. Install PM2 globally (if not already installed):
   ```bash
   sudo npm install -y pm2 -g
   ```
2. Start the daemon using the configured `ecosystem.config.js` file:
   ```bash
   pm2 start ecosystem.config.js
   ```
3. Set up PM2 to automatically launch on VPS reboots:
   ```bash
   pm2 startup
   # Execute the command output in your shell to complete setup
   pm2 save
   ```
4. View live logs:
   ```bash
   pm2 logs heic-drive-converter
   ```

### Safe Graceful Shutdown
To stop the service safely without corrupting the queue database or cutting off active conversion operations:
```bash
pm2 stop heic-drive-converter
```
PM2 sends a `SIGTERM` signal. The daemon intercepts this, pauses new queue pulls, awaits completion of currently processing active workers (up to 10 seconds), closes SQLite database locks cleanly, and exits.

---

## 6. Testing Sequence (Verification steps)

Before switching `TEST_MODE=false` in production, execute these steps:

1. **TEST 1: Single HEIC Upload (`TEST_MODE=true`)**
   - Upload 1 HEIC file to the folder.
   - Run `npm start` or check PM2 logs.
   - Verify: HEIC downloaded $\to$ JPG created locally $\to$ JPG validated $\to$ JPG uploaded to Drive $\to$ Original HEIC preserved.
2. **TEST 2: Bulk Queue (`TEST_MODE=true`)**
   - Upload 5 HEIC images.
   - Run `npm run scan` to confirm candidates are queued and processed.
3. **TEST 3: Future Upload Polling**
   - Keep the daemon running. Upload a new HEIC.
   - Verify: Within 60 seconds, the file is detected, converted, and uploaded.
4. **TEST 4-6: Format Skipped Verification**
   - Upload `.jpg`, `.png`, and `.heif` files.
   - Verify: All are ignored and skipped from queue.
5. **TEST 7: Corrupted HEIC**
   - Upload a broken file.
   - Verify: Local converter or image validator fails. The HEIC is retained, logged as `FAILED`, and the queue continues.
6. **TEST 8: Duplicate Prevention**
   - Upload `img_12.heic` and `img_12.jpg` in the folder.
   - Verify: Duplicate check triggers, no conversion is run, and the HEIC is left untouched.
7. **TEST 9: VPS/Daemon Restart**
   - Kill/stop the process during active conversions and start it again.
   - Verify: SQLite state is intact; pending files are fetched and resume processing.
8. **TEST 10: Production Run (`TEST_MODE=false`)**
   - Set `TEST_MODE=false` in `.env` and restart PM2.
   - Upload a HEIC. Verify that after the JPG is validated on Drive, the original HEIC is moved to the Drive **Trash**.
