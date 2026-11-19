files["server/gateway.js"] = """/
@file server/gateway.js
@description LumaLink Enterprise v3.0 Main Edge Gateway Server
Hosts the Industrial Command Dashboard over Wi-Fi LAN, bridges phone/device links,
accelerates live video streams, routes WebRTC calls, and drives ESP32-S3 Optical PHYs.
*/
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { discoverWifiInterfaces, generatePairingQrSvg } = require('./wifi_discovery');
const { WebSocketHub } = require('./ws_rfc6455');
const { WebRtcVoiceBroker } = require('./webrtc_voice_hub');
const { StreamEdgeAccelerator } = require('./stream_ingestor');
const { HardwareTcpBridge } = require('./tcp_hardware_bridge');
const CarrierScheduler = require('../core/carrier_scheduler');
const OpticalPhy = require('../core/optical_8csk_phy');
const KalmanMod = require('../core/jitter_kalman_filter');
const InspectorMod = require('../core/signal_inspector');
const HTTP_PORT = parseInt(process.env.PORT || '8080', 10);
const HW_PORT = parseInt(process.env.HW_PORT || '9090', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CORE_DIR = path.join(__dirname, '..', 'core');
const CONFIG_FILE = path.join(__dirname, 'lumalink.config.json');
function loadGatewayConfig() {
const ifaces = discoverWifiInterfaces();
const defaults = {
wifiSsid: 'LOCAL_WIFI_LAN',
hostIp: ifaces.length > 0 ? ifaces[0].ip : '127.0.0.1',
httpPort: HTTP_PORT,
distanceMeters: 25,
longevityMode: 'balanced',
bokehDefocus: true,
symbolRateHz: 32400,
mimoGrid: 4
};
try {
if (fs.existsSync(CONFIG_FILE)) {
return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
}
} catch {
// Use defaults
}
return defaults;
}
let gatewayConfig = loadGatewayConfig();
const bondingEngine = new CarrierScheduler.MultiCarrierBondingEngine();
const kalmanFilter = new KalmanMod.LinkKalmanEstimator();
const forensicsEngine = new InspectorMod.SignalForensicsEngine();
let wsHub = null;
let voiceBroker = null;
const hwBridge = new HardwareTcpBridge(HW_PORT, (nodeCount) => {
if (wsHub) wsHub.broadcast({ type: 'HW_NODES_UPDATE', hardwareNodes: nodeCount });
});
const streamAccelerator = new StreamEdgeAccelerator(bondingEngine, (telemetry) => {
if (wsHub) wsHub.broadcast({ type: 'STREAM_TELEMETRY', telemetry });
});
wsHub = new WebSocketHub(
(client, msg) => {
if (msg.type === 'REGISTER_PEER') {
if (msg.name) client.name = String(msg.name).slice(0, 32);
if (msg.deviceType) client.deviceType = String(msg.deviceType).slice(0, 24);
wsHub.broadcast({ type: 'PEERS_UPDATE', peers: wsHub.getPeersList() });
} else if (['CALL_OFFER', 'CALL_ANSWER', 'CALL_ICE', 'CALL_HANGUP'].includes(msg.type)) {
voiceBroker.routeSignaling(client, msg);
} else if (msg.type === 'CARRIER_PATCH') {
const updated = bondingEngine.patchCarrier(msg.carrierId, msg.patch || {});
if (updated) {
const plan = bondingEngine.computeBondingPlan(65536, gatewayConfig.distanceMeters, gatewayConfig.longevityMode);
wsHub.broadcast({ type: 'CARRIERS_UPDATE', carriers: bondingEngine.carriers, plan });
}
} else if (msg.type === 'SIGNAL_FEC_TEST') {
const report = forensicsEngine.inspectAndHealFrame(
msg.payload || 'LUMALINK_INDUSTRIAL_PACKET',
msg.fecMode || 'balanced',
Number(msg.corruptionRatio ?? 0.12)
);
const relayedHw = hwBridge.pushOpticalPayload(report.recoveredText);
wsHub.broadcast({
type: 'FEC_FORENSICS_REPORT',
fromName: client.name,
relayedHw,
report
});
}
},
(peers) => {
if (wsHub) wsHub.broadcast({ type: 'PEERS_UPDATE', peers });
}
);
voiceBroker = new WebRtcVoiceBroker(wsHub);
function parseJsonBody(req) {
return new Promise((resolve, reject) => {
let raw = '';
req.on('data', (c) => { raw += c; });
req.on('end', () => {
try {
resolve(raw ? JSON.parse(raw) : {});
} catch (e) {
reject(e);
}
});
});
}
const MIME_MAP = {
'.html': 'text/html; charset=utf-8',
'.css': 'text/css; charset=utf-8',
'.js': 'application/javascript; charset=utf-8',
'.json': 'application/json; charset=utf-8',
'.svg': 'image/svg+xml'
};
function buildSystemSnapshot() {
const interfaces = discoverWifiInterfaces();
const hostUrl = http://${gatewayConfig.hostIp}:${gatewayConfig.httpPort};
const qrSvg = generatePairingQrSvg(hostUrl);
const bondingPlan = bondingEngine.computeBondingPlan(
65536,
gatewayConfig.distanceMeters,
gatewayConfig.longevityMode
);
const opticalBudget = OpticalPhy.computeOpticalChannelBudget({
distanceMeters: gatewayConfig.distanceMeters,
symbolRateHz: gatewayConfig.symbolRateHz,
mimoGrid: gatewayConfig.mimoGrid,
bokehDefocus: gatewayConfig.bokehDefocus
});
const kalman = kalmanFilter.update(bondingPlan.effectiveJitterMs, 0.15, 11.5);
return {
status: 'ONLINE',
hostUrl,
qrSvg,
interfaces,
config: gatewayConfig,
carriers: bondingEngine.carriers,
bondingPlan,
opticalBudget,
kalman,
peers: wsHub.getPeersList(),
hardwareNodes: hwBridge.nodes.size,
streams: Array.from(streamAccelerator.streams.values())
};
}
const httpServer = http.createServer(async (req, res) => {
const urlObj = new URL(req.url, http://${req.headers.host || 'localhost'});
if (urlObj.pathname === '/api/stream/proxy' && req.method === 'GET') {
return streamAccelerator.proxyRequest(req, res, urlObj);
}
if (urlObj.pathname === '/api/stream/ingest' && req.method === 'POST') {
try {
const body = await parseJsonBody(req);
const stream = streamAccelerator.registerStreamLink({
url: body.url,
label: body.label,
fecMode: body.fecMode || 'balanced',
distanceMeters: gatewayConfig.distanceMeters
});
wsHub.broadcast({ type: 'STREAM_ADDED', stream });
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: true, stream }));
} catch (err) {
res.writeHead(400, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: false, error: err.message }));
}
}
if (urlObj.pathname === '/api/status' && req.method === 'GET') {
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify(buildSystemSnapshot()));
}
if (urlObj.pathname === '/api/wifi-config' && req.method === 'POST') {
try {
const incoming = await parseJsonBody(req);
gatewayConfig = {
...gatewayConfig,
wifiSsid: String(incoming.wifiSsid || gatewayConfig.wifiSsid).slice(0, 64),
hostIp: String(incoming.hostIp || gatewayConfig.hostIp).slice(0, 45),
distanceMeters: Math.min(200, Math.max(1, Number(incoming.distanceMeters) || 25)),
longevityMode: ['eco', 'balanced', 'max_boost'].includes(incoming.longevityMode)
? incoming.longevityMode
: 'balanced',
bokehDefocus: incoming.bokehDefocus !== false,
mimoGrid: [1, 4, 8].includes(Number(incoming.mimoGrid)) ? Number(incoming.mimoGrid) : 4
};
fs.writeFileSync(CONFIG_FILE, JSON.stringify(gatewayConfig, null, 2));
const snap = buildSystemSnapshot();
wsHub.broadcast({ type: 'SYSTEM_SYNC', snapshot: snap });
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: true, snapshot: snap }));
} catch (err) {
res.writeHead(400, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: false, error: err.message }));
}
}
// Expose /core/* UMD modules directly to the browser dashboard
if (urlObj.pathname.startsWith('/core/')) {
const rel = path.basename(urlObj.pathname);
const coreFile = path.join(CORE_DIR, rel);
if (fs.existsSync(coreFile)) {
res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
return fs.createReadStream(coreFile).pipe(res);
}
}
const reqPath = urlObj.pathname === '/' ? '/index.html' : urlObj.pathname;
const targetFile = path.normalize(path.join(PUBLIC_DIR, reqPath));
if (!targetFile.startsWith(PUBLIC_DIR) || !fs.existsSync(targetFile)) {
res.writeHead(404, { 'Content-Type': 'text/plain' });
return res.end('404 Not Found');
}
res.writeHead(200, { 'Content-Type': MIME_MAP[path.extname(targetFile)] || 'application/octet-stream' });
fs.createReadStream(targetFile).pipe(res);
});
httpServer.on('upgrade', (req, socket) => {
wsHub.handleUpgrade(req, socket, (client) => ({
type: 'WELCOME',
clientId: client.id,
snapshot: buildSystemSnapshot()
}));
});
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
const ifaces = discoverWifiInterfaces();
console.log('\n========================================================================');
console.log('  LUMALINK ENTERPRISE v3.0 — WI-FI & OPTICAL EDGE GATEWAY IS ONLINE');
console.log('');
console.log(  Local Dashboard : http://localhost:${HTTP_PORT});
ifaces.forEach((i) => {
console.log(  Wi-Fi Phone URL : http://${i.ip}:${HTTP_PORT}  [${i.interface}]);
});
console.log(  ESP32-S3 PHY    : TCP Port ${HW_PORT});
console.log('\n');
});
hwBridge.listen();
"""
