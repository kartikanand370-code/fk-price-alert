const { findDevice } = require('../lib/access');

function reply(res, status, body) { return res.status(status).json(body); }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return reply(res, 405, { error: 'Use POST.' });
  const deviceId = String(req.body?.deviceId || '').trim();
  if (!deviceId || deviceId.length > 200) {
    return reply(res, 400, { error: 'A valid device ID is required.' });
  }
  const device = findDevice(deviceId);
  return reply(res, 200, {
    app: 'Flipkart Stock Signal',
    allowed: Boolean(device),
    deviceId,
    name: typeof device === 'object' ? (device.name || '') : ''
  });
};
