files["server/wifi_discovery.js"] = """/
@file server/wifi_discovery.js
@description Wi-Fi Network Interface Discovery & Mathematical QR Code SVG Generator
Uses GF(2^8) Reed-Solomon ECC to generate a valid, phone-scannable QR Code SVG
for instant mobile pairing over your local Wi-Fi network.
*/
'use strict';
const os = require('os');
const GF = require('../core/galois_gf256');
function discoverWifiInterfaces() {
const nets = os.networkInterfaces();
const list = [];
for (const [name, addrs] of Object.entries(nets)) {
for (const addr of addrs) {
if (addr.family === 'IPv4' && !addr.internal) {
const isWifiLikely = /wi-?fi|wlan|wl|en0|airport/i.test(name);
list.push({
interface: name,
ip: addr.address,
netmask: addr.netmask,
mac: addr.mac,
priority: isWifiLikely ? 1 : 2
});
}
}
}
return list.sort((a, b) => a.priority - b.priority);
}
/
Generates a Version 3 (29x29) ECC-L QR Code SVG using GF(2^8) Reed-Solomon parity.
Supports URLs up to 53 ASCII bytes (e.g. "http://192.168.1.42:8080").
*/
function generatePairingQrSvg(urlText) {
const SIZE = 29;
const DATA_CODEWORDS = 55;
const ECC_CODEWORDS = 15;
const bytes = Buffer.from(String(urlText).slice(0, 53), 'utf8');
const bitStream = [];
const pushBits = (val, len) => {
for (let i = len - 1; i >= 0; i--) bitStream.push((val >> i) & 1);
};
// Byte mode (0100) + 8-bit length + payload + terminator
pushBits(0b0100, 4);
pushBits(bytes.length, 8);
for (const b of bytes) pushBits(b, 8);
pushBits(0, Math.min(4, DATA_CODEWORDS * 8 - bitStream.length));
while (bitStream.length % 8 !== 0) bitStream.push(0);
const dataCw = new Uint8Array(DATA_CODEWORDS);
for (let i = 0; i < bitStream.length / 8; i++) {
let byteVal = 0;
for (let b = 0; b < 8; b++) byteVal = (byteVal << 1) | bitStream[i * 8 + b];
dataCw[i] = byteVal;
}
const padBytes = [0xEC, 0x11];
for (let i = bitStream.length / 8; i < DATA_CODEWORDS; i++) {
dataCw[i] = padBytes[(i - bitStream.length / 8) % 2];
}
// Compute 15 Reed-Solomon ECC codewords over GF(2^8)
const gen = GF.buildGeneratorPoly(ECC_CODEWORDS, 0);
const rem = new Uint8Array(ECC_CODEWORDS);
for (let i = 0; i < DATA_CODEWORDS; i++) {
const factor = dataCw[i] ^ rem[0];
for (let j = 0; j < ECC_CODEWORDS - 1; j++) {
rem[j] = rem[j + 1] ^ GF.mul(gen[j + 1], factor);
}
rem[ECC_CODEWORDS - 1] = GF.mul(gen[ECC_CODEWORDS], factor);
}
const allCodewords = new Uint8Array(DATA_CODEWORDS + ECC_CODEWORDS);
allCodewords.set(dataCw, 0);
allCodewords.set(rem, DATA_CODEWORDS);
const grid = Array.from({ length: SIZE }, () => new Int8Array(SIZE).fill(-1));
const reserved = Array.from({ length: SIZE }, () => new Uint8Array(SIZE));
const placeFinder = (r0, c0) => {
for (let r = -1; r <= 7; r++) {
for (let c = -1; c <= 7; c++) {
const rr = r0 + r;
const cc = c0 + c;
if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) continue;
reserved[rr][cc] = 1;
const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
grid[rr][cc] = (inOuter || inInner) ? 1 : 0;
}
}
};
placeFinder(0, 0);
placeFinder(0, SIZE - 7);
placeFinder(SIZE - 7, 0);
// Version 3 Alignment Pattern at (20, 20)
for (let r = -2; r <= 2; r++) {
for (let c = -2; c <= 2; c++) {
const rr = 20 + r;
const cc = 20 + c;
reserved[rr][cc] = 1;
grid[rr][cc] = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) ? 1 : 0;
}
}
// Timing patterns
for (let i = 8; i < SIZE - 8; i++) {
reserved[6][i] = 1;
grid[6][i] = i % 2 === 0 ? 1 : 0;
reserved[i][6] = 1;
grid[i][6] = i % 2 === 0 ? 1 : 0;
}
// Format info (ECC Level L = 01, Mask 0 = 000 -> 15-bit BCH = 0x77C4)
const formatBits = 0x77C4;
const fCoords1 = [
[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
[7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
];
const fCoords2 = [
[SIZE - 1, 8], [SIZE - 2, 8], [SIZE - 3, 8], [SIZE - 4, 8], [SIZE - 5, 8], [SIZE - 6, 8], [SIZE - 7, 8],
[8, SIZE - 8], [8, SIZE - 7], [8, SIZE - 6], [8, SIZE - 5], [8, SIZE - 4], [8, SIZE - 3], [8, SIZE - 2], [8, SIZE - 1]
];
for (let i = 0; i < 15; i++) {
const bit = (formatBits >> (14 - i)) & 1;
const [r1, c1] = fCoords1[i];
const [r2, c2] = fCoords2[i];
reserved[r1][c1] = 1;
grid[r1][c1] = bit;
reserved[r2][c2] = 1;
grid[r2][c2] = bit;
}
reserved[SIZE - 8][8] = 1;
grid[SIZE - 8][8] = 1;
// Zig-zag bit placement with Mask 0 ((r + c) % 2 === 0)
const fullBits = [];
for (const cw of allCodewords) pushBits.call(null, cw, 8);
const dataBits = [];
for (const cw of allCodewords) {
for (let b = 7; b >= 0; b--) dataBits.push((cw >> b) & 1);
}
let bitIdx = 0;
let upward = true;
for (let col = SIZE - 1; col > 0; col -= 2) {
if (col === 6) col--;
for (let step = 0; step < SIZE; step++) {
const r = upward ? (SIZE - 1 - step) : step;
for (let dc = 0; dc < 2; dc++) {
const c = col - dc;
if (!reserved[r][c]) {
const rawBit = bitIdx < dataBits.length ? dataBits[bitIdx++] : 0;
const maskedBit = ((r + c) % 2 === 0) ? (rawBit ^ 1) : rawBit;
grid[r][c] = maskedBit;
}
}
}
upward = !upward;
}
const scale = 6;
const quiet = 2;
const dim = (SIZE + quiet * 2) * scale;
let rects = <rect width="${dim}" height="${dim}" fill="#ffffff" rx="6"/>;
for (let r = 0; r < SIZE; r++) {
for (let c = 0; c < SIZE; c++) {
if (grid[r][c] === 1) {
rects += <rect x="${(c + quiet) * scale}" y="${(r + quiet) * scale}" width="${scale}" height="${scale}" fill="#060a11"/>;
}
}
}
return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="176" height="176">${rects}</svg>;
}
module.exports = { discoverWifiInterfaces, generatePairingQrSvg };
"""
