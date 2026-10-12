import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginThrottle, createSessions, readCookie } from '../src/session.js';

test('a session verifies until it expires', () => {
  let now = 1_000_000;
  const sessions = createSessions({ secret: 'ops:pw', now: () => now });
  const token = sessions.issue();
  assert.equal(sessions.verify(token), true);
  now += (sessions.maxAgeSeconds - 1) * 1000;
  assert.equal(sessions.verify(token), true);
  now += 2000;
  assert.equal(sessions.verify(token), false);
});

test('a session fails when tampered with, extended, or signed with other credentials', () => {
  const sessions = createSessions({ secret: 'ops:pw' });
  const token = sessions.issue();
  const [expiry, signature] = token.split('.');
  assert.equal(sessions.verify(`${Number(expiry) + 86400}.${signature}`), false);
  assert.equal(sessions.verify(`${expiry}.${signature}x`), false);
  assert.equal(sessions.verify(`${expiry}.${signature}.extra`), false);
  assert.equal(sessions.verify(undefined), false);
  assert.equal(createSessions({ secret: 'ops:changed' }).verify(token), false);
});

test('readCookie picks the named cookie from a header', () => {
  assert.equal(readCookie('a=1; session=abc.def; b=2', 'session'), 'abc.def');
  assert.equal(readCookie('a=1', 'session'), null);
  assert.equal(readCookie(undefined, 'session'), null);
});

test('the throttle blocks after the limit, forgets after the window, and clears on success', () => {
  let now = 0;
  const throttle = createLoginThrottle({ maxFailures: 2, windowMs: 1000, now: () => now });
  throttle.fail('a');
  assert.equal(throttle.blocked('a'), false);
  throttle.fail('a');
  assert.equal(throttle.blocked('a'), true);
  assert.equal(throttle.blocked('b'), false);
  now = 1001;
  assert.equal(throttle.blocked('a'), false);
  throttle.fail('a');
  throttle.fail('a');
  throttle.clear('a');
  assert.equal(throttle.blocked('a'), false);
});
