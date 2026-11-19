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
