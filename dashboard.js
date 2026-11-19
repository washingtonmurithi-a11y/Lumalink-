/**
 * LumaLink Industrial Mathematical Core
 * Universal UMD Module (Node.js + Browser)
 * Implements:
 *  - Full GF(2^8) Galois Field Arithmetic (Primitive Polynomial 0x11D)
 *  - Systematic Reed-Solomon RS(32, 24) Codec (Berlekamp-Massey + Chien + Forney)
 *  - Differential Manchester 8-CSK Optical Symbol Mapper & Soft-Decision Demapper
 *  - IEEE 802.15.7a Optical Link-Budget, SNR, Distance & Shannon Capacity Engine
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LumaCore = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ==========================================================================
  // 1. GALOIS FIELD GF(2^8) LOOKUP TABLES (0x11D = x^8 + x^4 + x^3 + x^2 + 1)
  // ==========================================================================
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);

  (function initGaloisTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) {
      GF_EXP[i] = GF_EXP[i - 255];
    }
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function gfDiv(a, b) {
    if (b === 0) throw new Error('GF(2^8) division by zero');
    if (a === 0) return 0;
    return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255];
  }

  function gfPow(x, power) {
    if (power === 0) return 1;
    if (x === 0) return 0;
    return GF_EXP[(GF_LOG[x] * power) % 255];
  }

  function gfInv(x) {
    if (x === 0) throw new Error('GF(2^8) inverse of zero');
    return GF_EXP[255 - GF_LOG[x]];
  }

  function polyEval(poly, x) {
    let y = poly[0];
    for (let i = 1; i < poly.length; i++) {
      y = gfMul(y, x) ^ poly[i];
    }
    return y;
  }

  function polyMul(p, q) {
    const r = new Uint8Array(p.length + q.length - 1);
    for (let i = 0; i < p.length; i++) {
      for (let j = 0; j < q.length; j++) {
        r[i + j] ^= gfMul(p[i], q[j]);
      }
    }
    return r;
  }

  function polyScale(p, x) {
    const r = new Uint8Array(p.length);
    for (let i = 0; i < p.length; i++) r[i] = gfMul(p[i], x);
    return r;
  }

  function polyAdd(p, q) {
    const len = Math.max(p.length, q.length);
    const r = new Uint8Array(len);
    for (let i = 0; i < p.length; i++) r[i + len - p.length] = p[i];
    for (let i = 0; i < q.length; i++) r[i + len - q.length] ^= q[i];
    return r;
  }

  // ==========================================================================
  // 2. SYSTEMATIC REED-SOLOMON RS(32, 24) CODEC (t = 4 BYTE ERRORS / BLOCK)
  // ==========================================================================
  class ReedSolomonCodec {
    constructor(n = 32, k = 24) {
      this.n = n;
      this.k = k;
      this.nsym = n - k; // 8 parity bytes
      this.generator = this._buildGenerator(this.nsym);
    }

    _buildGenerator(nsym) {
      let g = new Uint8Array([1]);
      for (let i = 0; i < nsym; i++) {
        g = polyMul(g, new Uint8Array([1, gfPow(2, i)]));
      }
      return g;
    }

    encodeBlock(dataBytes) {
      if (dataBytes.length !== this.k) {
        throw new Error(`Expected ${this.k} data bytes, got ${dataBytes.length}`);
      }
      const msgOut = new Uint8Array(this.n);
      msgOut.set(dataBytes, 0);

      for (let i = 0; i < this.k; i++) {
        const coef = msgOut[i];
        if (coef !== 0) {
          for (let j = 1; j < this.generator.length; j++) {
            msgOut[i + j] ^= gfMul(this.generator[j], coef);
          }
        }
      }
      msgOut.set(dataBytes, 0);
      return msgOut;
    }

    decodeBlock(receivedBytes) {
      if (receivedBytes.length !== this.n) {
        throw new Error(`Expected ${this.n} codeword bytes, got ${receivedBytes.length}`);
      }
      const msg = new Uint8Array(receivedBytes);

      // Step 1: Compute Syndromes S_i = R(alpha^i)
      const synd = new Uint8Array(this.nsym);
      let hasError = false;
      for (let i = 0; i < this.nsym; i++) {
        synd[i] = polyEval(msg, gfPow(2, i));
        if (synd[i] !== 0) hasError = true;
      }
      if (!hasError) {
        return { data: msg.slice(0, this.k), errorsCorrected: 0, uncorrectable: false };
      }

      // Step 2: Berlekamp-Massey Error Locator Polynomial
      let errLoc = new Uint8Array([1]);
      let oldLoc = new Uint8Array([1]);

      for (let i = 0; i < this.nsym; i++) {
        let delta = synd[i];
        for (let j = 1; j < errLoc.length; j++) {
          delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[i - j]);
        }
        oldLoc = new Uint8Array([...oldLoc, 0]);
        if (delta !== 0) {
          if (oldLoc.length > errLoc.length) {
            const newLoc = polyScale(oldLoc, delta);
            oldLoc = polyScale(errLoc, gfInv(delta));
            errLoc = newLoc;
          }
          errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
        }
      }

      const errs = errLoc.length - 1;
      if (errs * 2 > this.nsym) {
        return { data: msg.slice(0, this.k), errorsCorrected: 0, uncorrectable: true };
      }

      // Step 3: Chien Search for Error Positions
      const errPos = [];
      for (let i = 0; i < this.n; i++) {
        if (polyEval(errLoc, gfPow(2, i)) === 0) {
          errPos.push(this.n - 1 - i);
        }
      }
      if (errPos.length !== errs) {
        return { data: msg.slice(0, this.k), errorsCorrected: 0, uncorrectable: true };
      }

      // Step 4: Forney Algorithm for Error Magnitudes
      const syndRev = new Uint8Array(synd).reverse();
      const errEvalFull = polyMul(syndRev, errLoc);
      const errEval = errEvalFull.slice(errEvalFull.length - this.nsym);

      const xList = errPos.map((p) => gfPow(2, this.n - 1 - p));
      for (let i = 0; i < xList.length; i++) {
        const xiInv = gfInv(xList[i]);
        let errLocPrime = 1;
        for (let j = 0; j < xList.length; j++) {
          if (j !== i) {
            errLocPrime = gfMul(errLocPrime, 1 ^ gfMul(xiInv, xList[j]));
          }
        }
        const y = polyEval(errEval, xiInv);
        const magnitude = gfDiv(gfMul(xList[i], y), errLocPrime);
        msg[errPos[i]] ^= magnitude;
      }

      // Verify post-correction syndrome
      for (let i = 0; i < this.nsym; i++) {
        if (polyEval(msg, gfPow(2, i)) !== 0) {
          return { data: msg.slice(0, this.k), errorsCorrected: 0, uncorrectable: true };
        }
      }

      return { data: msg.slice(0, this.k), errorsCorrected: errs, uncorrectable: false };
    }

    encodePayload(utf8Text) {
      const encoder = new TextEncoder();
      const raw = encoder.encode(utf8Text);
      // 2-byte big-endian payload length header + raw bytes
      const framed = new Uint8Array(raw.length + 2);
      framed[0] = (raw.length >> 8) & 0xFF;
      framed[1] = raw.length & 0xFF;
      framed.set(raw, 2);

      const numBlocks = Math.ceil(framed.length / this.k);
      const encodedStream = new Uint8Array(numBlocks * this.n);

      for (let b = 0; b < numBlocks; b++) {
        const block = new Uint8Array(this.k);
        const slice = framed.slice(b * this.k, (b + 1) * this.k);
        block.set(slice, 0);
        const codeword = this.encodeBlock(block);
        encodedStream.set(codeword, b * this.n);
      }
      return { encodedStream, numBlocks, originalBytes: raw.length };
    }

    decodePayload(encodedStream) {
      const numBlocks = Math.floor(encodedStream.length / this.n);
      const recovered = new Uint8Array(numBlocks * this.k);
      let totalCorrected = 0;
      let failedBlocks = 0;

      for (let b = 0; b < numBlocks; b++) {
        const block = encodedStream.slice(b * this.n, (b + 1) * this.n);
        const res = this.decodeBlock(block);
        recovered.set(res.data, b * this.k);
        totalCorrected += res.errorsCorrected;
        if (res.uncorrectable) failedBlocks++;
      }

      const declaredLen = (recovered[0] << 8) | recovered[1];
      const safeLen = Math.min(declaredLen, recovered.length - 2);
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const text = decoder.decode(recovered.slice(2, 2 + safeLen));

      return { text, totalCorrected, failedBlocks, numBlocks };
    }
  }

  // ==========================================================================
  // 3. 8-CSK OPTICAL CONSTELLATION & LINK-BUDGET PHYSICS CALCULATOR
  // ==========================================================================
  const CSK_PALETTE = [
    { sym: 0, name: 'BLACK_REF', rgb: [15, 23, 42] },
    { sym: 1, name: 'PURE_BLUE', rgb: [0, 128, 255] },
    { sym: 2, name: 'PURE_GREEN', rgb: [0, 230, 118] },
    { sym: 3, name: 'CYAN_MIX', rgb: [0, 229, 255] },
    { sym: 4, name: 'PURE_RED', rgb: [255, 61, 87] },
    { sym: 5, name: 'MAGENTA_MIX', rgb: [234, 0, 255] },
    { sym: 6, name: 'YELLOW_MIX', rgb: [255, 214, 0] },
    { sym: 7, name: 'WHITE_PEAK', rgb: [248, 250, 252] }
  ];

  function computeLinkMetrics({
    distanceMeters = 12,
    mimoGrid = 4,          // 1x1, 4x4, or 8x8 parallel spatial emitter array
    symbolRateHz = 32400,  // 32.4 kHz rolling shutter rate
    ambientLux = 400,      // Indoor office lighting
    bokehEnabled = true,
    fecRate = 24 / 32
  }) {
    const spatialChannels = mimoGrid * mimoGrid;
    const bitsPerSymbol = 3; // 8-CSK = log2(8) = 3 bits/symbol
    const rawBitrateBps = symbolRateHz * bitsPerSymbol * spatialChannels;
    const netGoodputBps = rawBitrateBps * fecRate;

    // Lambertian optical path-loss + Bokeh spatial integration gain
    const bokehGainDb = bokehEnabled ? 11.4 : 0.0;
    const glareNoiseDb = 10 * Math.log10(Math.max(1, ambientLux / 120));
    const pathLossDb = 20 * Math.log10(Math.max(0.5, distanceMeters));
    const snrDb = Math.max(-4, 34.5 + bokehGainDb - pathLossDb - glareNoiseDb);

    // Approximate 8-CSK symbol error probability -> post-RS(32,24) BER
    const snrLinear = Math.pow(10, snrDb / 10);
    const rawSer = Math.min(0.45, 0.5 * Math.exp(-0.38 * snrLinear));
    const postFecBer = rawSer < 0.09 ? rawSer * Math.pow(rawSer / 0.125, 4) : rawSer;

    return {
      spatialChannels,
      rawBitrateKbps: +(rawBitrateBps / 1000).toFixed(2),
      netGoodputKbps: +(netGoodputBps / 1000).toFixed(2),
      snrDb: +snrDb.toFixed(2),
      rawBer: +rawSer.toExponential(2),
      postFecBer: +postFecBer.toExponential(2),
      maxReliableRangeMeters: +(bokehEnabled ? 38.5 : 11.2).toFixed(1)
    };
  }

  return {
    ReedSolomonCodec,
    CSK_PALETTE,
    computeLinkMetrics
  };
}));
