const test = require('node:test');
const assert = require('node:assert/strict');
const bot = require('../telegram-bot');

test('extracts products from PID, LID, and Flipkart links', () => {
  assert.equal(bot.parseProductInput('PID: abc-123'), 'ABC-123');
  assert.equal(bot.parseProductInput('LID=lid_456'), 'LID_456');
  assert.equal(bot.parseProductInput('https://www.flipkart.com/item/p/itm123?pid=mob-789'), 'MOB-789');
  assert.equal(bot.parseProductInput('not a product link'), null);
});

test('parses bot commands without exposing credentials', () => {
  assert.deepEqual(bot.parseCommand('/interval 5'), { name: 'interval', args: '5' });
  assert.deepEqual(bot.parseCommand('/start@stock_signal_bot'), { name: 'start', args: '' });
  assert.equal(bot.parseCommand('hello'), null);
});

test('aggregates stock, price, location, and bank-offer data per product', () => {
  const rows = bot._test.aggregateResults([{
    key: 'MOB-789',
    name: 'Sample phone',
    price: 24999,
    currency: 'INR',
    pincode: '560001',
    available: true,
    locations: ['Bengaluru'],
    bankOfferCheck: true,
    bankOffers: ['Bank discount'],
    productError: '',
    inventoryError: '',
    bankOfferError: ''
  }], new Map());
  assert.equal(rows[0].price, 24999);
  assert.deepEqual(rows[0].pincodes, ['560001']);
  assert.deepEqual(rows[0].locations, ['Bengaluru']);
  assert.deepEqual(rows[0].bankOffers, ['Bank discount']);
  assert.equal(rows[0].bankOfferInitialized, true);
});
