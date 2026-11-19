files["scripts/provision_wifi.js"] = """/
@file scripts/provision_wifi.js
@description CLI Wi-Fi Adapter Auto-Provisioner & Configuration Generator
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { discoverWifiInterfaces } = require('../server/wifi_discovery');
const ifaces = discoverWifiInterfaces();
const primary = ifaces.length > 0 ? ifaces[0] : { interface: 'loopback', ip: '127.0.0.1' };
const configPath = path.join(__dirname, '..', 'server', 'lumalink.config.json');
const config = {
wifiSsid: process.env.WIFI_SSID || 'LOCAL_WIFI_LAN',
hostIp: process.env.HOST_IP || primary.ip,
httpPort: parseInt(process.env.PORT || '8080', 10),
distanceMeters: 25,
longevityMode: 'balanced',
bokehDefocus: true,
symbolRateHz: 32400,
mimoGrid: 4
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('LumaLink Wi-Fi Provisioning Complete:');
console.log(  Interface : ${primary.interface});
console.log(  Host URL  : http://${config.hostIp}:${config.httpPort});
console.log(  Saved To  : ${configPath});
"""
