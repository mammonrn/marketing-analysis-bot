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

      // The VPS has 3.8GB, ~2.5GB of it free, shared with telegram-ads-bot.
      //
      // Measured on the real 6MB/150k-row "Detail (Last 6 Months)" export:
      // peak RSS 955-998MB for the whole process, worker thread included.
      // That is already at 1G, and it was measured in a bare harness with no
      // system prompt, session store or Telegram client resident, so the live
      // bot sits higher. 1.5G leaves roughly a third in hand and still fits
      // both bots inside what is free.
      max_memory_restart: '1.5G',

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
