const crypto = require('crypto');

const ADMIN_USERNAME = 'admin';
const ADMIN_SALT = 'ec422f7b8f5d960e0eb635a0afdebeef';
const ADMIN_HASH = '6671535daa3af5a1b8cf768607832d1baceebf9c1dd93a456f9002940089de9557dabce43a3f9a507e992956e8c87d5fcb73d3b1993dea510a3859d42ef9a606';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

function verifyPassword(username, password) {
  if (username !== ADMIN_USERNAME) return false;
  const hash = crypto.scryptSync(password, ADMIN_SALT, 64);
  return crypto.timingSafeEqual(hash, Buffer.from(ADMIN_HASH, 'hex'));
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { verifyPassword, generateSessionToken, SESSION_DURATION_MS };
