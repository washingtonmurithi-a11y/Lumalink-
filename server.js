files["server/ws_rfc6455.js"] = """/
@file server/ws_rfc6455.js
@description Zero-Dependency RFC 6455 WebSocket Protocol Engine
*/
'use strict';
const crypto = require('crypto');
const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class WebSocketHub {
constructor(onMessageCallback, onTopologyChangeCallback) {
this.clients = new Map();
this.onMessage = onMessageCallback;
this.onTopologyChange = onTopologyChangeCallback || (() => {});
}
encodeFrame(textPayload) {
const payload = Buffer.from(textPayload, 'utf8');
const len = payload.length;
let header;
if (len < 126) {
header = Buffer.from([0x81, len]);
} else if (len < 65536) {
header = Buffer.alloc(4);
header[0] = 0x81;
header[1] = 126;
header.writeUInt16BE(len, 2);
} else {
header = Buffer.alloc(10);
header[0] = 0x81;
header[1] = 127;
header.writeBigUInt64BE(BigInt(len), 2);
}
return Buffer.concat([header, payload]);
}
sendTo(clientId, obj) {
const client = this.clients.get(clientId);
if (client && !client.socket.destroyed) {
client.socket.write(this.encodeFrame(JSON.stringify(obj)));
}
}
broadcast(obj, excludeId = null) {
const frame = this.encodeFrame(JSON.stringify(obj));
for (const [id, client] of this.clients.entries()) {
if (id !== excludeId && !client.socket.destroyed) {
client.socket.write(frame);
}
}
}
getPeersList() {
return Array.from(this.clients.values()).map((c) => ({
id: c.id,
name: c.name,
deviceType: c.deviceType,
ip: c.ip,
connectedAt: c.connectedAt
}));
}
handleUpgrade(req, socket, initialPayloadBuilder) {
const secKey = req.headers['sec-websocket-key'];
if (!secKey) {
socket.destroy();
return;
}
const acceptKey = crypto
  .createHash('sha1')
  .update(secKey + WS_MAGIC_GUID)
  .digest('base64');

socket.write(
  'HTTP/1.1 101 Switching Protocols\\r\\n' +
  'Upgrade: websocket\\r\\n' +
  'Connection: Upgrade\\r\\n' +
  `Sec-WebSocket-Accept: ${acceptKey}\\r\\n\\r\\n`
);

const id = crypto.randomBytes(6).toString('hex');
const ua = String(req.headers['user-agent'] || '');
const isMobile = /android|iphone|ipad|mobile/i.test(ua);

const client = {
  id,
  socket,
  ip: socket.remoteAddress,
  deviceType: isMobile ? 'PHONE_MOBILE' : 'WORKSTATION_PC',
  name: `${isMobile ? 'Phone' : 'Terminal'}-${id.slice(0, 4)}`,
  connectedAt: Date.now()
};

this.clients.set(id, client);

if (typeof initialPayloadBuilder === 'function') {
  this.sendTo(id, initialPayloadBuilder(client));
}
this.onTopologyChange(this.getPeersList());

let rxBuffer = Buffer.alloc(0);
socket.on('data', (chunk) => {
  rxBuffer = Buffer.concat([rxBuffer, chunk]);
  while (rxBuffer.length >= 2) {
    const opcode = rxBuffer[0] & 0x0F;
    const isMasked = (rxBuffer[1] & 0x80) !== 0;
    let len = rxBuffer[1] & 0x7F;
    let offset = 2;

    if (len === 126) {
      if (rxBuffer.length < 4) return;
      len = rxBuffer.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (rxBuffer.length < 10) return;
      len = Number(rxBuffer.readBigUInt64BE(2));
      offset = 10;
    }

    const maskLen = isMasked ? 4 : 0;
    if (rxBuffer.length < offset + maskLen + len) return;

    const payload = Buffer.alloc(len);
    if (isMasked) {
      const mask = rxBuffer.slice(offset, offset + 4);
      const data = rxBuffer.slice(offset + 4, offset + 4 + len);
      for (let i = 0; i < len; i++) {
        payload[i] = data[i] ^ mask[i % 4];
      }
    } else {
      rxBuffer.copy(payload, 0, offset, offset + len);
    }

    rxBuffer = rxBuffer.slice(offset + maskLen + len);

    if (opcode === 0x8) {
      socket.end();
      return;
    } else if (opcode === 0x9) {
      socket.write(Buffer.from([0x8A, 0x00]));
    } else if (opcode === 0x1) {
      try {
        const parsed = JSON.parse(payload.toString('utf8'));
        this.onMessage(client, parsed);
      } catch {
        // Ignore malformed JSON frames
      }
    }
  }
});

const cleanup = () => {
  if (this.clients.delete(id)) {
    this.onTopologyChange(this.getPeersList());
  }
};
socket.on('close', cleanup);
socket.on('error', cleanup);
}
}
module.exports = { WebSocketHub };
"""
