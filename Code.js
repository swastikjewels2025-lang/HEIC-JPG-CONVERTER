/**
 * Google Drive HEIC -> JPG Automatic Conversion System
 * 
 * This script scans a specified Google Drive folder, identifies non-JPG images
 * (such as HEIC, PNG, WEBP, etc.), sends them to CloudConvert API for conversion,
 * saves the converted JPG back in the same folder, and deletes the original file.
 * 
 * Safety features:
 * 1. Checks if a valid JPG already exists before processing to prevent duplicates and clean up originals.
 * 2. Original file is NEVER deleted unless the JPG is successfully saved and verified.
 * 3. Uses a 1-hour CacheService blocklist for failing files to prevent the queue from getting stuck.
 * 4. Limits file processing per run (MAX_FILES_PER_RUN) to avoid Google Apps Script execution timeouts.
 */

// ==========================================
// 1. CONFIGURATION
// ==========================================
const CONFIG = {
  // Enter your Google Drive Folder ID here. 
  // Example: "1a2b3c4d5e6f7g8h9i0j..." (taken from folder URL)
  DRIVE_FOLDER_ID: "1rYRIfxihMXpSki7UI3mlu609nCwGeflh",

  // The name of the Script Property where the CloudConvert API Key is securely stored
  CLOUDCONVERT_API_KEY_PROPERTY: "CLOUDCONVERT_API_KEY",

  // Maximum concurrent CloudConvert jobs allowed at any time
  MAX_CONCURRENT_JOBS: 20,

  // Maximum new jobs to submit in a single script execution
  MAX_NEW_JOBS_PER_RUN: 20,

  // Maximum completed jobs to download and save in a single execution
  MAX_COMPLETIONS_PER_RUN: 20,

  // Interval for the automated time-driven trigger (in minutes)
  // Supported intervals by Apps Script: 1, 5, 10, 15, 30
  TRIGGER_INTERVAL_MINUTES: 1,

  // If true, original files are not trashed after processing (useful for testing)
  TEST_MODE: true,

  // Safe execution limit before stopping this run (default: 4 minutes / 240,000 ms to avoid 6-min GAS limit)
  MAX_EXECUTION_TIME_MS: 240000,

  // Timeout for an individual job in the queue (default: 2 hours in ms)
  JOB_TIMEOUT_MS: 7200000,

  // Deprecated: replaced by MAX_NEW_JOBS_PER_RUN
  MAX_FILES_PER_RUN: 10
};

// Supported source extensions (case-insensitive)
const CONVERTIBLE_EXTENSIONS = ['heic'];

// Target extension we convert to
const TARGET_EXTENSION = 'jpg';

// Extensions to skip entirely
const SKIPPED_EXTENSIONS = ['jpg', 'jpeg'];

// ==========================================
// 2. MAIN ENTRY POINTS
// ==========================================

/**
 * Entry point to process existing images.
 * Designed to be run manually from the Apps Script editor or custom menu.
 */
function processExistingImages() {
  processImages("Manual Run (Existing Images)");
}

/**
 * Entry point for automated execution.
 * Designed to be run by the Apps Script time-driven trigger.
 */
function processNewImages() {
  processImages("Trigger Run (New Images)");
}

/**
 * Standard trigger setup function.
 * Creates the time-driven trigger to run processNewImages() automatically.
 */
function setupTrigger() {
  const triggerFunctionName = 'processNewImages';

  // Clean up any existing triggers for this function to prevent duplicate schedules
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === triggerFunctionName) {
      logInfo("Existing trigger for " + triggerFunctionName + " found. Removing it...");
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Create a new time-driven trigger
  const interval = CONFIG.TRIGGER_INTERVAL_MINUTES;
  ScriptApp.newTrigger(triggerFunctionName)
    .timeBased()
    .everyMinutes(interval)
    .create();

  logInfo("Successfully scheduled a time-driven trigger for '" + triggerFunctionName + "' to run every " + interval + " minutes.");
}

// ==========================================
// 3. CORE LOGIC
// ==========================================

/**
 * Scans the configured Google Drive folder and processes files up to the batch limit.
 * 
 * @param {string} runType Name of the execution mode (for logging purposes)
 */
/**
 * Scans the configured Google Drive folder and processes files asynchronously using a queue.
 * 
 * @param {string} runType Name of the execution mode (for logging purposes)
 */
