files["core/galois_gf256.js"] = """/
@file core/galois_gf256.js
@description Deterministic Galois Field GF(2^8) Arithmetic Engine
Primitive Polynomial: P(x) = x^8 + x^4 + x^3 + x^2 + 1 (0x11D)
Universal UMD Module: Runs identically in Node.js (CommonJS) and Browser ES/Global.
*/
(function (root, factory) {
if (typeof module === 'object' && module.exports) {
module.exports = factory();
} else {
root.GaloisGF256 = factory();
}
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const PRIMITIVE_POLY = 0x11D;
const FIELD_SIZE = 256;
const FIELD_ORDER = 255;
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);
(function initLookupTables() {
let x = 1;
for (let i = 0; i < FIELD_ORDER; i++) {
EXP_TABLE[i] = x;
LOG_TABLE[x] = i;
x <<= 1;
if (x & FIELD_SIZE) {
x ^= PRIMITIVE_POLY;
}
}
for (let i = FIELD_ORDER; i < 512; i++) {
EXP_TABLE[i] = EXP_TABLE[i - FIELD_ORDER];
}
})();
function add(a, b) {
return (a ^ b) & 0xFF;
}
function sub(a, b) {
return (a ^ b) & 0xFF;
}
function mul(a, b) {
if (a === 0 || b === 0) return 0;
return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
}
function div(a, b) {
if (b === 0) throw new RangeError('GF(2^8): Division by zero');
if (a === 0) return 0;
return EXP_TABLE[(LOG_TABLE[a] + FIELD_ORDER - LOG_TABLE[b]) % FIELD_ORDER];
}
function pow(base, exponent) {
if (exponent === 0) return 1;
if (base === 0) return 0;
const modExp = ((exponent % FIELD_ORDER) + FIELD_ORDER) % FIELD_ORDER;
return EXP_TABLE[(LOG_TABLE[base] * modExp) % FIELD_ORDER];
}
function inv(a) {
if (a === 0) throw new RangeError('GF(2^8): Multiplicative inverse of zero undefined');
return EXP_TABLE[FIELD_ORDER - LOG_TABLE[a]];
}
function polyScale(poly, scalar) {
const out = new Uint8Array(poly.length);
if (scalar === 0) return out;
for (let i = 0; i < poly.length; i++) {
out[i] = mul(poly[i], scalar);
}
return out;
}
function polyAdd(p, q) {
const len = Math.max(p.length, q.length);
const out = new Uint8Array(len);
for (let i = 0; i < p.length; i++) {
out[i + len - p.length] = p[i];
}
for (let i = 0; i < q.length; i++) {
out[i + len - q.length] ^= q[i];
}
return out;
}
function polyMul(p, q) {
const out = new Uint8Array(p.length + q.length - 1);
for (let i = 0; i < p.length; i++) {
if (p[i] === 0) continue;
for (let j = 0; j < q.length; j++) {
out[i + j] ^= mul(p[i], q[j]);
}
}
return out;
}
function polyEval(poly, x) {
let acc = poly[0];
for (let i = 1; i < poly.length; i++) {
acc = mul(acc, x) ^ poly[i];
}
return acc;
}
function buildGeneratorPoly(numSym, startRoot = 0) {
let g = new Uint8Array([1]);
for (let i = 0; i < numSym; i++) {
g = polyMul(g, new Uint8Array([1, pow(2, startRoot + i)]));
}
return g;
}
return {
PRIMITIVE_POLY,
EXP_TABLE,
LOG_TABLE,
add,
sub,
mul,
div,
pow,
inv,
polyScale,
polyAdd,
polyMul,
polyEval,
buildGeneratorPoly
};
}));
"""
