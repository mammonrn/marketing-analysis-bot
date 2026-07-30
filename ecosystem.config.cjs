/**
 * PM2 config (spec §2, §8) — runs alongside the existing telegram-ads-bot.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * .env is read by the app itself (dotenv), so PM2 needs no env_file.
 */

module.exports = {
  apps: [
    {
      name: 'ads-analytics-bot',
      script: 'src/index.js',
      // Single instance: the SQLite session store and the Telegram polling loop
      // both assume one writer. Do not raise this to cluster mode.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 4000,

      // The VPS has 4GB shared with Project 1; recycle before we crowd it out.
      max_memory_restart: '400M',

      env: {
        NODE_ENV: 'production',
      },

      merge_logs: true,
      time: true,
      out_file: './logs/out.log',
      error_file: './logs/error.log',
    },
  ],
};
