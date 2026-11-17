/* The keys to your synced data. One random data key per account opens everything the app syncs.
   It travels only inside the keyring, wrapped twice: once with a key made from your password
   (PBKDF2, a random salt), once with your recovery key (128 random bits). The keyring lives in
   your cristianbagrin.com account as the item @tdw/keyring; the servers see only ciphertext.
   From the data key come the vault's address, the secret that lets this app's server accept
   writes to it, and the key the vault is encrypted with.
   UMD: TDW.Keyring in the browser, module.exports in Node (for the tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(globalThis.crypto);
  else { root.TDW = root.TDW || {}; root.TDW.Keyring = factory(root.crypto); }
})(typeof self !== 'undefined' ? self : this, function (webcrypto) {
  'use strict';

  const APP = 'tdw';
  const ITERATIONS = 600000;
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O or U
  const RK_CHARS = 26;                                // 128 bits, 5 to a character, 2 spare
  const utf8 = new TextEncoder();
  const err = (code, message) => Object.assign(new Error(message), { code });

  function subtle() {
    if (!webcrypto || !webcrypto.subtle) throw err('insecure', 'Accounts need a secure (https) page.');
    return webcrypto.subtle;
  }
  const random = (n) => webcrypto.getRandomValues(new Uint8Array(n));

  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) {
    const bin = atob(String(s));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  /* ---------- The recovery key, as people read it ---------- */

  // 16 bytes → "K7QM-2XRA-…" (26 characters in groups of four).
  function encodeRecovery(bytes) {
    let bits = 0, n = 0, out = '';
    for (const b of bytes) {
      bits = (bits << 8) | b; n += 8;
      while (n >= 5) { out += ALPHABET[(bits >>> (n - 5)) & 31]; n -= 5; }
      bits &= (1 << n) - 1;
    }
    if (n > 0) out += ALPHABET[(bits << (5 - n)) & 31];
    return out.match(/.{1,4}/g).join('-');
  }

  // Whatever was typed or pasted → 16 bytes, or null when it can't be a recovery key. Case,
  // dashes and spaces don't matter; O reads as 0, and I and L as 1.
  function decodeRecovery(text) {
    const s = String(text || '').toUpperCase().replace(/[\s\-_.]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    if (s.length !== RK_CHARS) return null;
    const out = new Uint8Array(16);
    let bits = 0, n = 0, k = 0;
    for (const ch of s) {
      const v = ALPHABET.indexOf(ch);
      if (v < 0) return null;
      bits = (bits << 5) | v; n += 5;
      if (n >= 8) { if (k < 16) out[k++] = (bits >>> (n - 8)) & 255; n -= 8; }
      bits &= (1 << n) - 1;
    }
    return k === 16 ? out : null;
  }

  /* ---------- Wrapping ---------- */

  async function pwKey(password, salt) {
    const s = subtle();
    const base = await s.importKey('raw', utf8.encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return s.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function rkKey(rkBytes) {
    const s = subtle();
    const base = await s.importKey('raw', rkBytes, 'HKDF', false, ['deriveKey']);
    return s.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(APP + '/recovery') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function wrap(key, dk, label) {
    const iv = random(12);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(APP + '/keyring/' + label) }, key, dk);
    return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  }

  async function unwrap(key, box, label) {
    const dk = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: utf8.encode(APP + '/keyring/' + label) }, key, unb64(box.ct));
    return new Uint8Array(dk);
  }

  /* ---------- What the data key opens ---------- */

  // { vaultId: 64 hex, secret: base64url (proves to this app's server that a write is yours),
  //   key: base64 (encrypts the vault), kid: 16 hex (tells keyrings apart) }
  async function derive(dk) {
    const s = subtle();
    const hk = await s.importKey('raw', dk, 'HKDF', false, ['deriveBits']);
    const part = async (info) => new Uint8Array(await s.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(APP + '/' + info) }, hk, 256));
    const [id, secret, key, kid] = await Promise.all([part('vault-id'), part('vault-write'), part('vault-data'), part('key-id')]);
    return {
      vaultId: hex(new Uint8Array(await s.digest('SHA-256', id))),
      secret: b64url(secret),
      key: b64(key),
      kid: hex(kid).slice(0, 16)
    };
  }

  /* ---------- The keyring ---------- */

  const isRing = (r) => !!(r && typeof r === 'object' && r.v === 1 && typeof r.salt === 'string' &&
    r.pw && typeof r.pw.iv === 'string' && typeof r.pw.ct === 'string' && r.rk && typeof r.rk.iv === 'string' && typeof r.rk.ct === 'string');

  // A new account's keys: { dk, recovery: 'K7QM-…', ring }
  async function create(password) {
    const dk = random(32);
    const rk = random(16);
    const salt = random(16);
    const [pw, rkBox, d] = await Promise.all([wrap(await pwKey(password, salt), dk, 'pw'), wrap(await rkKey(rk), dk, 'rk'), derive(dk)]);
    return { dk, recovery: encodeRecovery(rk), ring: { v: 1, kid: d.kid, salt: b64(salt), pw, rk: rkBox, created: Date.now() } };
  }

  // The data key, or an error with code 'wrong_password'.
  async function unlockWithPassword(ring, password) {
    if (!isRing(ring)) throw err('bad_ring', 'Your account’s keys look damaged.');
    try {
      return await unwrap(await pwKey(password, unb64(ring.salt)), ring.pw, 'pw');
    } catch (e) {
      if (e && e.code === 'insecure') throw e;
      throw err('wrong_password', 'That password doesn’t open your synced data.');
    }
  }

  // The data key, or an error with code 'bad_recovery' (not a recovery key) or 'wrong_recovery'.
  async function unlockWithRecovery(ring, text) {
    if (!isRing(ring)) throw err('bad_ring', 'Your account’s keys look damaged.');
    const rk = decodeRecovery(text);
    if (!rk) throw err('bad_recovery', 'A recovery key has 26 letters and numbers. Check it and try again.');
    try {
      return await unwrap(await rkKey(rk), ring.rk, 'rk');
    } catch (_) {
      throw err('wrong_recovery', 'That recovery key doesn’t open your synced data.');
    }
  }

  // The same keyring, with the data key wrapped under a new password (and a new salt).
  async function rewrapPassword(ring, dk, password) {
    const salt = random(16);
    return Object.assign({}, ring, { salt: b64(salt), pw: await wrap(await pwKey(password, salt), dk, 'pw') });
  }

  // A new recovery key; the old one stops working once this keyring replaces the old one.
  async function replaceRecovery(ring, dk) {
    const rk = random(16);
    return { recovery: encodeRecovery(rk), ring: Object.assign({}, ring, { rk: await wrap(await rkKey(rk), dk, 'rk') }) };
  }

  // Whether this data key is the one the keyring holds (by its id; older keyrings without one: unknown).
  async function matches(ring, dk) {
    if (!ring || !ring.kid) return null;
    return (await derive(dk)).kid === ring.kid;
  }

  return {
    ITERATIONS, isRing, create, unlockWithPassword, unlockWithRecovery, rewrapPassword, replaceRecovery, derive, matches,
    encodeRecovery, decodeRecovery, b64, unb64
  };
});
