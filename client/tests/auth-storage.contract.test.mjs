import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearAuthSession,
  consumePostAuthRedirect,
  getActiveStoreDomain,
  getStoreDomain,
  getSessionToken,
  setAuthSession,
  setPostAuthRedirect,
  syncAuthSession,
} from '../src/common/AuthStorage.js';

class MemoryStorage {
  #map = new Map();

  getItem(key) {
    return this.#map.has(key) ? this.#map.get(key) : null;
  }

  setItem(key, value) {
    this.#map.set(key, String(value));
  }

  removeItem(key) {
    this.#map.delete(key);
  }

  clear() {
    this.#map.clear();
  }
}

const cookieJar = new Map();
const localStorage = new MemoryStorage();
const sessionStorage = new MemoryStorage();

function resetBrowserState(search = '?storeDomain=shop-a.mysapo.net') {
  cookieJar.clear();
  localStorage.clear();
  sessionStorage.clear();

  globalThis.window = {
    location: {
      protocol: 'https:',
      hostname: 'reviews.example.com',
      pathname: '/',
      search,
      hash: '',
      origin: 'https://reviews.example.com',
    },
    localStorage,
    sessionStorage,
  };

  globalThis.document = {
    get cookie() {
      return Array.from(cookieJar.entries())
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('; ');
    },
    set cookie(value) {
      const [head, ...parts] = String(value).split(';');
      const [encodedKey, encodedValue = ''] = head.split('=');
      const key = decodeURIComponent(encodedKey);
      const attrs = parts.map((part) => part.trim().toLowerCase());
      const isRemoval = attrs.some((part) => part === 'max-age=0');
      if (isRemoval) {
        cookieJar.delete(key);
        return;
      }
      cookieJar.set(key, decodeURIComponent(encodedValue));
    },
  };
}

test.beforeEach(() => {
  resetBrowserState();
  clearAuthSession('shop-a.mysapo.net');
  clearAuthSession('shop-b.mysapo.net');
});

test('scopes auth session tokens by storeDomain so one store cannot satisfy another', () => {
  setAuthSession('shop-a.mysapo.net', 'session-a');
  setAuthSession('shop-b.mysapo.net', 'session-b');

  assert.equal(getSessionToken('shop-a.mysapo.net'), 'session-a');
  assert.equal(getSessionToken('shop-b.mysapo.net'), 'session-b');
  assert.notEqual(getSessionToken('shop-a.mysapo.net'), getSessionToken('shop-b.mysapo.net'));
});

test('ignores invalid storeDomain values from the URL during session sync', () => {
  resetBrowserState('?storeDomain=../../bad');
  sessionStorage.setItem('auth_session_token', 'legacy-token');
  sessionStorage.setItem('auth_verified', '1');

  syncAuthSession();

  assert.equal(getStoreDomain(), null);
  assert.equal(getActiveStoreDomain(), null);
  assert.equal(getSessionToken('../../bad'), null);
});

test('rejects a bare shop handle and normalizes case on a dotted Sapo domain', () => {
  resetBrowserState('?storeDomain=shop-a');
  syncAuthSession();
  assert.equal(getStoreDomain(), null);
  setAuthSession('shop-a', 'bare-token');
  assert.equal(getActiveStoreDomain(), null);
  assert.equal(getSessionToken('shop-a'), null);

  resetBrowserState('?storeDomain=Shop-A.MySapo.net');
  assert.equal(getStoreDomain(), 'shop-a.mysapo.net');
});

test('never stores or consumes post-auth redirects back into /install or /oauth', () => {
  setPostAuthRedirect('/install/login?storeDomain=shop-a.mysapo.net');
  assert.equal(consumePostAuthRedirect('shop-a.mysapo.net'), null);

  setPostAuthRedirect('/oauth/callback?code=123');
  assert.equal(consumePostAuthRedirect('shop-a.mysapo.net'), null);

  setPostAuthRedirect('/reviews?tab=spam');
  assert.equal(consumePostAuthRedirect('shop-a.mysapo.net'), '/reviews?tab=spam');
});

test('keeps the session token out of JS-readable cookies', () => {
  setAuthSession('shop-a.mysapo.net', 'session-a');

  assert.equal(cookieJar.size, 0);
  assert.equal(localStorage.getItem('auth_session_token:shop-a.mysapo.net'), 'session-a');
  assert.equal(getSessionToken('shop-a.mysapo.net'), 'session-a');

  clearAuthSession('shop-a.mysapo.net');
  assert.equal(getSessionToken('shop-a.mysapo.net'), null);
});
