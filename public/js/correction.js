files["public/js/correction_.js"] = """/
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
24. public/js/device_link_manager.js
files["public/js/device_link_manager.js"] = """/
@file public/js/device_link_manager.js
@description Phone & Secondary Device Linking, Full-Duplex WebRTC Voice Calls,
and Live Camera Rolling-Shutter 8-CSK Optical Demodulator
*/
window.DeviceLinkManager = (function () {
'use strict';
let peerConn = null;
let localAudioStream = null;
let activeCallPeerId = null;
let opticalCamStream = null;
let opticalTimer = null;
function togglePairModal(show) {
document.getElementById('pairModal').style.display = show ? 'flex' : 'none';
}
function copyShareUrl() {
const input = document.getElementById('modalShareUrl');
input.select();
navigator.clipboard?.writeText(input.value);
}
function renderPeers(peers, selfId) {
const box = document.getElementById('linkedDevicesList');
if (!box) return;
box.innerHTML = '';
peers.forEach((p) => {
  const isSelf = p.id === selfId;
  const row = document.createElement('div');
  row.className = 'device-row';
  row.innerHTML = `
    <div>
      <strong>${p.name}</strong> <span class="cyan">[${p.deviceType || 'NODE'}]</span>
      ${isSelf ? '<strong class="emerald"> (THIS DEVICE)</strong>' : ''}
      <div style="font-size:0.68rem;color:#8496b0;">LAN IP: ${p.ip}</div>
    </div>
    ${!isSelf ? `<button class="btn-emerald" onclick="DeviceLinkManager.startCall('${p.id}', '${p.name}')">CALL</button>` : ''}
  `;
  box.appendChild(row);
});
}
function buildPeerConnection(targetId) {
const pc = new RTCPeerConnection({ iceServers: [] });
pc.onicecandidate = (e) => {
if (e.candidate && AppState.state.ws) {
AppState.state.ws.send(JSON.stringify({ type: 'CALL_ICE', targetId, candidate: e.candidate }));
}
};
pc.ontrack = (e) => {
document.getElementById('remoteVoiceAudio').srcObject = e.streams[0];
};
return pc;
}
async function startCall(targetId, targetName) {
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
return alert('Voice calls require localhost or HTTPS microphone permission.');
}
localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
activeCallPeerId = targetId;
peerConn = buildPeerConnection(targetId);
localAudioStream.getTracks().forEach((t) => peerConn.addTrack(t, localAudioStream));
const offer = await peerConn.createOffer();
await peerConn.setLocalDescription(offer);
AppState.state.ws.send(JSON.stringify({ type: 'CALL_OFFER', targetId, sdp: offer }));

document.getElementById('voiceCallState').textContent = `CONNECTED -> ${targetName}`;
document.getElementById('btnHangupCall').style.display = 'inline-block';
}
async function onSignalingMessage(msg) {
if (msg.type === 'CALL_OFFER') {
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
activeCallPeerId = msg.fromId;
peerConn = buildPeerConnection(msg.fromId);
localAudioStream.getTracks().forEach((t) => peerConn.addTrack(t, localAudioStream));
  await peerConn.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  const answer = await peerConn.createAnswer();
  await peerConn.setLocalDescription(answer);
  AppState.state.ws.send(JSON.stringify({ type: 'CALL_ANSWER', targetId: msg.fromId, sdp: answer }));

  document.getElementById('voiceCallState').textContent = `IN CALL: ${msg.fromName}`;
  document.getElementById('btnHangupCall').style.display = 'inline-block';
} else if (msg.type === 'CALL_ANSWER' && peerConn) {
  await peerConn.setRemoteDescription(new RTCSessionDescription(msg.sdp));
} else if (msg.type === 'CALL_ICE' && peerConn && msg.candidate) {
  await peerConn.addIceCandidate(new RTCIceCandidate(msg.candidate));
} else if (msg.type === 'CALL_HANGUP') {
  cleanupCall();
}
}
function hangup() {
if (activeCallPeerId && AppState.state.ws) {
AppState.state.ws.send(JSON.stringify({ type: 'CALL_HANGUP', targetId: activeCallPeerId }));
}
cleanupCall();
}
function cleanupCall() {
if (peerConn) { peerConn.close(); peerConn = null; }
if (localAudioStream) { localAudioStream.getTracks().forEach((t) => t.stop()); localAudioStream = null; }
activeCallPeerId = null;
document.getElementById('voiceCallState').textContent = 'STANDBY';
document.getElementById('btnHangupCall').style.display = 'none';
}
async function toggleOpticalCameraRx() {
const vid = document.getElementById('opticalCamPreview');
const readout = document.getElementById('opticalCamReadout');
if (opticalCamStream) {
  clearInterval(opticalTimer);
  opticalCamStream.getTracks().forEach((t) => t.stop());
  opticalCamStream = null;
  vid.style.display = 'none';
  readout.textContent = '';
  return;
}

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  readout.textContent = 'Camera API unavailable on non-HTTPS LAN origin; using synthetic optical sampler.';
  return;
}

opticalCamStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
vid.srcObject = opticalCamStream;
vid.style.display = 'block';

const offCanvas = document.createElement('canvas');
offCanvas.width = 64;
offCanvas.height = 64;
const octx = offCanvas.getContext('2d');

opticalTimer = setInterval(() => {
  if (vid.readyState < 2) return;
  octx.drawImage(vid, 0, 0, 64, 64);
  const px = octx.getImageData(32, 32, 1, 1).data;
  const match = Optical8CSKPhy.classifyRgbSample(px[0], px[1], px[2]);
  const symInfo = Optical8CSKPhy.CONSTELLATION_8CSK[match.symbol];
  readout.textContent = `OPTICAL CAM LOCK: ${symInfo.label} (${symInfo.bits}) | RGB(${px[0]},${px[1]},${px[2]})`;
}, 150);
}
return {
togglePairModal,
copyShareUrl,
renderPeers,
startCall,
onSignalingMessage,
hangup,
toggleOpticalCameraRx
};
})();
"""
25. public/js/stream_player.js
files["public/js/stream_player.js"] = """/
@file public/js/stream_player.js
@description Universal Live Stream & Video Link Accelerator Controller
*/
window.StreamPlayer = (function () {
'use strict';
let hls = null;
function loadPreset(url, label) {
document.getElementById('quickLinkInput').value = url;
ingestUrl(url, label);
}
function ingestFromBar() {
const url = document.getElementById('quickLinkInput').value.trim();
if (!url) return alert('Paste a live stream (.m3u8) or video (.mp4 / .webm) URL first.');
ingestUrl(url, '');
}
async function ingestUrl(url, label) {
const fecMode = document.getElementById('quickFecSelect').value;
const caption = document.getElementById('streamCaptionText');
caption.textContent = 'Binding link to Multi-Carrier Edge Proxy & GF(2^8) Reed-Solomon FEC...';
const res = await fetch('/api/stream/ingest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url, label, fecMode })
});
const data = await res.json();
if (!data.ok) {
  caption.textContent = `Stream error: ${data.error}`;
  return;
}

const stream = data.stream;
caption.textContent = `ACCELERATED: ${stream.kind} | FEC=${fecMode.toUpperCase()} | Proxy=${stream.proxyUrl}`;
attachPlayer(stream.proxyUrl, stream.kind === 'HLS_LIVE_STREAM');
}
function attachPlayer(proxyUrl, isHls) {
const video = document.getElementById('edgeVideoPlayer');
if (hls) { hls.destroy(); hls = null; }
if (isHls && window.Hls && Hls.isSupported()) {
  hls = new Hls({ maxBufferLength: 20, liveSyncDurationCount: 3 });
  hls.loadSource(proxyUrl);
  hls.attachMedia(video);
  hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
} else {
  video.src = proxyUrl;
  video.play().catch(() => {});
}
}
function onTelemetry(t) {
document.getElementById('streamCacheStat').textContent =
CACHE HITS: ${t.stats.cacheHits}/${t.stats.segmentsServed} • ${t.fecSpec};
}
return { loadPreset, ingestFromBar, onTelemetry };
})();
""
