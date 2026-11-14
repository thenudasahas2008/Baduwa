// Command loader: every file in this folder (except index.js) must export { data, execute, autocomplete? }
const fs = require('node:fs');
const path = require('node:path');

const commands = new Map();

for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && f !== 'index.js')) {
  const mod = require(path.join(__dirname, file));
  if (mod && mod.data && typeof mod.execute === 'function') {
    commands.set(mod.data.name, mod);
  } else {
    console.warn(`[commands] ${file} is missing data/execute — skipped`);
  }
}

module.exports = commands;
