const test = require('node:test');
const assert = require('node:assert/strict');
const validation = require('../lib/validation');

test('accepts valid product IDs and normalizes case', () => {
  assert.equal(validation.normalizeProductId('  abc-123 '), 'ABC-123');
  assert.equal(validation.isValidProductId('ABC_123'), true);
  assert.equal(validation.isValidProductId('a product'), false);
  assert.equal(validation.isValidProductId(''), false);
});

test('accepts only six digit pincodes', () => {
  assert.equal(validation.isValidPincode('560001'), true);
  assert.equal(validation.isValidPincode('56001'), false);
  assert.equal(validation.isValidPincode('56000A'), false);
});

test('deduplicates products and pincodes', () => {
  assert.deepEqual(validation.uniqueProductIds('abc-1 ABC-1 bad value'), ['ABC-1']);
  assert.deepEqual(validation.uniquePincodes('560001 560001, 110001'), ['560001', '110001']);
});
