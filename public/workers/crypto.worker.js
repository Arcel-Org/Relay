/**
 * Crypto Web Worker
 *
 * Performs ChaCha20-Poly1305 encrypt/decrypt and zlib compress/decompress
 * off the main thread so the UI stays responsive.
 *
 * Dependencies:
 *   - pako (loaded via importScripts)
 *   - @noble/ciphers chacha20poly1305 (inlined below to avoid module bundling)
 *
 * Protocol:
 *   Main -> Worker: { id, type: 'encrypt'|'decrypt', payload }
 *   Worker -> Main: { id, result: ArrayBuffer } | { id, error: string }
 *
 * ArrayBuffers are transferred (zero-copy) in both directions.
 */

/* global self, importScripts */
'use strict';

// Load pako for zlib compression
importScripts('./pako.min.js');

// ─────────────────────────────────────────────────────────────────────────
// Inlined @noble/ciphers v0.2.0 (MIT) - only chacha20poly1305
// Source: https://github.com/paulmillr/noble-ciphers
// Modules: utils.js, _assert.js, _poly1305.js, _salsa.js, chacha.js
// ─────────────────────────────────────────────────────────────────────────

var noble = (function() {
  // --- utils.js ---
  var u8a = function(a) { return a instanceof Uint8Array; };
  var u8 = function(arr) { return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); };
  var u32 = function(arr) { return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4)); };
  var createView = function(arr) { return new DataView(arr.buffer, arr.byteOffset, arr.byteLength); };

  var isLE = new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;
  if (!isLE) throw new Error('Non little-endian hardware is not supported');

  function utf8ToBytes(str) {
    if (typeof str !== 'string') throw new Error('utf8ToBytes expected string, got ' + typeof str);
    return new Uint8Array(new TextEncoder().encode(str));
  }

  function toBytes(data) {
    if (typeof data === 'string') data = utf8ToBytes(data);
    if (!u8a(data)) throw new Error('expected Uint8Array, got ' + typeof data);
    return data;
  }

  function ensureBytes(b, len) {
    if (!(b instanceof Uint8Array)) throw new Error('Uint8Array expected');
    if (typeof len === 'number')
      if (b.length !== len) throw new Error('Uint8Array length ' + len + ' expected');
  }

  function equalBytes(a, b) {
    if (a.length !== b.length) throw new Error('equalBytes: Different size of Uint8Arrays');
    var isSame = true;
    for (var i = 0; i < a.length; i++) isSame && (isSame = a[i] === b[i]);
    return isSame;
  }

  var isPlainObject = function(obj) {
    return Object.prototype.toString.call(obj) === '[object Object]' && obj.constructor === Object;
  };
  function checkOpts(defaults, opts) {
    if (opts !== undefined && (typeof opts !== 'object' || !isPlainObject(opts)))
      throw new Error('options must be object or undefined');
    return Object.assign(defaults, opts);
  }

  function setBigUint64(view, byteOffset, value, isLE) {
    if (typeof view.setBigUint64 === 'function') return view.setBigUint64(byteOffset, value, isLE);
    var _32n = BigInt(32);
    var _u32_max = BigInt(0xffffffff);
    var wh = Number((value >> _32n) & _u32_max);
    var wl = Number(value & _u32_max);
    var h = isLE ? 4 : 0;
    var l = isLE ? 0 : 4;
    view.setUint32(byteOffset + h, wh, isLE);
    view.setUint32(byteOffset + l, wl, isLE);
  }

  // --- _assert.js ---
  var assert = {
    number: function(n) { if (!Number.isSafeInteger(n) || n < 0) throw new Error('Wrong positive integer: ' + n); },
    bool: function(b) { if (typeof b !== 'boolean') throw new Error('Expected boolean, not ' + b); },
    bytes: function(b) {
      if (!(b instanceof Uint8Array)) throw new Error('Expected Uint8Array');
      var lengths = Array.prototype.slice.call(arguments, 1);
      if (lengths.length > 0 && lengths.indexOf(b.length) === -1)
        throw new Error('Expected Uint8Array of length ' + lengths + ', not of length=' + b.length);
    },
    exists: function(instance, checkFinished) {
      if (checkFinished === undefined) checkFinished = true;
      if (instance.destroyed) throw new Error('Hash instance has been destroyed');
      if (checkFinished && instance.finished) throw new Error('Hash#digest() has already been called');
    },
    output: function(out, instance) {
      assert.bytes(out);
      var min = instance.outputLen;
      if (out.length < min) throw new Error('digestInto() expects output buffer of length at least ' + min);
    }
  };

  // --- _poly1305.js ---
  var u8to16 = function(a, i) { return (a[i++] & 0xff) | ((a[i++] & 0xff) << 8); };

  function Poly1305(key) {
    this.blockLen = 16;
    this.outputLen = 16;
    this.buffer = new Uint8Array(16);
    this.r = new Uint16Array(10);
    this.h = new Uint16Array(10);
    this.pad = new Uint16Array(8);
    this.pos = 0;
    this.finished = false;
    key = toBytes(key);
    ensureBytes(key, 32);
    var t0 = u8to16(key, 0), t1 = u8to16(key, 2), t2 = u8to16(key, 4), t3 = u8to16(key, 6);
    var t4 = u8to16(key, 8), t5 = u8to16(key, 10), t6 = u8to16(key, 12), t7 = u8to16(key, 14);
    this.r[0] = t0 & 0x1fff;
    this.r[1] = ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
    this.r[2] = ((t1 >>> 10) | (t2 << 6)) & 0x1f03;
    this.r[3] = ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
    this.r[4] = ((t3 >>> 4) | (t4 << 12)) & 0x00ff;
    this.r[5] = (t4 >>> 1) & 0x1ffe;
    this.r[6] = ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
    this.r[7] = ((t5 >>> 11) | (t6 << 5)) & 0x1f81;
    this.r[8] = ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
    this.r[9] = (t7 >>> 5) & 0x007f;
    for (var i = 0; i < 8; i++) this.pad[i] = u8to16(key, 16 + 2 * i);
  }

  Poly1305.prototype.process = function(data, offset, isLast) {
    if (isLast === undefined) isLast = false;
    var hibit = isLast ? 0 : 1 << 11;
    var h = this.h, r = this.r;
    var r0 = r[0], r1 = r[1], r2 = r[2], r3 = r[3], r4 = r[4];
    var r5 = r[5], r6 = r[6], r7 = r[7], r8 = r[8], r9 = r[9];
    var t0 = u8to16(data, offset + 0), t1 = u8to16(data, offset + 2);
    var t2 = u8to16(data, offset + 4), t3 = u8to16(data, offset + 6);
    var t4 = u8to16(data, offset + 8), t5 = u8to16(data, offset + 10);
    var t6 = u8to16(data, offset + 12), t7 = u8to16(data, offset + 14);
    var h0 = h[0] + (t0 & 0x1fff);
    var h1 = h[1] + (((t0 >>> 13) | (t1 << 3)) & 0x1fff);
    var h2 = h[2] + (((t1 >>> 10) | (t2 << 6)) & 0x1fff);
    var h3 = h[3] + (((t2 >>> 7) | (t3 << 9)) & 0x1fff);
    var h4 = h[4] + (((t3 >>> 4) | (t4 << 12)) & 0x1fff);
    var h5 = h[5] + ((t4 >>> 1) & 0x1fff);
    var h6 = h[6] + (((t4 >>> 14) | (t5 << 2)) & 0x1fff);
    var h7 = h[7] + (((t5 >>> 11) | (t6 << 5)) & 0x1fff);
    var h8 = h[8] + (((t6 >>> 8) | (t7 << 8)) & 0x1fff);
    var h9 = h[9] + ((t7 >>> 5) | hibit);
    var c = 0;
    var d0 = c + h0 * r0 + h1 * (5 * r9) + h2 * (5 * r8) + h3 * (5 * r7) + h4 * (5 * r6);
    c = d0 >>> 13; d0 &= 0x1fff;
    d0 += h5 * (5 * r5) + h6 * (5 * r4) + h7 * (5 * r3) + h8 * (5 * r2) + h9 * (5 * r1);
    c += d0 >>> 13; d0 &= 0x1fff;
    var d1 = c + h0 * r1 + h1 * r0 + h2 * (5 * r9) + h3 * (5 * r8) + h4 * (5 * r7);
    c = d1 >>> 13; d1 &= 0x1fff;
    d1 += h5 * (5 * r6) + h6 * (5 * r5) + h7 * (5 * r4) + h8 * (5 * r3) + h9 * (5 * r2);
    c += d1 >>> 13; d1 &= 0x1fff;
    var d2 = c + h0 * r2 + h1 * r1 + h2 * r0 + h3 * (5 * r9) + h4 * (5 * r8);
    c = d2 >>> 13; d2 &= 0x1fff;
    d2 += h5 * (5 * r7) + h6 * (5 * r6) + h7 * (5 * r5) + h8 * (5 * r4) + h9 * (5 * r3);
    c += d2 >>> 13; d2 &= 0x1fff;
    var d3 = c + h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * (5 * r9);
    c = d3 >>> 13; d3 &= 0x1fff;
    d3 += h5 * (5 * r8) + h6 * (5 * r7) + h7 * (5 * r6) + h8 * (5 * r5) + h9 * (5 * r4);
    c += d3 >>> 13; d3 &= 0x1fff;
    var d4 = c + h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
    c = d4 >>> 13; d4 &= 0x1fff;
    d4 += h5 * (5 * r9) + h6 * (5 * r8) + h7 * (5 * r7) + h8 * (5 * r6) + h9 * (5 * r5);
    c += d4 >>> 13; d4 &= 0x1fff;
    var d5 = c + h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1;
    c = d5 >>> 13; d5 &= 0x1fff;
    d5 += h5 * r0 + h6 * (5 * r9) + h7 * (5 * r8) + h8 * (5 * r7) + h9 * (5 * r6);
    c += d5 >>> 13; d5 &= 0x1fff;
    var d6 = c + h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2;
    c = d6 >>> 13; d6 &= 0x1fff;
    d6 += h5 * r1 + h6 * r0 + h7 * (5 * r9) + h8 * (5 * r8) + h9 * (5 * r7);
    c += d6 >>> 13; d6 &= 0x1fff;
    var d7 = c + h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3;
    c = d7 >>> 13; d7 &= 0x1fff;
    d7 += h5 * r2 + h6 * r1 + h7 * r0 + h8 * (5 * r9) + h9 * (5 * r8);
    c += d7 >>> 13; d7 &= 0x1fff;
    var d8 = c + h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4;
    c = d8 >>> 13; d8 &= 0x1fff;
    d8 += h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * (5 * r9);
    c += d8 >>> 13; d8 &= 0x1fff;
    var d9 = c + h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5;
    c = d9 >>> 13; d9 &= 0x1fff;
    d9 += h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0;
    c += d9 >>> 13; d9 &= 0x1fff;
    c = ((c << 2) + c) | 0;
    c = (c + d0) | 0;
    d0 = c & 0x1fff;
    c = c >>> 13;
    d1 += c;
    h[0] = d0; h[1] = d1; h[2] = d2; h[3] = d3; h[4] = d4;
    h[5] = d5; h[6] = d6; h[7] = d7; h[8] = d8; h[9] = d9;
  };

  Poly1305.prototype.finalize = function() {
    var h = this.h, pad = this.pad;
    var g = new Uint16Array(10);
    var c = h[1] >>> 13;
    h[1] &= 0x1fff;
    for (var i = 2; i < 10; i++) { h[i] += c; c = h[i] >>> 13; h[i] &= 0x1fff; }
    h[0] += c * 5; c = h[0] >>> 13; h[0] &= 0x1fff;
    h[1] += c; c = h[1] >>> 13; h[1] &= 0x1fff; h[2] += c;
    g[0] = h[0] + 5; c = g[0] >>> 13; g[0] &= 0x1fff;
    for (var i = 1; i < 10; i++) { g[i] = h[i] + c; c = g[i] >>> 13; g[i] &= 0x1fff; }
    g[9] -= 1 << 13;
    var mask = (c ^ 1) - 1;
    for (var i = 0; i < 10; i++) g[i] &= mask;
    mask = ~mask;
    for (var i = 0; i < 10; i++) h[i] = (h[i] & mask) | g[i];
    h[0] = (h[0] | (h[1] << 13)) & 0xffff;
    h[1] = ((h[1] >>> 3) | (h[2] << 10)) & 0xffff;
    h[2] = ((h[2] >>> 6) | (h[3] << 7)) & 0xffff;
    h[3] = ((h[3] >>> 9) | (h[4] << 4)) & 0xffff;
    h[4] = ((h[4] >>> 12) | (h[5] << 1) | (h[6] << 14)) & 0xffff;
    h[5] = ((h[6] >>> 2) | (h[7] << 11)) & 0xffff;
    h[6] = ((h[7] >>> 5) | (h[8] << 8)) & 0xffff;
    h[7] = ((h[8] >>> 8) | (h[9] << 5)) & 0xffff;
    var f = h[0] + pad[0];
    h[0] = f & 0xffff;
    for (var i = 1; i < 8; i++) {
      f = (((h[i] + pad[i]) | 0) + (f >>> 16)) | 0;
      h[i] = f & 0xffff;
    }
  };

  Poly1305.prototype.update = function(data) {
    assert.exists(this);
    var buffer = this.buffer, blockLen = this.blockLen;
    data = toBytes(data);
    var len = data.length;
    for (var pos = 0; pos < len;) {
      var take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        for (; blockLen <= len - pos; pos += blockLen) this.process(data, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) { this.process(buffer, 0, false); this.pos = 0; }
    }
    return this;
  };

  Poly1305.prototype.destroy = function() {
    this.h.fill(0); this.r.fill(0); this.buffer.fill(0); this.pad.fill(0);
  };

  Poly1305.prototype.digestInto = function(out) {
    assert.exists(this);
    assert.output(out, this);
    this.finished = true;
    var buffer = this.buffer, h = this.h;
    var pos = this.pos;
    if (pos) {
      buffer[pos++] = 1;
      for (; pos < 16; pos++) buffer[pos] = 0;
      this.process(buffer, 0, true);
    }
    this.finalize();
    var opos = 0;
    for (var i = 0; i < 8; i++) { out[opos++] = h[i] >>> 0; out[opos++] = h[i] >>> 8; }
    return out;
  };

  Poly1305.prototype.digest = function() {
    var buffer = this.buffer, outputLen = this.outputLen;
    this.digestInto(buffer);
    var res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  };

  var poly1305_create = function(key) { return new Poly1305(key); };
  var poly1305 = function(msg, key) { return new Poly1305(key).update(toBytes(msg)).digest(); };
  poly1305.create = poly1305_create;
  poly1305.outputLen = 16;
  poly1305.blockLen = 16;

  // --- _salsa.js ---
  var sigma16 = utf8ToBytes('expand 16-byte k');
  var sigma32 = utf8ToBytes('expand 32-byte k');
  var sigma16_32 = u32(sigma16);
  var sigma32_32 = u32(sigma32);
  var isAligned32 = function(b) { return !(b.byteOffset % 4); };

  function salsaBasic(opts) {
    var _opts = checkOpts({
      rounds: 20, counterRight: false, counterLen: 8,
      allow128bitKeys: true, blockLen: 64
    }, opts);
    var core = _opts.core, rounds = _opts.rounds, counterRight = _opts.counterRight;
    var counterLen = _opts.counterLen, allow128bitKeys = _opts.allow128bitKeys, blockLen = _opts.blockLen;
    assert.number(counterLen);
    assert.number(rounds);
    assert.number(blockLen);
    assert.bool(counterRight);
    assert.bool(allow128bitKeys);
    var blockLen32 = blockLen / 4;
    if (blockLen % 4 !== 0) throw new Error('Salsa/ChaCha: blockLen must be aligned to 4 bytes');
    return function(key, nonce, data, output, counter) {
      if (counter === undefined) counter = 0;
      assert.bytes(key);
      assert.bytes(nonce);
      assert.bytes(data);
      if (!output) output = new Uint8Array(data.length);
      assert.bytes(output);
      assert.number(counter);
      if (counter < 0 || counter >= Math.pow(2, 32) - 1)
        throw new Error('Salsa/ChaCha: counter overflow');
      if (output.length < data.length)
        throw new Error('Salsa/ChaCha: output (' + output.length + ') is shorter than data (' + data.length + ')');
      var toClean = [];
      var k, sigma;
      if (key.length === 32) { k = key; sigma = sigma32_32; }
      else if (key.length === 16 && allow128bitKeys) {
        k = new Uint8Array(32); k.set(key); k.set(key, 16);
        sigma = sigma16_32; toClean.push(k);
      } else throw new Error('Salsa/ChaCha: invalid 32-byte key, got length=' + key.length);
      if (_opts.extendNonceFn) {
        if (nonce.length <= 16) throw new Error('Salsa/ChaCha: extended nonce must be bigger than 16 bytes');
        k = _opts.extendNonceFn(sigma, k, nonce.subarray(0, 16), new Uint8Array(32));
        toClean.push(k);
        nonce = nonce.subarray(16);
      }
      var nonceLen = 16 - counterLen;
      if (nonce.length !== nonceLen)
        throw new Error('Salsa/ChaCha: nonce must be ' + nonceLen + ' or 16 bytes');
      if (nonceLen !== 12) {
        var nc = new Uint8Array(12);
        nc.set(nonce, counterRight ? 0 : 12 - nonce.length);
        toClean.push(nonce = nc);
      }
      var block = new Uint8Array(blockLen);
      var b32 = u32(block);
      var k32 = u32(k);
      var n32 = u32(nonce);
      var d32 = isAligned32(data) && u32(data);
      var o32 = isAligned32(output) && u32(output);
      toClean.push(b32);
      var len = data.length;
      for (var pos = 0, ctr = counter; pos < len; ctr++) {
        core(sigma, k32, n32, b32, ctr, rounds);
        if (ctr >= Math.pow(2, 32) - 1) throw new Error('Salsa/ChaCha: counter overflow');
        var take = Math.min(blockLen, len - pos);
        if (take === blockLen && o32 && d32) {
          var pos32 = pos / 4;
          if (pos % 4 !== 0) throw new Error('Salsa/ChaCha: invalid block position');
          for (var j = 0; j < blockLen32; j++) o32[pos32 + j] = d32[pos32 + j] ^ b32[j];
          pos += blockLen;
          continue;
        }
        for (var j = 0; j < take; j++) output[pos + j] = data[pos + j] ^ block[j];
        pos += take;
      }
      for (var i = 0; i < toClean.length; i++) toClean[i].fill(0);
      return output;
    };
  }

  // --- chacha.js ---
  var rotl = function(a, b) { return (a << b) | (a >>> (32 - b)); };

  // prettier-ignore
  function chachaCore(c, k, n, out, cnt, rounds) {
    if (rounds === undefined) rounds = 20;
    var y00 = c[0], y01 = c[1], y02 = c[2], y03 = c[3];
    var y04 = k[0], y05 = k[1], y06 = k[2], y07 = k[3];
    var y08 = k[4], y09 = k[5], y10 = k[6], y11 = k[7];
    var y12 = cnt, y13 = n[0], y14 = n[1], y15 = n[2];
    var x00 = y00, x01 = y01, x02 = y02, x03 = y03;
    var x04 = y04, x05 = y05, x06 = y06, x07 = y07;
    var x08 = y08, x09 = y09, x10 = y10, x11 = y11;
    var x12 = y12, x13 = y13, x14 = y14, x15 = y15;
    for (var i = 0; i < rounds; i += 2) {
      x00 = (x00 + x04) | 0; x12 = rotl(x12 ^ x00, 16);
      x08 = (x08 + x12) | 0; x04 = rotl(x04 ^ x08, 12);
      x00 = (x00 + x04) | 0; x12 = rotl(x12 ^ x00, 8);
      x08 = (x08 + x12) | 0; x04 = rotl(x04 ^ x08, 7);
      x01 = (x01 + x05) | 0; x13 = rotl(x13 ^ x01, 16);
      x09 = (x09 + x13) | 0; x05 = rotl(x05 ^ x09, 12);
      x01 = (x01 + x05) | 0; x13 = rotl(x13 ^ x01, 8);
      x09 = (x09 + x13) | 0; x05 = rotl(x05 ^ x09, 7);
      x02 = (x02 + x06) | 0; x14 = rotl(x14 ^ x02, 16);
      x10 = (x10 + x14) | 0; x06 = rotl(x06 ^ x10, 12);
      x02 = (x02 + x06) | 0; x14 = rotl(x14 ^ x02, 8);
      x10 = (x10 + x14) | 0; x06 = rotl(x06 ^ x10, 7);
      x03 = (x03 + x07) | 0; x15 = rotl(x15 ^ x03, 16);
      x11 = (x11 + x15) | 0; x07 = rotl(x07 ^ x11, 12);
      x03 = (x03 + x07) | 0; x15 = rotl(x15 ^ x03, 8);
      x11 = (x11 + x15) | 0; x07 = rotl(x07 ^ x11, 7);
      x00 = (x00 + x05) | 0; x15 = rotl(x15 ^ x00, 16);
      x10 = (x10 + x15) | 0; x05 = rotl(x05 ^ x10, 12);
      x00 = (x00 + x05) | 0; x15 = rotl(x15 ^ x00, 8);
      x10 = (x10 + x15) | 0; x05 = rotl(x05 ^ x10, 7);
      x01 = (x01 + x06) | 0; x12 = rotl(x12 ^ x01, 16);
      x11 = (x11 + x12) | 0; x06 = rotl(x06 ^ x11, 12);
      x01 = (x01 + x06) | 0; x12 = rotl(x12 ^ x01, 8);
      x11 = (x11 + x12) | 0; x06 = rotl(x06 ^ x11, 7);
      x02 = (x02 + x07) | 0; x13 = rotl(x13 ^ x02, 16);
      x08 = (x08 + x13) | 0; x07 = rotl(x07 ^ x08, 12);
      x02 = (x02 + x07) | 0; x13 = rotl(x13 ^ x02, 8);
      x08 = (x08 + x13) | 0; x07 = rotl(x07 ^ x08, 7);
      x03 = (x03 + x04) | 0; x14 = rotl(x14 ^ x03, 16);
      x09 = (x09 + x14) | 0; x04 = rotl(x04 ^ x09, 12);
      x03 = (x03 + x04) | 0; x14 = rotl(x14 ^ x03, 8);
      x09 = (x09 + x14) | 0; x04 = rotl(x04 ^ x09, 7);
    }
    var oi = 0;
    out[oi++] = (y00 + x00) | 0; out[oi++] = (y01 + x01) | 0;
    out[oi++] = (y02 + x02) | 0; out[oi++] = (y03 + x03) | 0;
    out[oi++] = (y04 + x04) | 0; out[oi++] = (y05 + x05) | 0;
    out[oi++] = (y06 + x06) | 0; out[oi++] = (y07 + x07) | 0;
    out[oi++] = (y08 + x08) | 0; out[oi++] = (y09 + x09) | 0;
    out[oi++] = (y10 + x10) | 0; out[oi++] = (y11 + x11) | 0;
    out[oi++] = (y12 + x12) | 0; out[oi++] = (y13 + x13) | 0;
    out[oi++] = (y14 + x14) | 0; out[oi++] = (y15 + x15) | 0;
  }

  var chacha20 = salsaBasic({
    core: chachaCore, counterRight: false, counterLen: 4, allow128bitKeys: false
  });

  var ZERO = new Uint8Array(16);
  var updatePadded = function(h, msg) {
    h.update(msg);
    var left = msg.length % 16;
    if (left) h.update(ZERO.subarray(left));
  };

  var computeTag = function(fn, key, nonce, data, AAD) {
    var authKey = fn(key, nonce, new Uint8Array(32));
    var h = poly1305.create(authKey);
    if (AAD) updatePadded(h, AAD);
    updatePadded(h, data);
    var num = new Uint8Array(16);
    var view = createView(num);
    setBigUint64(view, 0, BigInt(AAD ? AAD.length : 0), true);
    setBigUint64(view, 8, BigInt(data.length), true);
    h.update(num);
    var res = h.digest();
    authKey.fill(0);
    return res;
  };

  function chacha20poly1305(key, nonce, AAD) {
    var tagLength = 16;
    ensureBytes(key, 32);
    ensureBytes(nonce);
    return {
      tagLength: tagLength,
      encrypt: function(plaintext, output) {
        var plength = plaintext.length;
        var clength = plength + tagLength;
        if (output) { ensureBytes(output, clength); }
        else { output = new Uint8Array(clength); }
        chacha20(key, nonce, plaintext, output, 1);
        var tag = computeTag(chacha20, key, nonce, output.subarray(0, -tagLength), AAD);
        output.set(tag, plength);
        return output;
      },
      decrypt: function(ciphertext, output) {
        var clength = ciphertext.length;
        var plength = clength - tagLength;
        if (clength < tagLength) throw new Error('encrypted data must be at least ' + tagLength + ' bytes');
        if (output) { ensureBytes(output, plength); }
        else { output = new Uint8Array(plength); }
        var data = ciphertext.subarray(0, -tagLength);
        var passedTag = ciphertext.subarray(-tagLength);
        var tag = computeTag(chacha20, key, nonce, data, AAD);
        if (!equalBytes(passedTag, tag)) throw new Error('invalid tag');
        chacha20(key, nonce, data, output, 1);
        return output;
      }
    };
  }

  return { chacha20poly1305: chacha20poly1305 };
})();