function processImages(runType) {
  logInfo("=== Starting " + runType + " ===");

  const lock = LockService.getScriptLock();
  // Try to lock for 0 seconds (exit immediately if another run is active)
  if (!lock.tryLock(0)) {
    logInfo("Another instance of the script is currently running. Exiting to prevent overlap.");
    return;
  }

  const startTime = Date.now();

  try {
    // 1. Verify Folder Configuration
    if (!CONFIG.DRIVE_FOLDER_ID || CONFIG.DRIVE_FOLDER_ID === "PASTE_FOLDER_ID_HERE") {
      logError("Folder ID is not configured. Please paste your Google Drive Folder ID in CONFIG.DRIVE_FOLDER_ID.");
      return;
    }

    let folder;
    try {
      folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
    } catch (e) {
      logError("Could not access Google Drive Folder ID: " + CONFIG.DRIVE_FOLDER_ID + ". Error: " + e.message);
      return;
    }

    // 2. Fetch API Key
    let apiKey;
    try {
      apiKey = getCloudConvertApiKey();
    } catch (e) {
      logError(e.message);
      return;
    }

    // 3. Process completed jobs from the persistent queue
    processCompletions(folder, apiKey, startTime);

    // 4. Submit new conversions if queue has capacity
    submitNewConversions(folder, apiKey, startTime);

  } catch (err) {
    logError("Critical error in processImages: " + err.message);
  } finally {
    logInfo("=== Finished " + runType + " ===");
    lock.releaseLock();
  }
}

/**
 * Checks the status of pending jobs in the queue, downloads finished JPGs, and updates the queue.
 * 
 * @param {GoogleAppsScript.Drive.Folder} folder Drive folder object
 * @param {string} apiKey CloudConvert API key
 * @param {number} startTime Timestamp of script execution start
 */
function processCompletions(folder, apiKey, startTime) {
  let queue = getQueue();
  if (queue.length === 0) {
    logInfo("No pending jobs in the queue to check.");
    return;
  }

  logInfo("Checking " + queue.length + " pending jobs in the queue...");
  let updatedQueue = [];
  let completedCount = 0;
  let failureCount = 0;
  let completionsProcessed = 0;

  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];

    // Check execution safety limit
    if (Date.now() - startTime > CONFIG.MAX_EXECUTION_TIME_MS) {
      logInfo("Execution safety limit reached during completion checks. Leaving remaining " + (queue.length - i) + " jobs in queue.");
      updatedQueue = updatedQueue.concat(queue.slice(i));
      break;
    }

    // Check job timeout
    const age = Date.now() - job.createdTime;
    if (age > CONFIG.JOB_TIMEOUT_MS) {
      logInfo("Job ID: " + job.jobId + " for file '" + job.filename + "' exceeded timeout. Removing from queue.");
      markFileAsFailedInCache(job.fileId);
      failureCount++;
      continue;
    }

    // Respect MAX_COMPLETIONS_PER_RUN limit
    if (completionsProcessed >= CONFIG.MAX_COMPLETIONS_PER_RUN) {
      logInfo("Reached maximum completions limit per run (" + CONFIG.MAX_COMPLETIONS_PER_RUN + "). Leaving remaining jobs in queue.");
      updatedQueue = updatedQueue.concat(queue.slice(i));
      break;
    }

    try {
      logInfo("Checking status of Job ID: " + job.jobId + " (File: '" + job.filename + "')...");
      const jobDetails = getCloudConvertJob(job.jobId, apiKey);
      const status = jobDetails.status;

      if (status === 'finished') {
        logInfo("Job ID: " + job.jobId + " finished! Fetching output details...");

        const exportTask = jobDetails.tasks.find(t => t.operation === 'export/url');
        if (!exportTask || !exportTask.result || !exportTask.result.files || exportTask.result.files.length === 0) {
          throw new Error("Finished job did not contain export file URLs.");
        }

        const downloadUrl = exportTask.result.files[0].url;
        logInfo("Downloading converted JPG...");
        const convertedBlob = downloadFile(downloadUrl);
        convertedBlob.setName(job.targetFilename);

        logInfo("Uploading converted JPG to Google Drive...");
        const savedFile = folder.createFile(convertedBlob);

        // Verify JPG is not empty
        if (!savedFile || savedFile.getSize() === 0) {
          throw new Error("Saved JPG validation failed. File is null or empty.");
        }
        logInfo("Successfully saved: '" + job.targetFilename + "' (ID: " + savedFile.getId() + ", Size: " + savedFile.getSize() + " bytes)");

        // Safe original file deletion
        if (CONFIG.TEST_MODE) {
          logInfo("TEST_MODE enabled: Keeping original file '" + job.filename + "'.");
        } else {
          try {
            logInfo("Trashing original file '" + job.filename + "'...");
            const originalFile = DriveApp.getFileById(job.fileId);
            originalFile.setTrashed(true);
            logInfo("Original file trashed successfully.");
          } catch (delErr) {
            logError("Failed to trash original file ID " + job.fileId + ": " + delErr.message);
          }
        }

        completedCount++;
        completionsProcessed++;
      } else if (status === 'error') {
        let taskErrorMsg = jobDetails.message || "Unknown conversion task error";
        let taskErrorCode = jobDetails.code || "UNKNOWN";
        if (jobDetails.tasks && jobDetails.tasks.length > 0) {
          const errorTask = jobDetails.tasks.find(t => t.status === 'error');
          if (errorTask && errorTask.message) {
            taskErrorMsg = errorTask.message;
            taskErrorCode = errorTask.code || taskErrorCode;
          }
        }
        throw new Error("CloudConvert job status is error. Code: " + taskErrorCode + ", Details: " + taskErrorMsg);
      } else {
        // Still processing (waiting, processing, etc.)
        logInfo("Job ID: " + job.jobId + " is still '" + status + "'. Keeping in queue.");
        updatedQueue.push(job);
      }

    } catch (err) {
      logError("Failed to process completion check for '" + job.filename + "': " + err.message);
      markFileAsFailedInCache(job.fileId);
      failureCount++;
    }
  }

  saveQueue(updatedQueue);
  logInfo("Completed processing checks: " + completedCount + " saved, " + failureCount + " failed, " + updatedQueue.length + " remaining in queue.");
}

