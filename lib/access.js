const fs = require('fs');
const path = require('path');

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function readStore() {
  const locations = [
    path.join(process.cwd(), 'private', 'licenses.json'),
    path.join(__dirname, '..', 'private', 'licenses.json')
  ];
  for (const location of locations) {
    try {
      const parsed = JSON.parse(fs.readFileSync(location, 'utf8'));
      return Array.isArray(parsed) ? { devices: parsed } : parsed;
    } catch {}
  }
  return { devices: [] };
}

function entries() {
  const devices = readStore().devices;
  const fileDevices = Array.isArray(devices) ? devices : [];
  const environmentDevices = String(process.env.FLIPKART_APPROVED_DEVICE_IDS || '')
    .split(/[\s,;]+/)
    .map(value => value.trim())
    .filter(Boolean);
  return [...fileDevices, ...environmentDevices];
}

function findDevice(deviceId) {
  const wanted = normalize(deviceId);
  if (!wanted) return null;
  return entries().find(entry => {
    const id = typeof entry === 'string' ? entry : entry?.id;
    const active = typeof entry === 'string' || entry?.active !== false;
    return active && normalize(id) === wanted;
  }) || null;
}

function isAllowed(deviceId) {
  return Boolean(findDevice(deviceId));
}

module.exports = { findDevice, isAllowed };
