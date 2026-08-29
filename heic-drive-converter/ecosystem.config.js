module.exports = {
  apps: [{
    name: 'heic-drive-converter',
    script: 'src/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production'
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/error.log',
    out_file: 'logs/combined.log',
    merge_logs: true,
    kill_timeout: 10000
  }]
};
