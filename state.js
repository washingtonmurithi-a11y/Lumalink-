files["public/js/app_state.js"] = """/
@file public/js/app_state.js
@description Centralized Reactive State & WebSocket Multiplexer for LumaLink Dashboard
*/
window.AppState = (function () {
'use strict';
const state = {
ws: null,
clientId: null,
snapshot: null,
jitterTrace: new Array(72).fill(1.1),
loadTrace: new Array(72).fill(120),
opticalCarrierTrace: new Array(72).fill(0.5)
};
function connect() {
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(${proto}//${location.host});
state.ws = ws;
ws.onopen = () => {
  document.getElementById('gatewayLed').style.background = '#00e676';
  const isMobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent);
  ws.send(JSON.stringify({
    type: 'REGISTER_PEER',
    deviceType: isMobile ? 'PHONE_MOBILE' : 'WORKSTATION_PC',
    name: `${isMobile ? 'Phone' : 'Console'}-${Math.floor(100 + Math.random() * 900)}`
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'WELCOME':
      state.clientId = msg.clientId;
      applySnapshot(msg.snapshot);
      CorrectionInspector.runLiveTest();
      break;
    case 'SYSTEM_SYNC':
      applySnapshot(msg.snapshot);
      break;
    case 'CARRIERS_UPDATE':
      if (state.snapshot) {
        state.snapshot.carriers = msg.carriers;
        state.snapshot.bondingPlan = msg.plan;
        renderCarrierMatrix();
        renderImprovementMetrics();
      }
      break;
    case 'PEERS_UPDATE':
      DeviceLinkManager.renderPeers(msg.peers, state.clientId);
      break;
    case 'FEC_FORENSICS_REPORT':
      CorrectionInspector.renderReport(msg.report, msg.fromName, msg.relayedHw);
      break;
    case 'STREAM_TELEMETRY':
      StreamPlayer.onTelemetry(msg.telemetry);
      break;
    case 'CALL_OFFER':
    case 'CALL_ANSWER':
    case 'CALL_ICE':
    case 'CALL_HANGUP':
      DeviceLinkManager.onSignalingMessage(msg);
      break;
  }
};

ws.onclose = () => {
  document.getElementById('gatewayLed').style.background = '#ff3d57';
  setTimeout(connect, 2000);
};
}
function applySnapshot(snap) {
if (!snap) return;
state.snapshot = snap;
document.getElementById('badgeHostUrl').textContent = `HOST: ${snap.hostUrl}`;
document.getElementById('modalWifiSsid').textContent = snap.config.wifiSsid;
document.getElementById('modalShareUrl').value = snap.hostUrl;
if (snap.qrSvg) {
  document.getElementById('qrCodeContainer').innerHTML = snap.qrSvg;
}

document.getElementById('cfgWifiSsid').value = snap.config.wifiSsid;
document.getElementById('cfgLongevity').value = snap.config.longevityMode;
document.getElementById('cfgMimoGrid').value = String(snap.config.mimoGrid || 4);
document.getElementById('cfgDistSlider').value = snap.config.distanceMeters;
document.getElementById('cfgDistLabel').textContent = `${snap.config.distanceMeters} m`;

const ipSel = document.getElementById('cfgHostIp');
if (snap.interfaces && snap.interfaces.length > 0) {
  ipSel.innerHTML = snap.interfaces
    .map((i) => `<option value="${i.ip}">${i.ip} (${i.interface})</option>`)
    .join('');
}
ipSel.value = snap.config.hostIp;

renderImprovementMetrics();
renderCarrierMatrix();
DeviceLinkManager.renderPeers(snap.peers || [], state.clientId);
}
function renderImprovementMetrics() {
const snap = state.snapshot;
if (!snap || !snap.bondingPlan) return;
const p = snap.bondingPlan;
const opt = snap.opticalBudget;
document.getElementById('badgeSpeedGain').textContent = `SPEED: ${p.speedGainFactor}x (${p.aggregateMbps} Mbps)`;
document.getElementById('valAggSpeed').textContent = `${p.aggregateMbps} Mbps`;
document.getElementById('deltaSpeed').textContent = `${p.speedGainFactor}x faster than single unmanaged Wi-Fi`;

document.getElementById('valMaxRange').textContent = `${p.effectiveRangeMeters} m`;
document.getElementById('deltaRange').textContent = `${p.rangeGainFactor}x reach via Mesh + Bokeh (+${opt.bokehGainDb} dB)`;

document.getElementById('valJitter').textContent = `${p.effectiveJitterMs} ms`;
document.getElementById('deltaJitter').textContent = `-${p.jitterReductionPct}% jitter | Voice MOS ${snap.kalman.voiceMosScore}/4.5`;

document.getElementById('valOpticalSnr').textContent = `${opt.opticalSnrDb} dB SNR`;
document.getElementById('deltaFecTier').textContent = `Active FEC: RS(${p.recommendedRS[0]},${p.recommendedRS[1]})`;

document.getElementById('valLongevity').textContent = `${p.batteryHoursEst.toFixed(1)} hrs`;
document.getElementById('profileSummaryTag').textContent = `PROFILE: ${snap.config.longevityMode.toUpperCase()} @ ${snap.config.distanceMeters}M`;
document.getElementById('bondedTotalTag').textContent = `${p.aggregateMbps} MBPS AGGREGATE`;
}
function renderCarrierMatrix() {
const snap = state.snapshot;
if (!snap) return;
const container = document.getElementById('carrierMatrixList');
container.innerHTML = '';
snap.carriers.forEach((c) => {
  const alloc = snap.bondingPlan.allocations.find((a) => a.id === c.id);
  const pct = alloc ? alloc.sharePct : 0;
  const row = document.createElement('div');
  row.className = 'carrier-item';
  row.innerHTML = `
    <div style="flex:1;">
      <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:0.76rem;">
        <strong>${c.name} <span style="color:var(--muted);font-weight:400;">[${c.standard}]</span></strong>
        <span class="cyan">${c.enabled ? `${alloc ? alloc.effectiveMbps : c.baseMbps} Mbps • RTT ${c.rttMs}ms • Load ${pct}%` : 'STANDBY'}</span>
      </div>
      <div class="carrier-bar"><div class="carrier-fill" style="width:${c.enabled ? pct : 0}%"></div></div>
    </div>
    <button class="${c.enabled ? 'btn-emerald' : 'btn-ghost'}" onclick="AppState.toggleCarrier('${c.id}', ${!c.enabled})">
      ${c.enabled ? 'ACTIVE' : 'ENABLE'}
    </button>
  `;
  container.appendChild(row);
});
}
function toggleCarrier(carrierId, enabled) {
if (state.ws && state.ws.readyState === WebSocket.OPEN) {
state.ws.send(JSON.stringify({ type: 'CARRIER_PATCH', carrierId, patch: { enabled } }));
}
}
function previewDistance(val) {
document.getElementById('cfgDistLabel').textContent = ${val} m;
}
async function saveWifiConfig() {
const payload = {
wifiSsid: document.getElementById('cfgWifiSsid').value,
hostIp: document.getElementById('cfgHostIp').value,
longevityMode: document.getElementById('cfgLongevity').value,
mimoGrid: Number(document.getElementById('cfgMimoGrid').value),
distanceMeters: Number(document.getElementById('cfgDistSlider').value)
};
const res = await fetch('/api/wifi-config', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(payload)
});
if (res.ok) {
document.getElementById('cfgSaveFeedback').textContent = 'SYNCED ACROSS WI-FI LAN';
setTimeout(() => { document.getElementById('cfgSaveFeedback').textContent = ''; }, 2500);
}
}
connect();
return { state, toggleCarrier, previewDistance, saveWifiConfig };
})();
"""
