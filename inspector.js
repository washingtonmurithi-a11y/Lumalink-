files["core/signal_inspector.js"] = """/
@file core/signal_inspector.js
@description Real-Time Signal Activity & Reed-Solomon Forensics Packet Inspector
Generates deep frame-level diagnostics comparing pre-FEC, corrupted, and post-FEC states.
*/
(function (root, factory) {
if (typeof module === 'object' && module.exports) {
module.exports = factory(require('./reed_solomon_codec'));
} else {
root.SignalInspector = factory(root.ReedSolomonCodec);
}
}(typeof self !== 'undefined' ? self : this, function (RSMod) {
'use strict';
class SignalForensicsEngine {
constructor() {
this.codecs = {
speed: new RSMod.AdaptiveRSCodec(32, 28),
balanced: new RSMod.AdaptiveRSCodec(32, 24),
extreme: new RSMod.AdaptiveRSCodec(32, 16)
};
this.totalFramesProcessed = 0;
this.totalBytesHealed = 0;
this.totalCorruptedInjected = 0;
}
inspectAndHealFrame(utf8Text, mode = 'balanced', corruptionRatio = 0.12) {
  const codec = this.codecs[mode] || this.codecs.balanced;
  const encoder = new TextEncoder();
  const rawBytes = encoder.encode(String(utf8Text || 'LUMALINK_SYNC_PULSE'));
  const { encoded, numBlocks } = codec.encodeBuffer(rawBytes);

  const corrupted = new Uint8Array(encoded);
  const maxErrPerBlock = codec.maxCorrectableErrors;
  const errorsToInjectPerBlock = Math.min(
    maxErrPerBlock,
    Math.round(corruptionRatio * codec.n)
  );

  let injectedCount = 0;
  for (let b = 0; b < numBlocks; b++) {
    for (let e = 0; e < errorsToInjectPerBlock; e++) {
      const byteOffset = b * codec.n + ((e * 5 + 1) % codec.n);
      corrupted[byteOffset] ^= (0x5A ^ ((e + 1) * 17)) & 0xFF || 0xFF;
      injectedCount++;
    }
  }

  const decoded = codec.decodeBufferWithTrace(corrupted);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const recoveredText = decoder.decode(decoded.payload);

  this.totalFramesProcessed += 1;
  this.totalCorruptedInjected += injectedCount;
  this.totalBytesHealed += decoded.totalCorrected;

  const toHexSample = (buf) =>
    Array.from(buf.slice(0, 32))
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');

  return {
    timestamp: Date.now(),
    codecSpec: `RS(${codec.n},${codec.k})`,
    maxCorrectablePerBlock: maxErrPerBlock,
    numBlocks,
    encodedBytes: encoded.length,
    injectedErrors: injectedCount,
    correctedErrors: decoded.totalCorrected,
    failedBlocks: decoded.failedBlocks,
    integrityVerified: decoded.failedBlocks === 0 && recoveredText === String(utf8Text || 'LUMALINK_SYNC_PULSE'),
    recoveredText,
    hexBlock0: {
      cleanTx: toHexSample(encoded),
      corruptedRx: toHexSample(corrupted),
      healedOut: toHexSample(codec.decodeBlockWithTrace(corrupted.slice(0, codec.n)).correctedCodeword)
    },
    repairs: decoded.repairs.slice(0, 24),
    cumulative: {
      frames: this.totalFramesProcessed,
      corrupted: this.totalCorruptedInjected,
      healed: this.totalBytesHealed
    }
  };
}
this.totalBytesHealed
    }
  };
}
}
return { SignalForensicsEngine };
}));
"""
