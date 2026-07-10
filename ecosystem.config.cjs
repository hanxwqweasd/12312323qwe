module.exports = {
  apps: [
    {
      name: 'nyx-api',
      script: 'src/index.js',
      instances: process.env.WEB_CONCURRENCY || 'max',
      exec_mode: 'cluster',
      max_memory_restart: process.env.MAX_MEMORY_RESTART || '512M',
      env: { NODE_ENV: 'production' },
    },
    { name: 'nyx-push-worker', script: 'src/workers/pushWorker.js', instances: 1, env: { NODE_ENV: 'production' } },
    { name: 'nyx-media-worker', script: 'src/workers/mediaWorker.js', instances: 1, env: { NODE_ENV: 'production' } },
    { name: 'nyx-bot-worker', script: 'src/workers/botUpdateWorker.js', instances: 1, env: { NODE_ENV: 'production' } },
    { name: 'nyx-backup-worker', script: 'src/workers/backupWorker.js', instances: 1, env: { NODE_ENV: 'production' } },
  ],
};
