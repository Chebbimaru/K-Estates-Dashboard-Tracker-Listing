const crypto = require('crypto');
const { getCredentials, updateCredentials } = require('./db');

const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours
const MIN_PASSWORD_LENGTH = 8;

function verifyPassword(username, password) {
  const row = getCredentials(username);
  if (!row) return false;
  const hash = crypto.scryptSync(password, row.salt, 64);
  return crypto.timingSafeEqual(hash, Buffer.from(row.hash, 'hex'));
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function changePassword(username, currentPassword, newPassword) {
  const row = getCredentials(username);
  if (!row) return { ok: false, error: 'user not found' };

  const currentHash = crypto.scryptSync(currentPassword || '', row.salt, 64);
  const currentOk = crypto.timingSafeEqual(currentHash, Buffer.from(row.hash, 'hex'));
  if (!currentOk) return { ok: false, error: 'current password is incorrect' };

  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `new password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(newPassword, salt, 64).toString('hex');
  updateCredentials(username, salt, hash);
  return { ok: true };
}

module.exports = { verifyPassword, generateSessionToken, changePassword, SESSION_DURATION_MS };
