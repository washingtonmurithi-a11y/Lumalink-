files["public/js/player.js"] = """/
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
"""
