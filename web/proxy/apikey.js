// Persistent Meta API key loading for the proxy. The key lives outside
// the repo at ~/.model_api_key (0600); an explicit environment value
// always wins so deploys can override. File and value must never reach
// logs, responses, the UI, or chat — callers log only source presence.
const fs = require('fs');
const os = require('os');
const path = require('path');

function keyFilePath(env, homedir) {
  if (env.MODEL_API_KEY_FILE) return env.MODEL_API_KEY_FILE;
  return path.join(homedir, '.model_api_key');
}

function loadApiKey(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const readFile = o.readFile || fs.readFileSync;
  const homedir = o.homedir || os.homedir();
  const fromEnv = String(env.MODEL_API_KEY || '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  try {
    const fromFile = String(readFile(keyFilePath(env, homedir), 'utf8') || '').trim();
    if (fromFile) return { key: fromFile, source: 'file' };
  } catch {
    // Missing/unreadable key file: live scans stay unavailable.
  }
  return { key: null, source: null };
}

module.exports = { keyFilePath, loadApiKey };
