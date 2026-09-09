const {
  isValidProductId,
  isValidPincode,
  normalizeProductId,
  normalizePincode
} = require('../lib/validation');
const { isAllowed } = require('../lib/access');

/*
 * Configure an authorized Flipkart inventory service here through environment
 * variables. The service should expose the three documented contracts below:
 *   POST FLIPKART_INVENTORY_PATH { productId, sku, pincode, category }
 *   GET  FLIPKART_PRODUCT_PATH/:productId
 *   GET  FLIPKART_BANK_OFFERS_PATH/:productId
 * Do not point these paths at an unofficial storefront endpoint or bypass its
 * authentication, CAPTCHA, rate limits, or other security controls.
 */
const API_BASE_URL = String(process.env.FLIPKART_API_BASE_URL || '').trim();
const API_TOKEN = String(process.env.FLIPKART_API_TOKEN || '').trim();
const API_MODE = String(process.env.FLIPKART_API_MODE || '').trim().toLowerCase();
const INVENTORY_PATH = process.env.FLIPKART_INVENTORY_PATH || '/inventory/check';
const PRODUCT_PATH = process.env.FLIPKART_PRODUCT_PATH || '/products/:productId';
const BANK_OFFERS_PATH = process.env.FLIPKART_BANK_OFFERS_PATH || '/offers/:productId';
const REQUEST_TIMEOUT_MS = clampNumber(process.env.FLIPKART_API_TIMEOUT_MS, 1000, 30000, 8000);
const RETRIES = clampNumber(process.env.FLIPKART_API_RETRIES, 0, 3, 2);
const CONCURRENCY = clampNumber(process.env.FLIPKART_API_CONCURRENCY, 1, 8, 4);
const MIN_REQUEST_INTERVAL_MS = clampNumber(process.env.FLIPKART_API_MIN_INTERVAL_MS, 0, 5000, 100);

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

const list = value => Array.isArray(value) ? value : (value == null ? [] : [value]);
const text = (value, fallback = '') => String(value ?? fallback).replace(/\s+/g, ' ').trim().slice(0, 300);
const reply = (res, status, body) => res.status(status).json(body);

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function mapWithConcurrency(values, limit, worker) {
  const results = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  });
  return Promise.all(workers).then(() => results);
}

let nextRequestAt = 0;
async function waitForRateLimit() {
  const now = Date.now();
  const wait = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + MIN_REQUEST_INTERVAL_MS;
  if (wait) await sleep(wait);
}

class UpstreamError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

function retryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter)) return Math.min(3000, Math.max(0, retryAfter * 1000));
  return Math.min(3000, 150 * (2 ** attempt) + Math.floor(Math.random() * 100));
}

async function fetchJson(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      await waitForRateLimit();
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
          ...(options.headers || {})
        }
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return data;
      const error = new UpstreamError(`Flipkart service returned HTTP ${response.status}.`, response.status);
      if (!retryableStatus(response.status) || attempt >= RETRIES) throw error;
      lastError = error;
      await sleep(retryDelay(response, attempt));
    } catch (error) {
      lastError = error.name === 'AbortError'
        ? new UpstreamError(`Flipkart service timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`)
        : error;
      const retryable = !(lastError instanceof UpstreamError) || retryableStatus(lastError.status);
      if (!retryable || attempt >= RETRIES) throw lastError;
      await sleep(150 * (2 ** attempt) + Math.floor(Math.random() * 100));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new UpstreamError('Flipkart service request failed.');
}

function configuredMode() {
  if (API_MODE === 'demo') return 'demo';
  if (API_MODE && API_MODE !== 'live') return 'invalid';
  return API_BASE_URL ? 'live' : 'unconfigured';
}

function serviceUrl(pathTemplate, productId) {
  const path = String(pathTemplate).replace(/:productId|\{productId\}/g, encodeURIComponent(productId));
  return new URL(path.replace(/^\//, ''), `${API_BASE_URL.replace(/\/$/, '')}/`).toString();
}

function errorMessage(error, category) {
  if (error instanceof UpstreamError) return `${category} unavailable: ${error.message}`;
  return `${category} unavailable: The authorized service could not be reached.`;
}

function booleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  const normalized = String(value || '').trim().toLowerCase();
  if (['true', 'yes', 'available', 'in_stock', 'instock', 'in stock'].includes(normalized)) return true;
  if (['false', 'no', 'unavailable', 'out_of_stock', 'outofstock', 'out of stock'].includes(normalized)) return false;
  return null;
}

function locationText(value) {
  if (typeof value === 'string' || typeof value === 'number') return text(value);
  return text(value?.name || value?.label || value?.storeName || value?.address || '');
}

function normalizeInventory(data) {
  const candidates = [
    data?.available,
    data?.inStock,
    data?.isAvailable,
    data?.availability,
    data?.stock?.available,
    data?.inventory?.available,
    data?.fulfillment?.available
  ];
  let available = candidates.map(booleanValue).find(value => value !== null);
  if (available == null) available = Number(data?.quantity) > 0;
  const locations = list(data?.availableLocations || data?.locations || data?.stores || data?.fulfillmentLocations)
    .map(locationText)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 20);
  return { available: Boolean(available), locations };
}

