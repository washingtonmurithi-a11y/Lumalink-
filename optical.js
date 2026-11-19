files["core/optical_8csk_phy.js"] = """/
@file core/optical_8csk_phy.js
@description IEEE 802.15.7a / 8802-15-7-2025 Differential 8-CSK Optical Camera PHY
Models RGB Color-Shift Keying constellation, CIE 1931 chromaticity coordinates,
rolling-shutter scanline capture, and Bokeh defocus optical SNR gain.
*/
(function (root, factory) {
if (typeof module === 'object' && module.exports) {
module.exports = factory();
} else {
root.Optical8CSKPhy = factory();
}
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const CONSTELLATION_8CSK = [
{ symbol: 0, bits: '000', label: 'S0-DARK',    rgb: [14, 22, 38],    cie: [0.31, 0.32] },
{ symbol: 1, bits: '001', label: 'S1-BLUE',    rgb: [0, 128, 255],   cie: [0.15, 0.06] },
{ symbol: 2, bits: '010', label: 'S2-GREEN',   rgb: [0, 230, 118],   cie: [0.30, 0.60] },
{ symbol: 3, bits: '011', label: 'S3-CYAN',    rgb: [0, 229, 255],   cie: [0.22, 0.33] },
{ symbol: 4, bits: '100', label: 'S4-RED',     rgb: [255, 61, 87],   cie: [0.64, 0.33] },
{ symbol: 5, bits: '101', label: 'S5-MAGENTA', rgb: [234, 0, 255],   cie: [0.38, 0.19] },
{ symbol: 6, bits: '110', label: 'S6-YELLOW',  rgb: [255, 214, 0],   cie: [0.45, 0.48] },
{ symbol: 7, bits: '111', label: 'S7-WHITE',   rgb: [248, 250, 252], cie: [0.33, 0.34] }
];
function bytesTo8CskSymbols(uint8Array) {
const symbols = [];
let bitBuffer = 0;
let bitCount = 0;
for (let i = 0; i < uint8Array.length; i++) {
bitBuffer = (bitBuffer << 8) | uint8Array[i];
bitCount += 8;
while (bitCount >= 3) {
bitCount -= 3;
symbols.push((bitBuffer >> bitCount) & 0x07);
}
}
if (bitCount > 0) {
symbols.push((bitBuffer << (3 - bitCount)) & 0x07);
}
return symbols;
}
function classifyRgbSample(r, g, b) {
let bestSym = 0;
let minDistSq = Infinity;
for (let i = 0; i < CONSTELLATION_8CSK.length; i++) {
const [cr, cg, cb] = CONSTELLATION_8CSK[i].rgb;
const dSq = (r - cr)  2 + (g - cg)  2 + (b - cb)  2;
if (dSq < minDistSq) {
minDistSq = dSq;
bestSym = i;
}
}
return { symbol: bestSym, euclideanError: Math.sqrt(minDistSq) };
}
function computeOpticalChannelBudget({
distanceMeters = 15,
symbolRateHz = 32400,
mimoGrid = 4,
bokehDefocus = true,
ambientLux = 350,
codeRate = 0.75
}) {
const parallelEmitters = mimoGrid * mimoGrid;
const rawBitrateBps = symbolRateHz * 3 * parallelEmitters;
const netGoodputBps = rawBitrateBps * codeRate;
const pathLossDb = 20 * Math.log10(Math.max(0.5, distanceMeters));
const bokehGainDb = bokehDefocus ? 11.4 : 0.0;
const glarePenaltyDb = 10 * Math.log10(Math.max(1, ambientLux / 100));
const opticalSnrDb = +(36.0 + bokehGainDb - pathLossDb - glarePenaltyDb).toFixed(2);

const scanlinesCovered = Math.max(
  2,
  Math.round((bokehDefocus ? 460 : 85) / Math.max(1, distanceMeters * 0.55))
);

return {
  parallelEmitters,
  rawBitrateKbps: +(rawBitrateBps / 1000).toFixed(1),
  netGoodputKbps: +(netGoodputBps / 1000).toFixed(1),
  opticalSnrDb,
  bokehGainDb,
  scanlinesCovered,
  flickerSafe: symbolRateHz >= 300
};
300
};
}
return {
CONSTELLATION_8CSK,
bytesTo8CskSymbols,
classifyRgbSample,
computeOpticalChannelBudget
};
}));
"""