/**
 * Scans the Drive folder, identifies eligible files, sorts them newest first, and submits them to CloudConvert.
 * 
 * @param {GoogleAppsScript.Drive.Folder} folder Drive folder object
 * @param {string} apiKey CloudConvert API key
 * @param {number} startTime Timestamp of script execution start
 */
function submitNewConversions(folder, apiKey, startTime) {
  const queue = getQueue();
  const currentActiveCount = queue.length;
  const capacity = CONFIG.MAX_CONCURRENT_JOBS - currentActiveCount;

  if (capacity <= 0) {
    logInfo("Queue is at capacity (" + currentActiveCount + "/" + CONFIG.MAX_CONCURRENT_JOBS + "). Skipping new submissions.");
    return;
  }

  logInfo("Queue capacity: " + capacity + " slot(s) available. Scanning folder for files...");

  // Single-pass scan to build in-memory maps
  const existingJpgMap = new Map(); // lowercase name -> size
  const candidates = [];
  const files = folder.getFiles();

  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    const ext = getFileExtension(name);

    if (SKIPPED_EXTENSIONS.includes(ext)) {
      existingJpgMap.set(name.toLowerCase(), file.getSize());
    } else if (CONVERTIBLE_EXTENSIONS.includes(ext)) {
      let mimeType = "";
      try {
        mimeType = file.getMimeType();
      } catch (mimeErr) {
        logError("Failed to fetch MIME type for '" + name + "': " + mimeErr.message);
      }

      let isMimeValid = true;
      if (mimeType) {
        const lowerMime = mimeType.toLowerCase();
        // Skip clearly non-image/HEIC-compatible files (e.g. text, zip, pdf, audio, video).
        // Standard HEIC files might have generic application/octet-stream or image/heic.
        if (lowerMime.startsWith("text/") || 
            lowerMime.startsWith("audio/") || 
            lowerMime.startsWith("video/") || 
            lowerMime === "application/pdf" || 
            lowerMime === "application/zip" || 
            lowerMime === "application/json") {
          isMimeValid = false;
        }
      }

      if (!isMimeValid) {
        logInfo("Skipping candidate '" + name + "' because MIME type '" + mimeType + "' is not HEIC-compatible.");
        continue;
      }

      logInfo("Found candidate: '" + name + "' with MIME type: '" + mimeType + "'");
      candidates.push({
        file: file,
        id: file.getId(),
        name: name,
        ext: ext
      });
    }
  }

  logInfo("Discovered " + candidates.length + " candidates and " + existingJpgMap.size + " existing JPG/JPEGs in folder.");

  // Filter out candidates already in queue
  const queueFileIds = new Set(queue.map(j => j.fileId));
  let eligibleCandidates = candidates.filter(c => !queueFileIds.has(c.id));

  // Sort by creation date descending (newest first) to prioritize new uploads
  eligibleCandidates.sort((a, b) => {
    try {
      return b.file.getDateCreated().getTime() - a.file.getDateCreated().getTime();
    } catch (e) {
      return 0;
    }
  });

  let newJobsCreated = 0;
  let submittedCount = 0;
  let failureCount = 0;
  let updatedQueue = [...queue];

  for (let i = 0; i < eligibleCandidates.length; i++) {
    // Check execution safety limit
    if (Date.now() - startTime > CONFIG.MAX_EXECUTION_TIME_MS) {
      logInfo("Execution safety limit reached during submission checks. Stopping new submissions.");
      break;
    }

    // Check MAX_NEW_JOBS_PER_RUN limit
    if (newJobsCreated >= CONFIG.MAX_NEW_JOBS_PER_RUN) {
      logInfo("Reached limit of new jobs per run (" + CONFIG.MAX_NEW_JOBS_PER_RUN + ").");
      break;
    }

    // Check current queue capacity
    if (updatedQueue.length >= CONFIG.MAX_CONCURRENT_JOBS) {
      logInfo("Queue filled to maximum capacity (" + CONFIG.MAX_CONCURRENT_JOBS + ").");
      break;
    }

    const candidate = eligibleCandidates[i];
    const filename = candidate.name;
    const fileId = candidate.id;
    const ext = candidate.ext;
    const targetFilename = getOutputFilename(filename);

    // Skip recently failed files in CacheService
    if (isFileFailedInCache(fileId)) {
      continue;
    }

    // Duplicate prevention check using in-memory JPG map
    const existingSize = existingJpgMap.get(targetFilename.toLowerCase());
    if (existingSize !== undefined && existingSize > 0) {
      logInfo("Duplicate check: JPG equivalent already exists and is valid: '" + targetFilename + "'.");
      if (CONFIG.TEST_MODE) {
        logInfo("TEST_MODE enabled: Skipping deletion of original file '" + filename + "'.");
      } else {
        try {
          logInfo("Deleting original file '" + filename + "'...");
          candidate.file.setTrashed(true);
          logInfo("Original file trashed successfully.");
        } catch (delErr) {
          logError("Failed to trash original file ID " + fileId + ": " + delErr.message);
        }
      }
      continue;
    }

    // Submit new job to CloudConvert
    try {
      logInfo("Creating CloudConvert job for: '" + filename + "'...");
      const jobId = createCloudConvertJob(filename, ext, apiKey);
      if (!jobId) {
        throw new Error("Job creation failed (did not receive Job ID).");
      }

      // Fetch upload parameters
      const jobDetails = getCloudConvertJob(jobId, apiKey);
      const importTask = jobDetails.tasks.find(t => t.operation === 'import/upload');
      if (!importTask || !importTask.result || !importTask.result.form) {
        throw new Error("Job details did not contain upload form details.");
      }

      const uploadUrl = importTask.result.form.url;
      const uploadParams = importTask.result.form.parameters;
      const fileBlob = candidate.file.getBlob();

      logInfo("Uploading original image to CloudConvert upload endpoint...");
      uploadFileToCloudConvert(uploadUrl, uploadParams, fileBlob);

      // Save to queue state
      const newJob = {
        jobId: jobId,
        fileId: fileId,
        filename: filename,
        targetFilename: targetFilename,
        createdTime: Date.now()
      };
      updatedQueue.push(newJob);
      saveQueue(updatedQueue);

      logInfo("CloudConvert job successfully submitted. Job ID: " + jobId);
      newJobsCreated++;
      submittedCount++;
    } catch (err) {
      logError("Failed to submit job for '" + filename + "': " + err.message);

      const isQuotaOrRateLimit = err.message.includes("429") || 
                                 err.message.toLowerCase().includes("rate limit") || 
                                 err.message.toLowerCase().includes("quota") || 
                                 err.message.toLowerCase().includes("credits");

      if (isQuotaOrRateLimit) {
        logError("CloudConvert API rate limit, quota or credit warning detected. Backing off submissions.");
        break;
      }

      // Blocklist failed file in cache
      markFileAsFailedInCache(fileId);
      failureCount++;
    }
  }

  logInfo("Completed new submissions: " + submittedCount + " jobs submitted, " + failureCount + " failed/skipped, total queue is now " + updatedQueue.length + " jobs.");
}

