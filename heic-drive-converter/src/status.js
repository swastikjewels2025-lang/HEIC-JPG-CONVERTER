const db = require('./db');
const logger = require('./logger');

async function showStatus() {
  await db.init();

  const countsSql = `
    SELECT status, COUNT(*) as count 
    FROM conversion_queue 
    GROUP BY status
  `;
  const rows = await db.all(countsSql);
  
  const stats = {
    PENDING: 0,
    PROCESSING: 0,
    COMPLETED: 0,
    FAILED: 0,
    RETRY_WAIT: 0,
    SKIPPED: 0
  };
  
  let total = 0;
  for (const row of rows) {
    if (stats[row.status] !== undefined) {
      stats[row.status] = row.count;
    }
    total += row.count;
  }
  
  // Get last 10 successful conversions with timestamps and durations
  const recentJobs = await db.all(`
    SELECT filename, target_filename, started_at, completed_at, updated_at
    FROM conversion_queue 
    WHERE status = 'COMPLETED' 
    ORDER BY completed_at DESC 
    LIMIT 10
  `);

  // Get last error
  const lastError = await db.get(`
    SELECT filename, last_error, updated_at 
    FROM conversion_queue 
    WHERE last_error IS NOT NULL 
    ORDER BY updated_at DESC 
    LIMIT 1
  `);

  console.log('\n=================================================================================');
  console.log('                            HEIC CONVERTER QUEUE STATUS                          ');
  console.log('=================================================================================');
  console.log(`Total Files in Queue: ${total}`);
  console.log(`- Pending:            ${stats.PENDING}`);
  console.log(`- Processing:         ${stats.PROCESSING}`);
  console.log(`- Completed:          ${stats.COMPLETED}`);
  console.log(`- Failed:             ${stats.FAILED}`);
  console.log(`- Retry Waiting:      ${stats.RETRY_WAIT}`);
  console.log(`- Skipped:            ${stats.SKIPPED}`);
  console.log('---------------------------------------------------------------------------------');

  if (recentJobs && recentJobs.length > 0) {
    console.log('RECENT COMPLETED & RENAMED FILES:');
    console.log('Original File         -> Converted/Renamed Name   | Completed At          | Duration');
    console.log('---------------------------------------------------------------------------------');
    for (const job of recentJobs) {
      const orig = (job.filename || '').padEnd(20);
      const target = (job.target_filename || '').padEnd(24);
      const timeStr = job.completed_at ? new Date(job.completed_at).toLocaleString() : 'N/A';
      const durationSec = (job.started_at && job.completed_at) ? `${((job.completed_at - job.started_at) / 1000).toFixed(1)}s` : 'N/A';
      console.log(`${orig} -> ${target} | ${timeStr.padEnd(21)} | ${durationSec}`);
    }
  } else {
    console.log('Recent Completed Files: None yet');
  }

  console.log('---------------------------------------------------------------------------------');
  if (lastError) {
    const errorTime = new Date(lastError.updated_at).toLocaleString();
    console.log(`Last Error:           ${lastError.filename}: ${lastError.last_error} (at ${errorTime})`);
  } else {
    console.log('Last Error:           None');
  }
  console.log('=================================================================================\n');

  db.db.close();
}

showStatus().catch(err => {
  console.error('Failed to retrieve queue status: ', err);
  process.exit(1);
});
