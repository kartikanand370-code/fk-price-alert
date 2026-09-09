const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

process.env.FLIPKART_API_MODE = 'demo';
process.env.FLIPKART_APPROVED_DEVICE_IDS = 'test-device';
const handler = require('../api/stock');

function responseCapture() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; }
  };
}

test('normalizes authorized inventory response fields', () => {
  assert.deepEqual(handler._test.normalizeInventory({ inStock: true, locations: [{ name: 'Bengaluru store' }] }), {
    available: true,
    locations: ['Bengaluru store']
  });
  assert.equal(handler._test.validateJob({ productId: 'ABC-1', pincode: '560001' }), true);
  assert.equal(handler._test.validateJob({ productId: 'ABC 1', pincode: '560001' }), false);
});

test('keeps only explicitly returned bank offers', () => {
  assert.deepEqual(handler._test.normalizeBankOffers({
    bankOffers: [{ title: 'Bank A cashback' }],
    offers: [{ title: 'Generic promotion' }, { title: 'Bank B discount', type: 'BANK' }]
  }), {
    bankOfferDetected: true,
    bankOffers: ['Bank A cashback', 'Bank B discount']
  });
});

test('demo mode is explicit and clearly labelled', async () => {
  const response = responseCapture();
  await handler({
    method: 'POST',
    body: {
      deviceId: 'test-device',
      jobs: [{ productId: 'ABC-1', pincode: '560001', bankOfferCheck: true }]
    }
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.mode, 'demo');
  assert.match(response.body.message, /sample results/i);
  assert.equal(response.body.results[0].productId, 'ABC-1');
  assert.equal(response.body.results[0].bankOfferCheck, true);
});

test('rejects invalid product and pincode values', async () => {
  const response = responseCapture();
  await handler({
    method: 'POST',
    body: { deviceId: 'test-device', jobs: [{ productId: 'bad value', pincode: '123' }] }
  }, response);
  assert.equal(response.statusCode, 400);
});

test('returns a clear API-not-configured response', () => {
  const script = `
    const handler = require('./api/stock');
    const res = { code: 200, setHeader() {}, status(value) { this.code = value; return this; }, json(body) { process.stdout.write(JSON.stringify({ code: this.code, body })); return this; }, end() {} };
    Promise.resolve(handler({ method: 'POST', body: { deviceId: 'test-device', jobs: [{ productId: 'ABC-1', pincode: '560001' }] } }, res));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, FLIPKART_API_MODE: '', FLIPKART_API_BASE_URL: '', FLIPKART_APPROVED_DEVICE_IDS: 'test-device' }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.code, 503);
  assert.equal(output.body.code, 'API_NOT_CONFIGURED');
});
