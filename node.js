/**
 * LumaLink Universal Carrier Engine & Adaptive GF(2^8) FEC Core
 * Universal Module (Node.js CommonJS + Browser Global)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LumaCarrierEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ==========================================================================
  // 1. GALOIS FIELD GF(2^8) ARITHMETIC (PRIMITIVE POLYNOMIAL 0x11D)
  // ==========================================================================
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);

  (function buildTables() {
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

  function gfPow(x, p) {
    if (p === 0) return 1;
    if (x === 0) return 0;
    return GF_EXP[(GF_LOG[x] * p) % 255];
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
  // 2. ADAPTIVE SYSTEMATIC REED-SOLOMON RS(N, K) CODEC
  //    Supports RS(32,28) [Speed], RS(32,24) [Balanced], RS(32,16) [Extreme Range]
  // ==========================================================================
  class AdaptiveReedSolomon {
    constructor(n = 32, k = 24) {
      this.n = n;
      this.k = k;
      this.nsym = n - k;
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
        throw new Error(`Expected ${this.k} bytes, received ${dataBytes.length}`);
      }
      const out = new Uint8Array(this.n);
      out.set(dataBytes, 0);
      for (let i = 0; i < this.k; i++) {
        const coef = out[i];
        if (coef !== 0) {
          for (let j = 1; j < this.generator.length; j++) {
            out[i + j] ^= gfMul(this.generator[j], coef);
          }
        }
      }
      out.set(dataBytes, 0);
      return out;
    }

    decodeBlock(receivedBytes) {
      if (receivedBytes.length !== this.n) {
        throw new Error(`Expected ${this.n} bytes, received ${receivedBytes.length}`);
      }
      const msg = new Uint8Array(receivedBytes);
      const synd = new Uint8Array(this.nsym);
      let hasError = false;

      for (let i = 0; i < this.nsym; i++) {
        synd[i] = polyEval(msg, gfPow(2, i));
        if (synd[i] !== 0) hasError = true;
      }
      if (!hasError) {
        return { data: msg.slice(0, this.k), errorsCorrected: 0, uncorrectable: false };
      }

      // Berlekamp-Massey Algorithm
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

      // Chien Search
      const errPos = [];
      for (let i = 0; i < this.n; i++) {
        if (polyEval(errLoc, gfPow(2, i)) === 0) {
          errPos.push(this.n - 1 - i);
        }
      }
      if (errPos.length !== errs) {
        return { data: msg.slice(0, this.k), errorsCorrected: 0, uncorrectable: true };
      }

      // Forney Error Magnitude Evaluation
      const syndRev = new Uint8Array(synd).reverse();
      const errEvalFull = polyMul(syndRev, errLoc);
      const errEval = errEvalFull.slice(errEvalFull.length - this.nsym);
      const xList = errPos.map((p) => gfPow(2, this.n - 1 - p));

      for (let i = 0; i < xList.length; i++) {
        const xiInv = gfInv(xList[i]);
        let denom = 1;
        for (let j = 0; j < xList.length; j++) {
          if (j !== i) {
            denom = gfMul(denom, 1 ^ gfMul(xiInv, xList[j]));
          }
        }
        const y = polyEval(errEval, xiInv);
        const mag = gfDiv(gfMul(xList[i], y), denom);
        msg[errPos[i]] ^= mag;
      }

      for (let i = 0; i < this.nsym; i++) {
        if (polyEval(msg, gfPow(2, i)) !== 0) {
          return { data: msg.slice(0, this.k), errorsCorrected: 0, uncorrectable: true };
        }
      }
      return { data: msg.slice(0, this.k), errorsCorrected: errs, uncorrectable: false };
    }

    protectBuffer(uint8Buf) {
      const numBlocks = Math.max(1, Math.ceil(uint8Buf.length / this.k));
      const protectedOut = new Uint8Array(numBlocks * this.n);
      for (let b = 0; b < numBlocks; b++) {
        const block = new Uint8Array(this.k);
        const slice = uint8Buf.slice(b * this.k, (b + 1) * this.k);
        block.set(slice, 0);
        protectedOut.set(this.encodeBlock(block), b * this.n);
      }
      return { protectedOut, numBlocks, codeRate: +(this.k / this.n).toFixed(3) };
    }
  }

  // ==========================================================================
  // 3. UNIVERSAL CARRIER BONDING & WEIGHTED DEFICIT ROUND-ROBIN SCHEDULER
  // ==========================================================================
  const DEFAULT_CARRIERS = [
    {
      id: 'wifi_6e_lan',
      name: 'Wi-Fi 6/6E Local Booster',
      category: 'IEEE 802.11ax/be',
      enabled: true,
      bandwidthMbps: 320,
      rttMs: 4.2,
      jitterMs: 1.1,
      rssiDbm: -54,
      lossPct: 0.2
    },
    {
      id: 'cell_5g_nr',
      name: '5G NR / LTE Carrier Modem',
      category: '3GPP Rel-17 Sub-6',
      enabled: true,
      bandwidthMbps: 185,
      rttMs: 18.5,
      jitterMs: 4.8,
      rssiDbm: -76,
      lossPct: 1.1
    },
    {
      id: 'fiber_wan',
      name: 'Ethernet / GPON Fiber Uplink',
      category: 'IEEE 802.3 / ITU-T G.984',
      enabled: true,
      bandwidthMbps: 500,
      rttMs: 6.0,
      jitterMs: 0.6,
      rssiDbm: -12,
      lossPct: 0.01
    },
    {
      id: 'optical_8csk',
      name: 'LumaLink 8-CSK Optical PHY',
      category: 'IEEE 802.15.7a OCC',
      enabled: true,
      bandwidthMbps: 12.5,
      rttMs: 1.4,
      jitterMs: 0.3,
      rssiDbm: -42,
      lossPct: 0.0
    },
    {
      id: 'satcom_leo',
      name: 'LEO Satellite Backhaul',
      category: 'Ku/Ka-Band Phased Array',
      enabled: false,
      bandwidthMbps: 140,
      rttMs: 34.0,
      jitterMs: 8.4,
      rssiDbm: -82,
      lossPct: 1.8
    },
    {
      id: 'mesh_relay',
      name: 'Multi-Hop Peer Mesh Extender',
      category: '802.11s / WebRTC Relay',
      enabled: true,
      bandwidthMbps: 95,
      rttMs: 9.5,
      jitterMs: 2.3,
      rssiDbm: -68,
      lossPct: 0.6
    }
  ];

  class CarrierBondingScheduler {
    constructor(carriers = DEFAULT_CARRIERS) {
      this.carriers = JSON.parse(JSON.stringify(carriers));
    }

    updateCarrier(id, patch) {
      const target = this.carriers.find((c) => c.id === id);
      if (!target) return null;
      Object.assign(target, patch);
      return target;
    }

    getActiveCarriers() {
      return this.carriers.filter((c) => c.enabled);
    }

    /**
     * Distributes a media/data payload across all active carriers proportional
     * to (Bandwidth / (1 + RTT_Penalty + Loss_Penalty)) using Weighted Deficit Round-Robin.
     */
    schedulePayloadBytes(totalBytes, distanceMeters = 15) {
      const active = this.getActiveCarriers();
      if (active.length === 0) {
        return { aggregateMbps: 0, effectiveJitterMs: 999, allocations: [], recommendedFec: [32, 16] };
      }

      const weights = active.map((c) => {
        const distPenalty = c.id === 'wifi_6e_lan' ? Math.max(1, distanceMeters / 25) : 1;
        const qualityScore = (c.bandwidthMbps / distPenalty) / (1 + c.rttMs * 0.04 + c.lossPct * 0.5);
        return Math.max(1, qualityScore);
      });

      const totalWeight = weights.reduce((a, b) => a + b, 0);
      let remainingBytes = totalBytes;
      const allocations = active.map((c, idx) => {
        const share = weights[idx] / totalWeight;
        const assignedBytes = idx === active.length - 1
          ? remainingBytes
          : Math.round(totalBytes * share);
        remainingBytes = Math.max(0, remainingBytes - assignedBytes);
        return {
          id: c.id,
          name: c.name,
          category: c.category,
          sharePct: +(share * 100).toFixed(1),
          assignedBytes,
          bandwidthMbps: c.bandwidthMbps,
          rttMs: c.rttMs
        };
      });

      const aggregateMbps = active.reduce((sum, c) => {
        const distFactor = c.id === 'wifi_6e_lan' ? Math.max(0.2, Math.min(1, 30 / Math.max(1, distanceMeters))) : 1;
        return sum + c.bandwidthMbps * distFactor;
      }, 0);

      // Jitter-buffer smoothing across parallel paths lowers effective playback jitter
      const minJitter = Math.min(...active.map((c) => c.jitterMs));
      const effectiveJitterMs = +(minJitter * 0.72).toFixed(2);

      // Select RS(N, K) profile dynamically based on booster distance
      let recommendedFec = [32, 28];
      if (distanceMeters > 75) recommendedFec = [32, 16];
      else if (distanceMeters > 30) recommendedFec = [32, 24];

      return {
        aggregateMbps: +aggregateMbps.toFixed(1),
        effectiveJitterMs,
        allocations,
        recommendedFec
      };
    }
  }

  return {
    AdaptiveReedSolomon,
    CarrierBondingScheduler,
    DEFAULT_CARRIERS
  };
}));
