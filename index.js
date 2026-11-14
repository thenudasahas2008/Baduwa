// Entry point: boots the Discord bot.
const config = require('./src/config');

(async () => {
  try {
    const { init } = require('./src/bot/init');

    const { client, player, music } = await init();

    console.log('[main] bot booted and running');

    const shutdown = async (signal) => {
      console.log(`[main] ${signal} received — shutting down`);
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