// ─────────────────────────────────────────────────────────────────────────
// Constants matching relay-crypto.ts wire format
// ─────────────────────────────────────────────────────────────────────────
var MIN_PAD_SIZE = 64;

// ─────────────────────────────────────────────────────────────────────────
// PADME padding
// ─────────────────────────────────────────────────────────────────────────

function padmePad(data, minSize) {
  if (minSize === undefined) minSize = MIN_PAD_SIZE;
  var target = minSize;
  if (data.length > 0) {
    var bits = 32 - Math.clz32(data.length - 1);
    var powerOf2 = bits < 31 ? (1 << bits) : Math.pow(2, bits);
    target = Math.max(minSize, powerOf2);
  }
  var padLen = target - data.length;
  var padded = new Uint8Array(target);
  padded.set(data);
  return { padded: padded, padLen: padLen };
}

function padmeUnpad(data, padLen) {
  if (padLen > 0) return data.slice(0, data.length - padLen);
  return data;
}

// Must match buildAAD() in lib/crypto/relay-crypto.ts exactly — binds the
// cleartext wire-header fields into the AEAD tag so they can't be flipped
// in transit without invalidating it.
function buildAAD(dictVersion, seq, paddingLen) {
  var aad = new Uint8Array(13);
  var view = new DataView(aad.buffer);
  view.setUint8(0, dictVersion);
  view.setBigUint64(1, BigInt(seq), false);
  view.setUint32(9, paddingLen, false);
  return aad;
}