function normalizeProduct(data, productId) {
  const product = data?.product || data?.item || data;
  const price = [
    product?.buyingPrice,
    product?.buyPrice,
    product?.sellingPrice,
    product?.salePrice,
    product?.currentPrice,
    product?.finalPrice,
    product?.price,
    product?.price?.sellingPrice,
    product?.price?.current,
    product?.price?.value,
    product?.price?.amount,
    product?.pricing?.sellingPrice,
    product?.pricing?.currentPrice
  ].map(priceValue).find(value => value !== null);
  return {
    name: text(product?.name || product?.productName || product?.title, `Product ${productId}`),
    brand: text(product?.brand?.name || product?.brand || ''),
    category: text(product?.category?.name || product?.category || ''),
    price,
    currency: text(product?.currency || product?.price?.currency || product?.pricing?.currency || 'INR')
  };
}

function priceValue(value) {
  if (value && typeof value === 'object') return priceValue(value.amount ?? value.value);
  if (typeof value === 'string') value = value.replace(/[^\d.\-]/g, '');
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function bankOfferText(offer) {
  if (typeof offer === 'string' || typeof offer === 'number') return text(offer);
  return text(offer?.title || offer?.name || offer?.label || offer?.description || offer?.offerText || '');
}

function explicitlyBankOffer(offer) {
  if (offer?.isBankOffer === true || offer?.is_bank_offer === true) return true;
  const type = String(offer?.type || offer?.offerType || offer?.category || '').trim().toUpperCase();
  return ['BANK', 'BANK_OFFER', 'BANK OFFER'].includes(type);
}

function normalizeBankOffers(data) {
  const direct = [
    ...list(data?.bankOffers),
    ...list(data?.bank_offers),
    ...list(data?.data?.bankOffers),
    ...list(data?.data?.bank_offers)
  ];
  const typed = list(data?.offers || data?.items || data?.data?.offers)
    .filter(explicitlyBankOffer);
  const bankOffers = [...direct, ...typed]
    .map(bankOfferText)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 10);
  return { bankOfferDetected: bankOffers.length > 0, bankOffers };
}

async function liveProductInfo(productId) {
  try {
    const data = await fetchJson(serviceUrl(PRODUCT_PATH, productId));
    return { ...normalizeProduct(data, productId), productError: '' };
  } catch (error) {
    return { ...normalizeProduct({}, productId), productError: errorMessage(error, 'Product lookup') };
  }
}

async function liveBankOffers(productId) {
  try {
    const data = await fetchJson(serviceUrl(BANK_OFFERS_PATH, productId));
    return { ...normalizeBankOffers(data), bankOfferError: '' };
  } catch (error) {
    return { bankOfferDetected: false, bankOffers: [], bankOfferError: errorMessage(error, 'Bank offer lookup') };
  }
}

async function liveInventory(job) {
  try {
    const data = await fetchJson(serviceUrl(INVENTORY_PATH, job.productId), {
      method: 'POST',
      body: JSON.stringify({
        productId: job.productId,
        sku: job.productId,
        pincode: job.pincode,
        category: job.category
      })
    });
    return { ...normalizeInventory(data), inventoryError: '' };
  } catch (error) {
    return { available: false, locations: [], inventoryError: errorMessage(error, 'Inventory lookup') };
  }
}

