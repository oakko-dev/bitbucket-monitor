import crypto from 'node:crypto';

const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// A session is "<expiry>.<signature>". The key comes from the credentials, so changing the password signs everyone out.
export function createSessions({ secret, now = Date.now }) {
  const key = crypto.createHash('sha256').update(`session:${secret}`).digest();
  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

  return {
    maxAgeSeconds: MAX_AGE_SECONDS,
    issue() {
      const expiry = String(Math.floor(now() / 1000) + MAX_AGE_SECONDS);
      return `${expiry}.${sign(expiry)}`;
    },
    verify(token) {
      if (typeof token !== 'string') return false;
      const [expiry, signature, ...extra] = token.split('.');
      if (!expiry || !signature || extra.length > 0) return false;
      if (!Number.isInteger(Number(expiry)) || Number(expiry) * 1000 <= now()) return false;
      const given = Buffer.from(signature);
      const expected = Buffer.from(sign(expiry));
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    },
  };
}

export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

// Counts failed logins per client and blocks further tries for a while. It lives in one server instance's memory,
// so on serverless it slows guessing without stopping a determined attacker. The password length is the real defense.
export function createLoginThrottle({ maxFailures = 8, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const failures = new Map();
  return {
    blocked(client) {
      const entry = failures.get(client);
      if (!entry) return false;
      if (entry.resetAt <= now()) {
        failures.delete(client);
        return false;
      }
      return entry.count >= maxFailures;
    },
    fail(client) {
      if (failures.size > 1000) failures.clear();
      const entry = failures.get(client);
      if (entry && entry.resetAt > now()) entry.count++;
      else failures.set(client, { count: 1, resetAt: now() + windowMs });
    },
    clear(client) { failures.delete(client); },
  };
}