// ─────────────────────────────────────────────────────────────────────────
// Message handler
// ─────────────────────────────────────────────────────────────────────────

self.onmessage = function(e) {
  var msg = e.data;
  var id = msg.id;

  try {
    if (msg.type === 'encrypt') {
      // payload: { plaintext, encKey, nonce, dict: ArrayBuffer, dictVersion: number, seq: bigint }
      var plaintext = new Uint8Array(msg.payload.plaintext);
      var encKey = new Uint8Array(msg.payload.encKey);
      var nonce = new Uint8Array(msg.payload.nonce);
      var dict = new Uint8Array(msg.payload.dict);
      var dictVersion = msg.payload.dictVersion;
      var seq = msg.payload.seq;

      // 1. Compress with pako (preset dictionary, matches main-thread compressZlib)
      var compressed = dict.length > 0
        ? self.pako.deflateRaw(plaintext, { dictionary: dict })
        : self.pako.deflateRaw(plaintext);

      // 2. Pad
      var padResult = padmePad(compressed);
      var padded = padResult.padded;
      var padLen = padResult.padLen;

      // 3. Encrypt with ChaCha20-Poly1305, AAD-bound to the header fields
      var aad = buildAAD(dictVersion, seq, padLen);
      var cipher = noble.chacha20poly1305(encKey, nonce, aad);
      var ctWithTag = cipher.encrypt(padded);

      // Transfer result back (zero-copy)
      var resultBuf = ctWithTag.buffer.slice(
        ctWithTag.byteOffset,
        ctWithTag.byteOffset + ctWithTag.byteLength
      );
      self.postMessage(
        { id: id, result: resultBuf, padLen: padLen },
        [resultBuf]
      );
    }
    else if (msg.type === 'decrypt') {
      // payload: { ctWithTag, encKey, nonce, paddingLen: number, aad: ArrayBuffer, dict: ArrayBuffer }
      var ctWithTag = new Uint8Array(msg.payload.ctWithTag);
      var encKey = new Uint8Array(msg.payload.encKey);
      var nonce = new Uint8Array(msg.payload.nonce);
      var paddingLen = msg.payload.paddingLen;
      var aad = new Uint8Array(msg.payload.aad);
      var dict = new Uint8Array(msg.payload.dict);

      if (ctWithTag.length < 16) {
        throw new Error('ciphertext+tag too short (' + ctWithTag.length + ' bytes, need at least 16)');
      }

      // 1. Decrypt with ChaCha20-Poly1305 (AAD-bound, matches encrypt side)
      var cipher = noble.chacha20poly1305(encKey, nonce, aad);
      var padded = cipher.decrypt(ctWithTag);

      // 2. Unpad
      var compressed = padmeUnpad(padded, paddingLen);

      // 3. Decompress with pako (preset dictionary, matches main-thread decompressZlib)
      var result = dict.length > 0
        ? self.pako.inflateRaw(compressed, { dictionary: dict })
        : self.pako.inflateRaw(compressed);

      // Transfer result back (zero-copy)
      var resultBuf = result.buffer.slice(
        result.byteOffset,
        result.byteOffset + result.byteLength
      );
      self.postMessage(
        { id: id, result: resultBuf },
        [resultBuf]
      );
    }
    else if (msg.type === 'ping') {
      self.postMessage({ id: id, result: 'pong' });
    }
    else {
      throw new Error('Unknown message type: ' + msg.type);
    }
  } catch (err) {
    self.postMessage({ id: id, error: err.message || String(err) });
  }
};

// Signal that worker is ready
self.postMessage({ id: '__ready__', result: 'ready' });