/**
 * Handles the end-to-end conversion process for a single file.
 * This function guarantees the original file is not deleted unless the JPG is created and verified.
 * 
 * @param {GoogleAppsScript.Drive.File} file Original image file
 * @param {GoogleAppsScript.Drive.Folder} folder Target folder
 * @param {string} apiKey CloudConvert API Key
 */
function processSingleFile(file, folder, apiKey) {
  const filename = file.getName();
  const ext = getFileExtension(filename);
  const targetFilename = getOutputFilename(filename);

  // Step 1: Create CloudConvert Conversion Job
  const jobId = createCloudConvertJob(filename, ext, apiKey);
  if (!jobId) {
    throw new Error("CloudConvert Job creation failed (did not receive Job ID).");
  }
  logInfo("CloudConvert job created successfully. Job ID: " + jobId);

  // Step 2: Fetch job details to retrieve the upload form URL and parameters
  const jobDetails = getCloudConvertJob(jobId, apiKey);
  const importTask = jobDetails.tasks.find(t => t.operation === 'import/upload');
  if (!importTask || !importTask.result || !importTask.result.form) {
    throw new Error("Job response did not contain upload form details. Task Status: " + (importTask ? importTask.status : "not found"));
  }

  const uploadUrl = importTask.result.form.url;
  const uploadParams = importTask.result.form.parameters;

  // Step 3: Fetch file content from Google Drive and upload to CloudConvert
  logInfo("Uploading original image to CloudConvert upload endpoint...");
  const fileBlob = file.getBlob();
  uploadFileToCloudConvert(uploadUrl, uploadParams, fileBlob);
  logInfo("File uploaded successfully. Waiting for conversion job to complete...");

  // Step 4: Poll CloudConvert until job finishes
  const finishedJob = waitForJobCompletion(jobId, apiKey);
  logInfo("CloudConvert conversion complete!");

  // Step 5: Extract download URL for the resulting JPG
  const exportTask = finishedJob.tasks.find(t => t.operation === 'export/url');
  if (!exportTask || !exportTask.result || !exportTask.result.files || exportTask.result.files.length === 0) {
    throw new Error("Finished job did not contain export file URLs.");
  }

  const downloadUrl = exportTask.result.files[0].url;

  // Step 6: Download the JPG
  logInfo("Downloading converted JPG from CloudConvert...");
  const convertedBlob = downloadFile(downloadUrl);
  convertedBlob.setName(targetFilename);

  // Step 7: Save to Google Drive
  logInfo("Uploading converted JPG to Google Drive...");
  const savedFile = folder.createFile(convertedBlob);

  // Step 8: Verify JPG file exists and is valid (size > 0)
  if (!savedFile || savedFile.getSize() === 0) {
    throw new Error("Google Drive upload validation failed. Saved file is empty or corrupted.");
  }
  logInfo("JPG file successfully saved to Google Drive: '" + targetFilename + "' (ID: " + savedFile.getId() + ")");

  // Step 9: Safe Delete original file
  if (CONFIG.TEST_MODE) {
    logInfo("TEST_MODE enabled: Skipping deletion of original file '" + filename + "'.");
  } else {
    logInfo("Deleting original file: '" + filename + "'...");
    file.setTrashed(true);
    logInfo("Original file '" + filename + "' moved to trash successfully.");
  }
}

