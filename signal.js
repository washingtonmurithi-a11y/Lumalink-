files["public/js/signal_oscilloscope.js"] = """/
@file public/js/signal_oscilloscope.js
@description 60fps Multi-Channel Signal Activity & 8-CSK Chromaticity Oscilloscope
*/
window.SignalOscilloscope = (function () {
'use strict';
let viewMode = 'waveform';
let frame = 0;
function setMode(mode) {
viewMode = mode;
document.getElementById('btnScopeWave').classList.toggle('active', mode === 'waveform');
document.getElementById('btnScopeCsk').classList.toggle('active', mode === 'constellation');
}
function renderLoop() {
requestAnimationFrame(renderLoop);
frame++;
const canvas = document.getElementById('mainSignalCanvas');
if (!canvas) return;
const ctx = canvas.getContext('2d');
const st = AppState.state;
if (frame % 12 === 0 && st.snapshot && st.snapshot.bondingPlan) {
  const p = st.snapshot.bondingPlan;
  st.jitterTrace.push(Math.max(0.15, p.effectiveJitterMs + (Math.random() - 0.5) * 0.35));
  st.jitterTrace.shift();
  st.loadTrace.push(p.aggregateMbps * (0.65 + Math.sin(frame * 0.05) * 0.15 + Math.random() * 0.1));
  st.loadTrace.shift();
}

ctx.fillStyle = '#03060c';
ctx.fillRect(0, 0, canvas.width, canvas.height);

// Subtle engineering graticule
ctx.strokeStyle = '#0f192b';
ctx.lineWidth = 1;
for (let x = 0; x < canvas.width; x += 48) {
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
}
for (let y = 0; y < canvas.height; y += 42) {
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
}

if (viewMode === 'waveform') {
  // Trace 1: Bonded Throughput Load (Emerald)
  ctx.beginPath();
  ctx.strokeStyle = '#00e676';
  ctx.lineWidth = 2.2;
  st.loadTrace.forEach((v, idx) => {
    const x = (idx / (st.loadTrace.length - 1)) * canvas.width;
    const y = canvas.height - Math.min(canvas.height - 16, (v / 1400) * canvas.height + 16);
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Trace 2: Kalman Smoothed Jitter (Cyan)
  ctx.beginPath();
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 2.2;
  st.jitterTrace.forEach((v, idx) => {
    const x = (idx / (st.jitterTrace.length - 1)) * canvas.width;
    const y = canvas.height - Math.min(canvas.height - 16, v * 28 + 18);
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Trace 3: Differential Manchester 8-CSK Optical Square Carrier (Amber)
  ctx.beginPath();
  ctx.strokeStyle = '#ffab00';
  ctx.lineWidth = 1.6;
  for (let x = 0; x < canvas.width; x += 6) {
    const phase = ((x + frame * 3) >> 4) & 7;
    const level = ((phase ^ (phase >> 1)) & 1) ? -22 : 22;
    const y = canvas.height * 0.5 + level;
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
} else {
  // CIE 1931 8-CSK Chromaticity Constellation Plane
  const cx = canvas.width * 0.5;
  const cy = canvas.height * 0.5;
  const scale = Math.min(canvas.width, canvas.height) * 0.85;

  Optical8CSKPhy.CONSTELLATION_8CSK.forEach((pt) => {
    const px = cx + (pt.cie[0] - 0.35) * scale;
    const py = cy - (pt.cie[1] - 0.32) * scale;
    const [r, g, b] = pt.rgb;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.fill();

    // Live noisy received symbol cloud around constellation centroid
    for (let k = 0; k < 5; k++) {
      const jx = px + (Math.random() - 0.5) * 14;
      const jy = py + (Math.random() - 0.5) * 14;
      ctx.fillStyle = `rgba(${r},${g},${b},0.45)`;
      ctx.fillRect(jx, jy, 2.5, 2.5);
    }

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '10px monospace';
    ctx.fillText(`${pt.label} (${pt.bits})`, px + 12, py + 3);
  });
}
}
renderLoop();
return { setMode };
})();
"""
