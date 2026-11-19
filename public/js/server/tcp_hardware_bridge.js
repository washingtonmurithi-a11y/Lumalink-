files["server/tcp_hardware_bridge.js"] = """/
@file server/tcp_hardware_bridge.js
@description Raw TCP Socket Bridge (:9090) for ESP32-S3 8-CSK RGB LED Optical Transmitters
*/
'use strict';
const net = require('net');
class HardwareTcpBridge {
constructor(port = 9090, onNodeCountChange) {
this.port = port;
this.onNodeCountChange = onNodeCountChange || (() => {});
this.nodes = new Set();
this.server = net.createServer((socket) => {
this.nodes.add(socket);
this.onNodeCountChange(this.nodes.size);
  const cleanup = () => {
    if (this.nodes.delete(socket)) {
      this.onNodeCountChange(this.nodes.size);
    }
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});
}
listen() {
this.server.listen(this.port, '0.0.0.0');
}
pushOpticalPayload(utf8Text) {
const buf = Buffer.from(String(utf8Text), 'utf8');
let count = 0;
for (const sock of this.nodes) {
if (!sock.destroyed) {
sock.write(buf);
count++;
}
}
return count;
}
}
module.exports = { HardwareTcpBridge };
"""