// ==========================================
// 4. CLOUDCONVERT API INTEGRATION
// ==========================================

/**
 * Creates a conversion job structure in CloudConvert.
 * 
 * @param {string} filename Name of the source file
 * @param {string} inputFormat Source file extension (e.g. 'heic')
 * @param {string} apiKey CloudConvert API Key
 * @returns {string} The created CloudConvert Job ID
 */
function createCloudConvertJob(filename, inputFormat, apiKey) {
  const url = "https://api.cloudconvert.com/v2/jobs";

  const payload = {
    "tasks": {
      "import-task": {
        "operation": "import/upload"
      },
      "convert-task": {
        "operation": "convert",
        "input": "import-task",
        "input_format": inputFormat,
        "output_format": TARGET_EXTENSION
      },
      "export-task": {
        "operation": "export/url",
        "input": "convert-task"
      }
    }
  };

  const options = {
    "method": "POST",
    "contentType": "application/json",
    "headers": {
      "Authorization": "Bearer " + apiKey
    },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (responseCode < 200 || responseCode >= 300) {
    throw new Error("Failed to create CloudConvert job. HTTP Status: " + responseCode + ", Response: " + responseText);
  }

  const responseData = JSON.parse(responseText);
  return responseData.data.id;
}

/**
 * Fetches the current status and task details of a CloudConvert job.
 * 
 * @param {string} jobId CloudConvert Job ID
 * @param {string} apiKey CloudConvert API Key
 * @returns {Object} Job status object
 */
function getCloudConvertJob(jobId, apiKey) {
  const url = "https://api.cloudconvert.com/v2/jobs/" + jobId;

  const options = {
    "method": "GET",
    "headers": {
      "Authorization": "Bearer " + apiKey
    },
    "muteHttpExceptions": true
  };

  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (responseCode < 200 || responseCode >= 300) {
    throw new Error("Failed to get CloudConvert job details. HTTP Status: " + responseCode + ", Response: " + responseText);
  }

  const responseData = JSON.parse(responseText);
  return responseData.data;
}

/**
 * Uploads a file blob directly to the CloudConvert S3 pre-signed upload URL.
 * 
 * @param {string} uploadUrl S3 Upload Endpoint
 * @param {Object} uploadParams Key-value parameters from CloudConvert (policy, signature, etc.)
 * @param {GoogleAppsScript.Base.Blob} fileBlob Binary file data to upload
 */
function uploadFileToCloudConvert(uploadUrl, uploadParams, fileBlob) {
  // Construct the payload by copying the parameters returned by the API
  const payload = {};
  for (const key in uploadParams) {
    payload[key] = uploadParams[key];
  }

  // CRITICAL: The 'file' field must be the absolute LAST parameter in the multipart form data for S3.
  // JavaScript objects preserve property insertion order for non-integer keys in Apps Script (V8 engine).
  payload['file'] = fileBlob;

  const options = {
    "method": "POST",
    "payload": payload,
    "muteHttpExceptions": true
    // Do NOT set Content-Type header manually; UrlFetchApp generates multipart boundaries automatically.
    // Do NOT include API Bearer authorization token header; S3 pre-signed parameters authenticate the request.
  };

  const response = UrlFetchApp.fetch(uploadUrl, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  // AWS S3 response status for successful POST uploads is typically 204 (No Content) or 201 (Created)
  if (responseCode < 200 || responseCode >= 300) {
    throw new Error("Failed to upload file to CloudConvert storage. HTTP Status: " + responseCode + ", Response: " + responseText);
  }
}

/**
 * Polls the job status endpoint until the conversion is finished or enters an error state.
 * 
 * @param {string} jobId CloudConvert Job ID
 * @param {string} apiKey CloudConvert API Key
 * @returns {Object} Complete finished job object
 */
function waitForJobCompletion(jobId, apiKey) {
  const maxAttempts = 30; // Maximum polling attempts
  const pollIntervalMs = 2000; // 2 seconds between checks (Total timeout: 60 seconds)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    Utilities.sleep(pollIntervalMs);

    let job;
    try {
      job = getCloudConvertJob(jobId, apiKey);
    } catch (e) {
      logError("Polling error on attempt " + attempt + ": " + e.message + ". Retrying...");
      continue;
    }
    const status = job.status;

    if (status === 'finished') {
      return job;
    }

    if (status === 'error') {
      let taskErrorMsg = job.message || "Unknown conversion task error";
      let taskErrorCode = job.code || "UNKNOWN";
      if (job.tasks && job.tasks.length > 0) {
        const errorTask = job.tasks.find(t => t.status === 'error');
        if (errorTask && errorTask.message) {
          taskErrorMsg = errorTask.message;
          taskErrorCode = errorTask.code || taskErrorCode;
        }
      }
      throw new Error("Job entered error status. Code: " + taskErrorCode + ", Details: " + taskErrorMsg);
    }

    // Status is 'waiting' or 'processing', loop continues
  }

  throw new Error("Timeout waiting for CloudConvert conversion (60 seconds exceeded).");
}

/**
 * Downloads the converted file binary from CloudConvert.
 * 
 * @param {string} downloadUrl URL where the file is hosted
 * @returns {GoogleAppsScript.Base.Blob} Downloaded file data blob
 */
function downloadFile(downloadUrl) {
  const options = {
    "method": "GET",
    "muteHttpExceptions": true
  };

  const response = UrlFetchApp.fetch(downloadUrl, options);
  const responseCode = response.getResponseCode();

  if (responseCode < 200 || responseCode >= 300) {
    throw new Error("Failed to download converted JPG file from CloudConvert. HTTP Status: " + responseCode);
  }

  return response.getBlob();
}

// ==========================================
// 5. SECURE CREDENTIAL MANAGERS
// ==========================================

/**
 * Retrieves the CloudConvert API Key from the Google Apps Script Properties Service.
 * Throws a clear error if the key is missing.
 * 
 * @returns {string} The CloudConvert API Key
 */
function getCloudConvertApiKey() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const apiKey = scriptProperties.getProperty(CONFIG.CLOUDCONVERT_API_KEY_PROPERTY);

  if (!apiKey || apiKey.trim() === "") {
    throw new Error("API Key configuration error. Script property '" + CONFIG.CLOUDCONVERT_API_KEY_PROPERTY + "' is not set. Please use setCloudConvertApiKey() or set it in Project Settings.");
  }

  return apiKey.trim();
}

