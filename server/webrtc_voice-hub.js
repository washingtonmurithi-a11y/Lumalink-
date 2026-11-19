files["server/webrtc_voice_hub.js"] = """/
@file server/webrtc_voice_hub.js
@description Full-Duplex LAN/WAN WebRTC Voice & Media Signaling Broker
*/
'use strict';
class WebRtcVoiceBroker {
constructor(wsHub) {
this.wsHub = wsHub;
this.activeSessions = new Map();
}
routeSignaling(senderClient, msg) {
const { type, targetId } = msg;
if (!targetId) return false;
if (type === 'CALL_OFFER') {
  this.activeSessions.set(`${senderClient.id}:${targetId}`, {
    caller: senderClient.id,
    callee: targetId,
    startedAt: Date.now()
  });
} else if (type === 'CALL_HANGUP') {
  this.activeSessions.delete(`${senderClient.id}:${targetId}`);
  this.activeSessions.delete(`${targetId}:${senderClient.id}`);
}

this.wsHub.sendTo(targetId, {
  ...msg,
  fromId: senderClient.id,
  fromName: senderClient.name,
  fromDeviceType: senderClient.deviceType
});
return true;
}
getActiveCallCount() {
return this.activeSessions.size;
}
}
module.exports = { WebRtcVoiceBroker };
"""