function demoProductInfo(productId) {
  return {
    name: `Demo product ${productId}`,
    brand: 'Demo catalog',
    category: 'Sample data',
    price: 999 + [...productId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 20 * 100,
    currency: 'INR',
    productError: ''
  };
}

function demoBankOffers(productId) {
  const hasBankOffer = /[57]$/.test(productId);
  return {
    bankOfferDetected: hasBankOffer,
    bankOffers: hasBankOffer ? ['Demo bank offer returned by the sample adapter'] : [],
    bankOfferError: ''
  };
}

function demoInventory(job) {
  const available = /[02468]$/.test(`${job.productId}${job.pincode}`);
  return {
    available,
    locations: available ? [`Demo fulfilment for ${job.pincode}`] : [],
    inventoryError: ''
  };
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return reply(res, 405, { error: 'Use POST.' });

  const deviceId = String(req.body?.deviceId || '').trim();
  if (!isAllowed(deviceId)) return reply(res, 403, { error: 'This device is not approved for Flipkart Stock Signal.' });

  const mode = configuredMode();
  if (mode === 'unconfigured') {
    return reply(res, 503, {
      code: 'API_NOT_CONFIGURED',
      error: 'Flipkart stock checking is not configured. Set FLIPKART_API_BASE_URL for an authorized service, or FLIPKART_API_MODE=demo for clearly labelled sample data.'
    });
  }
  if (mode === 'invalid') {
    return reply(res, 500, { code: 'INVALID_API_MODE', error: 'FLIPKART_API_MODE must be live or demo.' });
  }

  const incomingJobs = Array.isArray(req.body?.jobs) ? req.body.jobs : [];
  if (!incomingJobs.length || incomingJobs.length > 50) {
    return reply(res, 400, { error: 'Send 1 to 50 product and pincode checks per request.' });
  }

  const category = String(req.body?.category || 'general').trim().slice(0, 40) || 'general';
  const jobs = incomingJobs.map(job => ({
    productId: normalizeProductId(job?.productId),
    pincode: normalizePincode(job?.pincode),
    category,
    bankOfferCheck: job?.bankOfferCheck === true
  }));

  if (!jobs.every(job => isValidProductId(job.productId) && isValidPincode(job.pincode))) {
    return reply(res, 400, { error: 'Every product ID/SKU must use letters, digits, hyphens or underscores, and every pincode must contain six digits.' });
  }

  return reply(res, 200, await checkStockJobs({ jobs, category }));
}

async function checkStockJobs({ jobs, category = 'general' }) {
  const mode = configuredMode();
  if (mode === 'unconfigured') {
    const error = new Error('Flipkart stock checking is not configured. Set FLIPKART_API_BASE_URL for an authorized service, or FLIPKART_API_MODE=demo for clearly labelled sample data.');
    error.code = 'API_NOT_CONFIGURED';
    throw error;
  }
  if (mode === 'invalid') {
    const error = new Error('FLIPKART_API_MODE must be live or demo.');
    error.code = 'INVALID_API_MODE';
    throw error;
  }

  const ids = [...new Set(jobs.map(job => job.productId))];
  const productInfo = new Map(await mapWithConcurrency(ids, CONCURRENCY, async productId => [
    productId,
    mode === 'demo' ? demoProductInfo(productId) : await liveProductInfo(productId)
  ]));
  const bankOfferIds = ids.filter(id => jobs.some(job => job.productId === id && job.bankOfferCheck));
  const bankOfferInfo = new Map(await mapWithConcurrency(bankOfferIds, CONCURRENCY, async productId => [
    productId,
    mode === 'demo' ? demoBankOffers(productId) : await liveBankOffers(productId)
  ]));
  const inventoryResults = await mapWithConcurrency(jobs, CONCURRENCY, async job => [
    job,
    mode === 'demo' ? demoInventory(job) : await liveInventory(job)
  ]);

  const results = inventoryResults.map(([job, inventory]) => {
    const product = productInfo.get(job.productId) || demoProductInfo(job.productId);
    const bankOffers = bankOfferInfo.get(job.productId) || { bankOfferDetected: false, bankOffers: [], bankOfferError: '' };
    return {
      key: job.productId,
      productId: job.productId,
      pincode: job.pincode,
      name: product.name,
      brand: product.brand,
      category: product.category,
      price: product.price,
      currency: product.currency,
      available: inventory.available,
      locations: inventory.locations,
      bankOfferCheck: job.bankOfferCheck,
      bankOfferDetected: job.bankOfferCheck && bankOffers.bankOfferDetected,
      bankOffers: job.bankOfferCheck ? bankOffers.bankOffers : [],
      productError: product.productError,
      inventoryError: inventory.inventoryError,
      bankOfferError: job.bankOfferCheck ? bankOffers.bankOfferError : ''
    };
  });

  return {
    mode,
    message: mode === 'demo' ? 'Demo mode: these are sample results, not live Flipkart stock.' : 'Live mode: results came from the configured authorized service.',
    results
  };
}

module.exports = handler;
module.exports.checkStockJobs = checkStockJobs;
module.exports._test = {
  configuredMode,
  normalizeInventory,
  normalizeBankOffers,
  normalizeProduct,
  retryableStatus,
  validateJob: job => isValidProductId(job?.productId) && isValidPincode(job?.pincode)
};
