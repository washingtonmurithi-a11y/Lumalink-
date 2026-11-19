files["public/js/correction_inspector.js"] = """/
@file public/js/correction_inspector.js
@description Real-Time Galois Field GF(2^8) Reed-Solomon Correction & Healed Forensics Controller
*/
window.CorrectionInspector = (function () {
'use strict';
function runLiveTest() {
const payload = document.getElementById('fecTestPayload').value;
const corruptionRatio = Number(document.getElementById('fecNoiseLevel').value);
const fecMode = document.getElementById('quickFecSelect').value;
const ws = AppState.state.ws;
if (ws && ws.readyState === WebSocket.OPEN) {
  ws.send(JSON.stringify({
    type: 'SIGNAL_FEC_TEST',
    payload,
    fecMode,
    corruptionRatio
  }));
}
}
function renderReport(report, fromName = 'Local', relayedHw = 0) {
if (!report) return;
document.getElementById('hexCleanTx').textContent = report.hexBlock0.cleanTx;
document.getElementById('hexCorruptedRx').textContent = report.hexBlock0.corruptedRx;
document.getElementById('hexHealedOut').textContent = report.hexBlock0.healedOut;
document.getElementById('fecStatusBadge').textContent =
  `${report.codecSpec}: ${report.correctedErrors}/${report.injectedErrors} BYTES HEALED | ${report.failedBlocks} UNCORRECTABLE`;
document.getElementById('badgeHealedTotal').textContent =
  `HEALED: ${report.cumulative.healed} BYTES`;

const logBox = document.getElementById('repairLogContainer');
const repairDetails = report.repairs
  .slice(0, 8)
  .map((r) => `[Blk ${r.block} Byte ${r.byteIndex} (${r.region}): 0x${r.corruptedHex} -> 0x${r.repairedHex}]`)
  .join(' ');

const entry = document.createElement('div');
entry.style.marginBottom = '6px';
entry.innerHTML = `
  <span class="cyan">[${fromName}]</span>
  <strong class="emerald">${report.integrityVerified ? '100% RECOVERED' : 'PARTIAL'}</strong>
  <span style="color:#8496b0;">(${report.correctedErrors} errors repaired, ${relayedHw} ESP32 nodes driven)</span><br/>
  <span style="color:#cbd5e1;">${repairDetails || 'Zero channel bit flips detected.'}</span>
`;
logBox.prepend(entry);
}
return { runLiveTest, renderReport };
})();
"""