/**
 * Saves the CloudConvert API Key securely using Script Properties.
 * Call this function from the Apps Script editor or use Apps Script Project Settings UI.
 * 
 * @param {string} apiKey The CloudConvert API key to store
 */
function setCloudConvertApiKey(apiKey) {
  if (!apiKey || apiKey.trim() === "") {
    logError("API Key cannot be empty.");
    return;
  }

  PropertiesService.getScriptProperties().setProperty(CONFIG.CLOUDCONVERT_API_KEY_PROPERTY, apiKey.trim());
  logInfo("CloudConvert API Key stored securely in Script Properties under '" + CONFIG.CLOUDCONVERT_API_KEY_PROPERTY + "'.");
}

/**
 * Verifies that the stored API Key is valid by making a lightweight user information request.
 * Useful to run right after setting up the API key.
 * 
 * @returns {string} Success confirmation message
 */
function testCloudConvertConnection() {
  try {
    const apiKey = getCloudConvertApiKey();
    logInfo("Testing connection to CloudConvert API...");

    const url = "https://api.cloudconvert.com/v2/users/me";
    const options = {
      "method": "GET",
      "headers": {
        "Authorization": "Bearer " + apiKey
      },
      "muteHttpExceptions": true
    };

    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (responseCode === 200) {
      const responseData = JSON.parse(responseText);
      const username = responseData.data.username || "Authenticated User";
      const credits = responseData.data.credits !== undefined ? responseData.data.credits : "unlimited";

      const successMsg = "CloudConvert connection test successful! Connected as: " + username + " (Credits remaining: " + credits + ")";
      logInfo(successMsg);
      return successMsg;
    } else {
      const errorMsg = "CloudConvert connection failed. HTTP Status: " + responseCode + ", Response: " + responseText;
      logError(errorMsg);
      throw new Error(errorMsg);
    }
  } catch (err) {
    logError("Connection test error: " + err.message);
    throw err;
  }
}

// ==========================================
// 6. TEMPORARY FAILURE CACHE MANAGER
// ==========================================

/**
 * Marks a file ID as failed in the temporary cache.
 * Uses Google Apps Script CacheService to block reprocessing for 1 hour.
 * This prevents a corrupted file from repeatedly stalling the queue.
 * 
 * @param {string} fileId Google Drive file ID
 */
function markFileAsFailedInCache(fileId) {
  try {
    const cache = CacheService.getScriptCache();
    if (cache) {
      // Store failure flag for 1 hour (3600 seconds)
      cache.put("failed_convert_" + fileId, "true", 3600);
    }
  } catch (e) {
    logError("Failed to write to CacheService: " + e.message);
  }
}

