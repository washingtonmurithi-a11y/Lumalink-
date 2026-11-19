files["core/jitter_kalman_filter.js"] = """/
@file core/jitter_kalman_filter.js
@description 1D Discrete Kalman Filter & RFC 3550 Interarrival Jitter Estimator
Smooths wireless packet arrival jitter and computes ITU-T G.107 E-Model MOS voice scores.
*/
(function (root, factory) {
if (typeof module === 'object' && module.exports) {
module.exports = factory();
} else {
root.JitterKalmanFilter = factory();
}
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';
class LinkKalmanEstimator {
constructor(processNoise = 0.04, measurementNoise = 0.65) {
this.q = processNoise;
this.r = measurementNoise;
this.x = 1.5; // Estimated jitter (ms)
this.p = 1.0; // Estimation error covariance
this.rfc3550Jitter = 0.0;
this.lastTransit = null;
}
update(measuredTransitDeltaMs, packetLossPct = 0.1, rttMs = 12) {
  // RFC 3550 Section A.8 exponential moving average
  if (this.lastTransit !== null) {
    const d = Math.abs(measuredTransitDeltaMs - this.lastTransit);
    this.rfc3550Jitter += (d - this.rfc3550Jitter) / 16.0;
  }
  this.lastTransit = measuredTransitDeltaMs;

  // Kalman Predict + Update
  this.p = this.p + this.q;
  const kGain = this.p / (this.p + this.r);
  const obs = Math.max(0.1, measuredTransitDeltaMs);
  this.x = this.x + kGain * (obs - this.x);
  this.p = (1 - kGain) * this.p;

  // Simplified ITU-T G.107 R-factor -> MOS (1.0 - 4.5)
  const effectiveLatency = rttMs / 2 + this.x * 2;
  const rFactor = Math.max(0, Math.min(93.2, 93.2 - effectiveLatency * 0.08 - packetLossPct * 4.2));
  const mos = +(1 + 0.035 * rFactor + rFactor * (rFactor - 60) * (100 - rFactor) * 7e-6).toFixed(2);

  return {
    rawSampleMs: +obs.toFixed(2),
    kalmanJitterMs: +this.x.toFixed(2),
    rfc3550JitterMs: +this.rfc3550Jitter.toFixed(2),
    kalmanGain: +kGain.toFixed(3),
    voiceMosScore: Math.min(4.5, Math.max(1.0, mos))
  };
}
}
return { LinkKalmanEstimator };
}));
"""
