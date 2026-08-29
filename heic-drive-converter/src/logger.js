function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

const logger = {
  info: (msg) => {
    console.log(`[${getTimestamp()}] [INFO] ${msg}`);
  },
  warn: (msg) => {
    console.warn(`[${getTimestamp()}] [\x1b[33mWARN\x1b[0m] ${msg}`);
  },
  error: (msg, err) => {
    const errorDetail = err ? (err.stack || err.message || err) : '';
    console.error(`[${getTimestamp()}] [\x1b[31mERROR\x1b[0m] ${msg} ${errorDetail}`);
  }
};

module.exports = logger;