/**
 * Checks if a file ID is marked as failed in the temporary cache.
 * 
 * @param {string} fileId Google Drive file ID
 * @returns {boolean} True if the file has failed recently and is blocked
 */
function isFileFailedInCache(fileId) {
  try {
    const cache = CacheService.getScriptCache();
    if (cache) {
      return cache.get("failed_convert_" + fileId) === "true";
    }
  } catch (e) {
    logError("Failed to read from CacheService: " + e.message);
  }
  // If CacheService fails or is unavailable, default to false to allow attempts
  return false;
}

// ==========================================
// 6.5. PERSISTENT QUEUE MANAGER
// ==========================================

/**
 * Retrieves the pending job queue array from Script Properties.
 * 
 * @returns {Array} List of pending job objects
 */
function getQueue() {
  const props = PropertiesService.getScriptProperties();
  const queueStr = props.getProperty("CLOUDCONVERT_QUEUE");
  if (!queueStr) return [];
  try {
    return JSON.parse(queueStr);
  } catch (e) {
    logError("Failed to parse queue JSON, returning empty array. Value was: " + queueStr);
    return [];
  }
}

/**
 * Persists the pending job queue array in Script Properties.
 * 
 * @param {Array} queue List of pending job objects
 */
function saveQueue(queue) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty("CLOUDCONVERT_QUEUE", JSON.stringify(queue));
}

/**
 * Utility function to clear the active queue in Script Properties.
 * Can be run manually to start fresh.
 */
function resetQueue() {
  const lock = LockService.getScriptLock();
  if (lock.tryLock(5000)) {
    try {
      PropertiesService.getScriptProperties().deleteProperty("CLOUDCONVERT_QUEUE");
      logInfo("Successfully cleared the persistent CloudConvert job queue.");
    } finally {
      lock.releaseLock();
    }
  } else {
    logError("Could not acquire lock to reset the queue. Please try again later.");
  }
}

/**
 * Reports the detailed status of the conversion queue, Drive folder, and CacheService blocks.
 * Designed to be run manually to monitor bulk processing progress.
 * 
 * @returns {string} Text status report
 */
function getConversionStatus() {
  logInfo("=== Fetching Conversion Status ===");
  
  let folder;
  try {
    folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  } catch (e) {
    const errMsg = "Could not access Google Drive Folder ID: " + CONFIG.DRIVE_FOLDER_ID + ". Error: " + e.message;
    logError(errMsg);
    return errMsg;
  }

  // Get active queue
  const queue = getQueue();
  
  // Scan folder to count files
  let totalDiscovered = 0;
  let skippedJpg = 0;
  let convertibleCount = 0;
  let failedBlockedCount = 0;
  
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    const fileId = file.getId();
    const ext = getFileExtension(name);
    
    totalDiscovered++;
    
    if (SKIPPED_EXTENSIONS.includes(ext)) {
      skippedJpg++;
    } else if (CONVERTIBLE_EXTENSIONS.includes(ext)) {
      let mimeType = "";
      try {
        mimeType = file.getMimeType();
      } catch (e) {}

      let isMimeValid = true;
      if (mimeType) {
        const lowerMime = mimeType.toLowerCase();
        if (lowerMime.startsWith("text/") || 
            lowerMime.startsWith("audio/") || 
            lowerMime.startsWith("video/") || 
            lowerMime === "application/pdf" || 
            lowerMime === "application/zip" || 
            lowerMime === "application/json") {
          isMimeValid = false;
        }
      }

      if (isMimeValid) {
        convertibleCount++;
        if (isFileFailedInCache(fileId)) {
          failedBlockedCount++;
        }
      }
    }
  }
  
  const queueFileIds = new Set(queue.map(j => j.fileId));
  let inProgressCount = 0;
  let pendingSubmissionCount = 0;
  
  const folderFiles = folder.getFiles();
  while (folderFiles.hasNext()) {
    const file = folderFiles.next();
    const fileId = file.getId();
    const name = file.getName();
    const ext = getFileExtension(name);
    
    if (CONVERTIBLE_EXTENSIONS.includes(ext)) {
      let mimeType = "";
      try {
        mimeType = file.getMimeType();
      } catch (e) {}

      let isMimeValid = true;
      if (mimeType) {
        const lowerMime = mimeType.toLowerCase();
        if (lowerMime.startsWith("text/") || 
            lowerMime.startsWith("audio/") || 
            lowerMime.startsWith("video/") || 
            lowerMime === "application/pdf" || 
            lowerMime === "application/zip" || 
            lowerMime === "application/json") {
          isMimeValid = false;
        }
      }

      if (!isMimeValid) continue;

      if (queueFileIds.has(fileId)) {
        inProgressCount++;
      } else if (!isFileFailedInCache(fileId)) {
        // Check if JPG equivalent exists to see if it's pending conversion
        const targetFilename = getOutputFilename(name);
        const existingJpgFiles = folder.getFilesByName(targetFilename);
        let exists = false;
        while (existingJpgFiles.hasNext()) {
          if (existingJpgFiles.next().getSize() > 0) {
            exists = true;
            break;
          }
        }
        if (!exists) {
          pendingSubmissionCount++;
        }
      }
    }
  }

  const report = [
    "=== CONVERSION QUEUE STATUS REPORT ===",
    "Google Drive Folder: '" + folder.getName() + "' (ID: " + CONFIG.DRIVE_FOLDER_ID + ")",
    "Total Files in Folder: " + totalDiscovered,
    "Existing JPG/JPEG Files (Skipped): " + skippedJpg,
    "Active Jobs in Queue (Script Properties): " + queue.length,
    "Jobs Currently Processing at CloudConvert: " + inProgressCount,
    "Eligible Images Pending Submission: " + pendingSubmissionCount,
    "Files Temporarily Blocked (CacheService Failure Block): " + failedBlockedCount,
    "TEST_MODE: " + CONFIG.TEST_MODE,
    "======================================"
  ].join("\n");
  
  logInfo("\n" + report);
  return report;
}

