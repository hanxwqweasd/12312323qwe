const crypto = require('crypto');

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

function json(value) {
  return value === undefined ? null : JSON.stringify(value ?? null);
}

function token(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function toBool(v) {
  return v === true || v === 1 || v === '1';
}

function parsePaging(req, maxLimit = 100) {
  const limit = Math.max(1, Math.min(maxLimit, Number(req.query.limit || 50)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  return { limit, offset };
}

module.exports = { safeJsonParse, json, token, sha256, nowIso, toBool, parsePaging };
