files["core/reed_solomon_codec.js"] = """/
@file core/reed_solomon_codec.js
@description Systematic Reed-Solomon RS(N, K) Codec with Forensics Telemetry Trace
Implements Syndrome Computation, Berlekamp-Massey Error-Locator Synthesis,
Chien Root Search, and Forney Error-Magnitude Evaluation over GF(2^8).
*/
(function (root, factory) {
if (typeof module === 'object' && module.exports) {
module.exports = factory(require('./galois_gf256'));
} else {
root.ReedSolomonCodec = factory(root.GaloisGF256);
}
}(typeof self !== 'undefined' ? self : this, function (GF) {
'use strict';
class AdaptiveRSCodec {
/
* @param {number} n Codeword block length (default 32)
* @param {number} k Message data length (28=Speed, 24=Balanced, 16=Extreme Distance)
*/
constructor(n = 32, k = 24) {
if (n <= k || n > 255) {
throw new RangeError(Invalid RS(${n}, ${k}) parameters);
}
this.n = n;
this.k = k;
this.nsym = n - k;
this.maxCorrectableErrors = Math.floor(this.nsym / 2);
this.generator = GF.buildGeneratorPoly(this.nsym, 0);
}
encodeBlock(dataBytes) {
  if (dataBytes.length !== this.k) {
    throw new Error(`RS(${this.n},${this.k}) encodeBlock requires exactly ${this.k} bytes`);
  }
  const codeword = new Uint8Array(this.n);
  codeword.set(dataBytes, 0);

  for (let i = 0; i < this.k; i++) {
    const coef = codeword[i];
    if (coef !== 0) {
      for (let j = 1; j < this.generator.length; j++) {
        codeword[i + j] ^= GF.mul(this.generator[j], coef);
      }
    }
  }
  codeword.set(dataBytes, 0);
  return codeword;
}

decodeBlockWithTrace(receivedBytes) {
  if (receivedBytes.length !== this.n) {
    throw new Error(`RS(${this.n},${this.k}) decodeBlock requires ${this.n} bytes`);
  }
  const working = new Uint8Array(receivedBytes);
  const syndromes = new Uint8Array(this.nsym);
  let nonZeroSyndrome = false;

  for (let i = 0; i < this.nsym; i++) {
    syndromes[i] = GF.polyEval(working, GF.pow(2, i));
    if (syndromes[i] !== 0) nonZeroSyndrome = true;
  }

  if (!nonZeroSyndrome) {
    return {
      data: working.slice(0, this.k),
      correctedCodeword: working,
      errorsCorrected: 0,
      uncorrectable: false,
      repairs: [],
      syndromes: Array.from(syndromes)
    };
  }

  // Berlekamp-Massey iterative LFSR synthesis
  let errLoc = new Uint8Array([1]);
  let oldLoc = new Uint8Array([1]);

  for (let i = 0; i < this.nsym; i++) {
    let delta = syndromes[i];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= GF.mul(errLoc[errLoc.length - 1 - j], syndromes[i - j]);
    }
    oldLoc = new Uint8Array([...oldLoc, 0]);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const nextLoc = GF.polyScale(oldLoc, delta);
        oldLoc = GF.polyScale(errLoc, GF.inv(delta));
        errLoc = nextLoc;
      }
      errLoc = GF.polyAdd(errLoc, GF.polyScale(oldLoc, delta));
    }
  }

  const errorCount = errLoc.length - 1;
  if (errorCount > this.maxCorrectableErrors) {
    return {
      data: working.slice(0, this.k),
      correctedCodeword: working,
      errorsCorrected: 0,
      uncorrectable: true,
      repairs: [],
      syndromes: Array.from(syndromes)
    };
  }

  // Chien Search for roots of Lambda(x)
  const errorPositions = [];
  for (let i = 0; i < this.n; i++) {
    if (GF.polyEval(errLoc, GF.pow(2, i)) === 0) {
      errorPositions.push(this.n - 1 - i);
    }
  }

  if (errorPositions.length !== errorCount) {
    return {
      data: working.slice(0, this.k),
      correctedCodeword: working,
      errorsCorrected: 0,
      uncorrectable: true,
      repairs: [],
      syndromes: Array.from(syndromes)
    };
  }

  // Forney Error Evaluator
  const syndRev = new Uint8Array(syndromes).reverse();
  const omegaFull = GF.polyMul(syndRev, errLoc);
  const omega = omegaFull.slice(omegaFull.length - this.nsym);
  const xList = errorPositions.map((pos) => GF.pow(2, this.n - 1 - pos));
  const repairs = [];

  for (let i = 0; i < xList.length; i++) {
    const xiInv = GF.inv(xList[i]);
    let locatorDerivative = 1;
    for (let j = 0; j < xList.length; j++) {
      if (j !== i) {
        locatorDerivative = GF.mul(locatorDerivative, 1 ^ GF.mul(xiInv, xList[j]));
      }
    }
    const yVal = GF.polyEval(omega, xiInv);
    const magnitude = GF.div(GF.mul(xList[i], yVal), locatorDerivative);
    const pos = errorPositions[i];
    const beforeByte = working[pos];
    working[pos] ^= magnitude;
    repairs.push({
      byteIndex: pos,
      region: pos < this.k ? 'DATA' : 'PARITY',
      corruptedHex: beforeByte.toString(16).padStart(2, '0').toUpperCase(),
      repairedHex: working[pos].toString(16).padStart(2, '0').toUpperCase(),
      errorMaskHex: magnitude.toString(16).padStart(2, '0').toUpperCase()
    });
  }

  // Final verification pass
  for (let i = 0; i < this.nsym; i++) {
    if (GF.polyEval(working, GF.pow(2, i)) !== 0) {
      return {
        data: working.slice(0, this.k),
        correctedCodeword: working,
        errorsCorrected: 0,
        uncorrectable: true,
        repairs: [],
        syndromes: Array.from(syndromes)
      };
    }
  }

  return {
    data: working.slice(0, this.k),
    correctedCodeword: working,
    errorsCorrected: errorCount,
    uncorrectable: false,
    repairs,
    syndromes: Array.from(syndromes)
  };
}

encodeBuffer(rawUint8) {
  const framed = new Uint8Array(rawUint8.length + 2);
  framed[0] = (rawUint8.length >> 8) & 0xFF;
  framed[1] = rawUint8.length & 0xFF;
  framed.set(rawUint8, 2);

  const numBlocks = Math.ceil(framed.length / this.k);
  const encoded = new Uint8Array(numBlocks * this.n);
  for (let b = 0; b < numBlocks; b++) {
    const block = new Uint8Array(this.k);
    block.set(framed.slice(b * this.k, (b + 1) * this.k), 0);
    encoded.set(this.encodeBlock(block), b * this.n);
  }
  return { encoded, numBlocks, rawLength: rawUint8.length };
}

decodeBufferWithTrace(encodedUint8) {
  const numBlocks = Math.floor(encodedUint8.length / this.n);
  const recovered = new Uint8Array(numBlocks * this.k);
  const allRepairs = [];
  let totalCorrected = 0;
  let failedBlocks = 0;

  for (let b = 0; b < numBlocks; b++) {
    const block = encodedUint8.slice(b * this.n, (b + 1) * this.n);
    const res = this.decodeBlockWithTrace(block);
    recovered.set(res.data, b * this.k);
    totalCorrected += res.errorsCorrected;
    if (res.uncorrectable) failedBlocks++;
    res.repairs.forEach((r) => allRepairs.push({ block: b, ...r }));
  }

  const declaredLen = (recovered[0] << 8) | recovered[1];
  const safeLen = Math.min(declaredLen, Math.max(0, recovered.length - 2));
  return {
    payload: recovered.slice(2, 2 + safeLen),
    numBlocks,
    totalCorrected,
    failedBlocks,
    repairs: allRepairs
  };
}
}
return { AdaptiveRSCodec };
}));
"""