/**
 * Menu action alias for getConversionStatus.
 */
function showQueueStatus() {
  const result = getConversionStatus();
  
  // Show UI alert if within spreadsheet/document context
  let ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    try {
      ui = DocumentApp.getUi();
    } catch (err) {}
  }
  
  if (ui) {
    ui.alert("Queue Status Report", result, ui.ButtonSet.OK);
  }
}

// ==========================================
// 7. CONTAINER-BOUND MENU ACTIONS
// ==========================================

/**
 * Automatically runs when a Google Sheet or Google Doc bound to this script is opened.
 * Builds a custom menu interface.
 */
function onOpen(e) {
  let ui;

  // Safely check if active in Spreadsheet
  try {
    if (typeof SpreadsheetApp !== 'undefined') {
      ui = SpreadsheetApp.getUi();
    }
  } catch (err) { /* Not bound to a sheet */ }

  // Safely check if active in Document
  if (!ui) {
    try {
      if (typeof DocumentApp !== 'undefined') {
        ui = DocumentApp.getUi();
      }
    } catch (err) { /* Not bound to a doc */ }
  }

  if (ui) {
    ui.createMenu('Image Converter')
      .addItem('Process Existing Images', 'processExistingImages')
      .addItem('Process New Images', 'processNewImages')
      .addItem('Show Queue Status', 'showQueueStatus')
      .addItem('Reset Queue (Clear Pending)', 'resetQueue')
      .addSeparator()
      .addItem('Test CloudConvert API Key', 'testCloudConvertConnection')
      .addItem('Setup Trigger', 'setupTrigger')
      .addItem('Save API Key via Prompt', 'promptAndSaveApiKey')
      .addToUi();
  }
}

/**
 * Helper menu function to prompt the user to enter their API key securely.
 */
function promptAndSaveApiKey() {
  let ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    try {
      ui = DocumentApp.getUi();
    } catch (err) { }
  }

  if (!ui) {
    logError("Prompt UI is only available in container-bound sheets or documents. Please set the API key in Project Settings or call setCloudConvertApiKey() in the editor.");
    return;
  }

  const result = ui.prompt(
    'Save CloudConvert API Key',
    'Please enter your CloudConvert API Key (it will be saved securely in Script Properties):',
    ui.ButtonSet.OK_CANCEL
  );

  if (result.getSelectedButton() === ui.Button.OK) {
    const key = result.getResponseText().trim();
    if (key !== "") {
      setCloudConvertApiKey(key);
      ui.alert('Success', 'CloudConvert API Key has been saved successfully.', ui.ButtonSet.OK);
    } else {
      ui.alert('Error', 'The API Key input was empty. Key was not saved.', ui.ButtonSet.OK);
    }
  }
}

// ==========================================
// 8. HELPERS
// ==========================================

/**
 * Extracts the lowercase extension of a file.
 * 
 * @param {string} filename Name of the file
 * @returns {string} Lowercase extension (e.g. 'heic') or empty string
 */
function getFileExtension(filename) {
  const parts = filename.split('.');
  if (parts.length > 1) {
    return parts.pop().toLowerCase();
  }
  return '';
}

/**
 * Generates the target filename by stripping the original extension and appending '.jpg'.
 * Example: 'photo.HEIC' -> 'photo.jpg'
 * 
 * @param {string} filename Original filename
 * @returns {string} Target filename
 */
function getOutputFilename(filename) {
  const lastDotIndex = filename.lastIndexOf('.');
  const nameWithoutExtension = lastDotIndex !== -1 ? filename.substring(0, lastDotIndex) : filename;
  return nameWithoutExtension + '.' + TARGET_EXTENSION;
}

/**
 * Unified info logging function.
 * 
 * @param {string} msg Message to log
 */
function logInfo(msg) {
  Logger.log("[INFO] " + msg);
}

/**
 * Unified error logging function.
 * 
 * @param {string} msg Message to log
 */
function logError(msg) {
  Logger.log("[ERROR] " + msg);
}
