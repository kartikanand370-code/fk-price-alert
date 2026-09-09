const test = require('node:test');
const assert = require('node:assert/strict');
const access = require('../lib/access');

test('allows and denies device IDs from the private environment allowlist', () => {
  process.env.FLIPKART_APPROVED_DEVICE_IDS = 'approved-device, another-device';
  assert.equal(access.isAllowed('approved-device'), true);
  assert.equal(access.isAllowed('unknown-device'), false);
  delete process.env.FLIPKART_APPROVED_DEVICE_IDS;
});
