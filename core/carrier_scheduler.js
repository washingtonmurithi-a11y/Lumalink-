files["core/carrier_scheduler.js"] = """/
@file core/carrier_scheduler.js
@description Universal Multi-Carrier Bonding & Weighted Deficit Round-Robin (WDRR) Scheduler
Aggregates Wi-Fi 6E/7, 5G NR/LTE, Fiber WAN, IEEE 802.15.7a Optical PHY, LEO Satcom,
and Peer Mesh Relays to improve aggregate throughput, range, and jitter stability.
*/
(function (root, factory) {
if (typeof module === 'object' && module.exports) {
module.exports = factory();
} else {
root.CarrierScheduler = factory();
}
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const CARRIER_CATALOG = [
{
id: 'wifi_6e',
name: 'Wi-Fi 6/6E/7 Local Booster',
standard: 'IEEE 802.11ax/be',
enabled: true,
baseMbps: 340,
rttMs: 3.8,
jitterMs: 1.1,
rssiDbm: -52,
lossPct: 0.15
},
{
id: 'cell_5g',
name: '5G NR / LTE Carrier Uplink',
standard: '3GPP Rel-17 Sub-6',
enabled: true,
baseMbps: 210,
rttMs: 16.5,
jitterMs: 4.2,
rssiDbm: -74,
lossPct: 0.85
},
{
id: 'fiber_wan',
name: 'GPON Fiber / Gigabit Ethernet',
standard: 'IEEE 802.3 / ITU-T G.984',
enabled: true,
baseMbps: 500,
rttMs: 5.4,
jitterMs: 0.5,
rssiDbm: -14,
lossPct: 0.01
},
{
id: 'optical_8csk',
name: 'LumaLink 8-CSK Optical PHY',
standard: 'IEEE 802.15.7a OCC',
enabled: true,
baseMbps: 12.5,
rttMs: 1.2,
jitterMs: 0.25,
rssiDbm: -40,
lossPct: 0.0
},
{
id: 'mesh_relay',
name: 'Multi-Hop Phone/Node Mesh Relay',
standard: '802.11s / WebRTC DataChannel',
enabled: true,
baseMbps: 115,
rttMs: 8.2,
jitterMs: 1.9,
rssiDbm: -64,
lossPct: 0.4
},
{
id: 'satcom_leo',
name: 'LEO Satellite Backhaul',
standard: 'Ku/Ka Phased Array',
enabled: false,
baseMbps: 150,
rttMs: 32.0,
jitterMs: 7.5,
rssiDbm: -80,
lossPct: 1.4
}
];
class MultiCarrierBondingEngine {
constructor(initialCarriers = CARRIER_CATALOG) {
this.carriers = JSON.parse(JSON.stringify(initialCarriers));
}
patchCarrier(id, updates) {
  const item = this.carriers.find((c) => c.id === id);
  if (!item) return null;
  Object.assign(item, updates);
  return item;
}

computeBondingPlan(payloadBytes = 65536, distanceMeters = 20, longevityMode = 'balanced') {
  const active = this.carriers.filter((c) => c.enabled);
  const baselineSingleCarrierMbps = 65.0; // Unmanaged single congested Wi-Fi baseline
  const baselineSingleJitterMs = 14.8;
  const baselineMaxRangeMeters = 28.0;

  if (active.length === 0) {
    return {
      aggregateMbps: 0,
      effectiveJitterMs: 999,
      effectiveRangeMeters: 0,
      speedGainFactor: 0,
      rangeGainFactor: 0,
      jitterReductionPct: 0,
      batteryHoursEst: 48,
      recommendedRS: [32, 16],
      allocations: []
    };
  }

  const powerScale = longevityMode === 'eco' ? 0.72 : (longevityMode === 'max_boost' ? 1.18 : 1.0);
  const batteryHoursEst = longevityMode === 'eco' ? 52.0 : (longevityMode === 'max_boost' ? 14.5 : 26.0);

  const scored = active.map((c) => {
    const distAtten = c.id === 'wifi_6e'
      ? Math.max(0.18, Math.min(1.0, 32 / Math.max(1, distanceMeters)))
      : 1.0;
    const effectiveBw = c.baseMbps * distAtten * powerScale;
    const weight = effectiveBw / (1 + c.rttMs * 0.035 + c.lossPct * 0.45);
    return { carrier: c, effectiveBw, weight: Math.max(1, weight) };
  });

  const totalWeight = scored.reduce((acc, s) => acc + s.weight, 0);
  let remBytes = payloadBytes;

  const allocations = scored.map((s, idx) => {
    const ratio = s.weight / totalWeight;
    const assignedBytes = idx === scored.length - 1
      ? remBytes
      : Math.round(payloadBytes * ratio);
    remBytes = Math.max(0, remBytes - assignedBytes);
    return {
      id: s.carrier.id,
      name: s.carrier.name,
      standard: s.carrier.standard,
      effectiveMbps: +s.effectiveBw.toFixed(1),
      rttMs: s.carrier.rttMs,
      sharePct: +(ratio * 100).toFixed(1),
      assignedBytes
    };
  });

  const aggregateMbps = +scored.reduce((sum, s) => sum + s.effectiveBw, 0).toFixed(1);
  const lowestJitter = Math.min(...active.map((c) => c.jitterMs));
  const effectiveJitterMs = +(lowestJitter * (active.length > 1 ? 0.68 : 1.0)).toFixed(2);

  // Mesh relay + Bokeh optical + RS(32,16) extends usable range far past single router
  const hasMesh = active.some((c) => c.id === 'mesh_relay');
  const hasOptical = active.some((c) => c.id === 'optical_8csk');
  const effectiveRangeMeters = +(
    baselineMaxRangeMeters *
    powerScale *
    (hasMesh ? 2.45 : 1.15) *
    (hasOptical ? 1.45 : 1.0)
  ).toFixed(1);

  let recommendedRS = [32, 28];
  if (distanceMeters > 70) recommendedRS = [32, 16];
  else if (distanceMeters > 28) recommendedRS = [32, 24];

  return {
    aggregateMbps,
    effectiveJitterMs,
    effectiveRangeMeters,
    speedGainFactor: +(aggregateMbps / baselineSingleCarrierMbps).toFixed(2),
    rangeGainFactor: +(effectiveRangeMeters / baselineMaxRangeMeters).toFixed(2),
    jitterReductionPct: +Math.max(0, ((baselineSingleJitterMs - effectiveJitterMs) / baselineSingleJitterMs) * 100).toFixed(1),
    batteryHoursEst,
    recommendedRS,
    allocations
  };
}
allocations
  };
}
}
return { CARRIER_CATALOG, MultiCarrierBondingEngine };
}));
"""
