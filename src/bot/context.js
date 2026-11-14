// Shared bot context: set once during init, imported by commands & panel.
let ctx = null;

function setContext(value) {
  ctx = value;
}

function getContext() {
  if (!ctx) throw new Error('Bot context not initialised yet');
  return ctx;
}

function tryGetContext() {
  return ctx;
}

module.exports = { setContext, getContext, tryGetContext };
