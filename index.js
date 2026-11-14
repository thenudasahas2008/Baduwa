// Entry point: boots the Discord bot with an ultra-lightweight keep-alive server.
// Set modern FFmpeg binary path before any audio modules initialize
const fs = require('node:fs');
try {
  const ffmpegStatic = require('ffmpeg-static');
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    process.env.FFMPEG_PATH = ffmpegStatic;
  }
} catch {
  /* best effort */
}

const http = require('node:http');
const config = require('./src/config');

(async () => {
  try {
    // 1) Lightweight HTTP server for free cloud hosts (Render, Koyeb) requiring an open port
    const port = process.env.PORT || 3000;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Baduwa Discord Music Bot is Online and Healthy! 🎧');
    });

    server.listen(port, () => {
      console.log('[http] keep-alive server listening on port', port);
    });

    // 2) Boot Discord bot
    const { init } = require('./src/bot/init');
    const { client, player, music } = await init();

    console.log('[main] bot booted and running');

    const shutdown = async (signal) => {
      console.log(`[main] ${signal} received — shutting down`);
      try {
        server.close();
      } catch {
        /* noop */
      }
      try {
        await player.destroy();
      } catch {
        /* noop */
      }
      try {
        client.destroy();
      } catch {
        /* noop */
      }
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (e) {
    console.error('[main] failed to boot:', e.message);
    process.exit(1);
  }
})();
