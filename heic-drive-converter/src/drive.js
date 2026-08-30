const fs = require('fs');
const { google } = require('googleapis');
const config = require('./config');
const logger = require('./logger');

// Initialize Auth Client (Supports both Service Account JSON and OAuth2 Credentials)
let auth;
try {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
    // OAuth2 User Authentication
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'https://developers.google.com/oauthplayground'
    );
    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    });
    auth = oauth2Client;
    logger.info('Using Google OAuth2 User Credentials for Drive API.');
  } else {
    // Service Account Key Authentication
    if (!fs.existsSync(config.credentialsPath)) {
      logger.warn(`Credentials file not found at ${config.credentialsPath}. The service will fail to authenticate unless environment-default credentials exist.`);
    }
    auth = new google.auth.GoogleAuth({
      keyFile: config.credentialsPath,
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    logger.info('Using Google Service Account for Drive API.');
  }
} catch (err) {
  logger.error('Failed to initialize Google Auth Client: ', err);
  process.exit(1);
}

const drive = google.drive({ version: 'v3', auth });

/**
 * Lists all non-folder, non-trashed files in the configured Drive folder.
 * Handles pagination automatically.
 * 
 * @returns {Promise<Array>} List of Google Drive file resource objects
 */
async function listFolderFiles() {
  let filesList = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${config.driveFolderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, size, mimeType, createdTime)',
      pageSize: 1000,
      pageToken: pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives'
    });
    if (res.data.files) {
      filesList = filesList.concat(res.data.files);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return filesList;
}

/**
 * Downloads a file from Google Drive to the local VPS filesystem.
 * 
 * @param {string} fileId Google Drive file ID
 * @param {string} localPath Destination path on the VPS filesystem
 * @returns {Promise<string>} Path to the downloaded file
 */
async function downloadFile(fileId, localPath) {
  const dest = fs.createWriteStream(localPath);
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    let hasError = false;
    
    res.data
      .on('error', (err) => {
        hasError = true;
        reject(err);
      })
      .pipe(dest);

    dest.on('finish', () => {
      if (!hasError) {
        resolve(localPath);
      }
    });

    dest.on('error', (err) => {
      hasError = true;
      reject(err);
    });
  });
}

/**
 * Uploads a local file from the VPS to the target Google Drive folder.
 * 
 * @param {string} filename Name to save the file as in Google Drive
 * @param {string} localPath Path to the source file on the VPS filesystem
 * @returns {Promise<Object>} Google Drive file metadata object
 */
async function uploadFile(filename, localPath) {
  const fileMetadata = {
    name: filename,
    parents: [config.driveFolderId]
  };
  const media = {
    mimeType: 'image/jpeg',
    body: fs.createReadStream(localPath)
  };

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, name, size',
    supportsAllDrives: true
  });
  return res.data;
}

/**
 * Safely moves a Google Drive file to the Trash.
 * 
 * @param {string} fileId Google Drive file ID
 * @returns {Promise<void>}
 */
async function trashFile(fileId) {
  await drive.files.update({
    fileId: fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true
  });
}

/**
 * Checks if a file exists on Google Drive and is not trashed.
 * 
 * @param {string} fileId Google Drive file ID
 * @returns {Promise<boolean>} True if the file exists and is active, false otherwise
 */
async function checkFileExists(fileId) {
  try {
    const res = await drive.files.get({
      fileId,
      fields: 'id, name, size, trashed',
      supportsAllDrives: true
    });
    return res.data && !res.data.trashed;
  } catch (err) {
    if (err.status === 404 || (err.response && err.response.status === 404)) {
      return false;
    }
    throw err;
  }
}

module.exports = {
  listFolderFiles,
  downloadFile,
  uploadFile,
  trashFile,
  checkFileExists,
  driveClient: drive
};
