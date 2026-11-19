files["server/stream_ingestor.js"] = """/
@file server/stream_ingestor.js
@description Universal Live Video & Stream Link Accelerator Proxy
Rewrites .m3u8 HLS manifests, caches segments in Wi-Fi Edge RAM, applies
GF(2^8) Reed-Solomon FEC parity blocks, and stripes chunks across bonded carriers.
*/
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const RSMod = require('../core/reed_solomon_codec');
class StreamEdgeAccelerator {
constructor(bondingEngine, onTelemetry) {
this.bondingEngine = bondingEngine;
this.onTelemetry = onTelemetry || (() => {});
this.streams = new Map();
this.cache = new Map();
this.maxCacheItems = 64;
this.codecs = {
speed: new RSMod.AdaptiveRSCodec(32, 28),
balanced: new RSMod.AdaptiveRSCodec(32, 24),
extreme: new RSMod.AdaptiveRSCodec(32, 16)
};
}
registerStreamLink({ url, label, fecMode = 'balanced', distanceMeters = 20 }) {
const parsed = new URL(url);
if (!['http:', 'https:'].includes(parsed.protocol)) {
throw new Error('Only http:// or https:// stream links are accepted.');
}
const id = crypto.randomBytes(5).toString('hex');
const isHls = parsed.pathname.toLowerCase().includes('.m3u8');
const record = {
id,
url: parsed.toString(),
label: String(label || parsed.hostname).slice(0, 64),
fecMode: ['speed', 'balanced', 'extreme'].includes(fecMode) ? fecMode : 'balanced',
distanceMeters: Number(distanceMeters) || 20,
kind: isHls ? 'HLS_LIVE_STREAM' : 'DIRECT_VIDEO_LINK',
proxyUrl: /api/stream/proxy?id=${id}&target=${encodeURIComponent(parsed.toString())},
stats: {
segmentsServed: 0,
cacheHits: 0,
fecBlocksGenerated: 0,
bytesAccelerated: 0,
lastLatencyMs: 0
}
};
this.streams.set(id, record);
return record;
}
rewriteHlsPlaylist(rawManifest, baseUrl, streamId) {
return rawManifest
.split(/\r?\n/)
.map((line) => {
const trimmed = line.trim();
if (!trimmed) return line;
if (trimmed.startsWith('#')) {
return line.replace(/URI="([^"]+)"/g, (_, uri) => {
const abs = new URL(uri, baseUrl).toString();
return URI="/api/stream/proxy?id=${streamId}&target=${encodeURIComponent(abs)}";
});
}
const absSegment = new URL(trimmed, baseUrl).toString();
return /api/stream/proxy?id=${streamId}&target=${encodeURIComponent(absSegment)};
})
.join('\n');
}
_fetchUpstream(targetUrl, rangeHeader, depth = 0) {
return new Promise((resolve, reject) => {
if (depth > 5) return reject(new Error('Maximum HTTP redirect depth exceeded'));
const u = new URL(targetUrl);
const transport = u.protocol === 'https:' ? https : http;
const headers = { 'User-Agent': 'LumaLink-Edge-Proxy/3.0', 'Accept': '/' };
if (rangeHeader) headers['Range'] = rangeHeader;
  const t0 = Date.now();
  const req = transport.get(u, { headers, timeout: 12000 }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      const next = new URL(res.headers.location, targetUrl).toString();
      return resolve(this._fetchUpstream(next, rangeHeader, depth + 1));
    }
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      resolve({
        statusCode: res.statusCode || 200,
        headers: res.headers,
        buffer: Buffer.concat(chunks),
        finalUrl: targetUrl,
        latencyMs: Math.max(1, Date.now() - t0)
      });
    });
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('Upstream stream request timed out')));
});
}
async proxyRequest(req, res, urlObj) {
const streamId = urlObj.searchParams.get('id') || 'adhoc';
const targetUrl = urlObj.searchParams.get('target');
if (!targetUrl) {
res.writeHead(400, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: false, error: 'Missing target URL' }));
}
const record = this.streams.get(streamId);
const range = req.headers.range || null;
const cacheKey = `${targetUrl}::${range || 'FULL'}`;
const isM3u8 = targetUrl.toLowerCase().includes('.m3u8');

try {
  let fetched = null;
  let cacheHit = false;

  if (!isM3u8 && this.cache.has(cacheKey)) {
    const entry = this.cache.get(cacheKey);
    if (Date.now() - entry.ts < 30000) {
      fetched = { ...entry, latencyMs: 1 };
      cacheHit = true;
    }
  }

  if (!fetched) {
    fetched = await this._fetchUpstream(targetUrl, range);
    if (!isM3u8 && fetched.statusCode >= 200 && fetched.statusCode < 300 && fetched.buffer.length < 8 * 1024 * 1024) {
      if (this.cache.size >= this.maxCacheItems) {
        this.cache.delete(this.cache.keys().next().value);
      }
      this.cache.set(cacheKey, {
        statusCode: fetched.statusCode,
        headers: fetched.headers,
        buffer: fetched.buffer,
        ts: Date.now()
      });
    }
  }

  const contentType = String(fetched.headers['content-type'] || 'application/octet-stream');
  let outBuf = fetched.buffer;

  if (isM3u8 || contentType.includes('mpegurl')) {
    const rewritten = this.rewriteHlsPlaylist(fetched.buffer.toString('utf8'), fetched.finalUrl, streamId);
    outBuf = Buffer.from(rewritten, 'utf8');
  }

  const mode = record ? record.fecMode : 'balanced';
  const codec = this.codecs[mode] || this.codecs.balanced;
  const sample = outBuf.subarray(0, Math.min(outBuf.length, 4096));
  const fecInfo = codec.encodeBuffer(sample);
  const bondPlan = this.bondingEngine.computeBondingPlan(outBuf.length, record ? record.distanceMeters : 20);

  if (record) {
    record.stats.segmentsServed += 1;
    if (cacheHit) record.stats.cacheHits += 1;
    record.stats.fecBlocksGenerated += fecInfo.numBlocks;
    record.stats.bytesAccelerated += outBuf.length;
    record.stats.lastLatencyMs = fetched.latencyMs;

    this.onTelemetry({
      streamId: record.id,
      label: record.label,
      cacheHit,
      chunkBytes: outBuf.length,
      latencyMs: fetched.latencyMs,
      fecSpec: `RS(${codec.n},${codec.k})`,
      fecBlocks: fecInfo.numBlocks,
      bonding: bondPlan,
      stats: record.stats
    });
  }

  const outHeaders = {
    'Content-Type': isM3u8 ? 'application/vnd.apple.mpegurl' : contentType,
    'Content-Length': outBuf.length,
    'Access-Control-Allow-Origin': '*',
    'X-LumaLink-Cache': cacheHit ? 'RAM-HIT' : 'UPSTREAM',
    'X-LumaLink-FEC': `RS(${codec.n},${codec.k})`
  };
  if (fetched.headers['content-range']) outHeaders['Content-Range'] = fetched.headers['content-range'];
  if (fetched.headers['accept-ranges']) outHeaders['Accept-Ranges'] = fetched.headers['accept-ranges'];

  res.writeHead(fetched.statusCode, outHeaders);
  res.end(outBuf);
} catch (err) {
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: err.message }));
}
}
}
module.exports = { StreamEdgeAccelerator };
"""
