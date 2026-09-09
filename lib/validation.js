(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlipkartValidation = factory();
})(typeof self === 'undefined' ? globalThis : self, () => {
  const PRODUCT_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;
  const PINCODE_PATTERN = /^\d{6}$/;

  function normalizeProductId(value) {
    return String(value || '').trim().toUpperCase();
  }

  function isValidProductId(value) {
    return PRODUCT_PATTERN.test(normalizeProductId(value));
  }

  function normalizePincode(value) {
    return String(value || '').trim();
  }

  function isValidPincode(value) {
    return PINCODE_PATTERN.test(normalizePincode(value));
  }

  function uniqueProductIds(value) {
    const values = Array.isArray(value)
      ? value
      : String(value || '').split(/[\s,;]+/);
    return [...new Set(values.map(normalizeProductId).filter(isValidProductId))];
  }

  function uniquePincodes(value) {
    const values = Array.isArray(value)
      ? value
      : String(value || '').split(/[\s,;]+/);
    return [...new Set(values.map(normalizePincode).filter(isValidPincode))];
  }

  return {
    PRODUCT_PATTERN,
    PINCODE_PATTERN,
    normalizeProductId,
    isValidProductId,
    normalizePincode,
    isValidPincode,
    uniqueProductIds,
    uniquePincodes
  };
});
