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
  
  // Get last successful conversion
  const lastSuccess = await db.get(`
    SELECT filename, completed_at 
    FROM conversion_queue 
    WHERE status = 'COMPLETED' 
    ORDER BY completed_at DESC 
    LIMIT 1
  `);
  
  // Get last error
  const lastError = await db.get(`
    SELECT filename, last_error, updated_at 
    FROM conversion_queue 
    WHERE last_error IS NOT NULL 
    ORDER BY updated_at DESC 
    LIMIT 1
  `);
  
  console.log('\n======================================');
  console.log('      HEIC CONVERTER QUEUE STATUS     ');
  console.log('======================================');
  console.log(`Total Files in Queue: ${total}`);
  console.log(`- Pending:            ${stats.PENDING}`);
  console.log(`- Processing:         ${stats.PROCESSING}`);
  console.log(`- Completed:          ${stats.COMPLETED}`);
  console.log(`- Failed:             ${stats.FAILED}`);
  console.log(`- Retry Waiting:      ${stats.RETRY_WAIT}`);
  console.log(`- Skipped:            ${stats.SKIPPED}`);
  console.log('--------------------------------------');
  
  if (lastSuccess) {
    const successTime = new Date(lastSuccess.completed_at).toISOString().replace('T', ' ').substring(0, 19);
    console.log(`Last Successful Job:  ${lastSuccess.filename} (at ${successTime})`);
  } else {
    console.log('Last Successful Job:  None');
  }
  
  if (lastError) {
    const errorTime = new Date(lastError.updated_at).toISOString().replace('T', ' ').substring(0, 19);
    console.log(`Last Error:           ${lastError.filename}: ${lastError.last_error} (at ${errorTime})`);
  } else {
    console.log('Last Error:           None');
  }
  console.log('======================================\n');
  
  db.db.close();
}

showStatus().catch(err => {
  console.error('Failed to retrieve queue status: ', err);
  process.exit(1);
});
