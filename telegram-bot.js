const http = require('node:http');
const { checkStockJobs } = require('./api/stock');
const { isValidProductId, isValidPincode, normalizeProductId, uniqueProductIds, uniquePincodes } = require('./lib/validation');
const { readState, writeState } = require('./lib/store');

const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const ADMIN_ID = String(process.env.TELEGRAM_ADMIN_ID || '').trim();
const MAX_PRODUCTS = 50;
const INTERVALS = [1, 2, 5, 10];
const HEARTBEAT_MS = Math.max(20000, Number(process.env.BOT_HEARTBEAT_MS) || 20000);
const PORT = Number(process.env.PORT) || 3000;
const loops = new Map();
const activeScans = new Set();

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function startHealthServer() {
  const server = http.createServer((request, response) => {
    if (request.url === '/' || request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, service: 'flipkart-stock-signal' }));
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  });
  server.listen(PORT, '0.0.0.0', () => console.log(`Health server listening on port ${PORT}.`));
  return server;
}

function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function telegramKeyboard(rows) {
  return { inline_keyboard: rows };
}

async function telegram(method, payload = {}) {
  if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram request failed (${response.status}).`);
  return data.result;
}

async function sendMessage(chatId, text, options = {}) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options
  });
}

async function sendLong(chatId, text, options = {}) {
  const chunks = [];
  let remaining = String(text);
  while (remaining.length > 3900) {
    const split = remaining.lastIndexOf('\n', 3900);
    const index = split > 1000 ? split : 3900;
    chunks.push(remaining.slice(0, index));
    remaining = remaining.slice(index).trimStart();
  }
  chunks.push(remaining);
  for (const chunk of chunks) await sendMessage(chatId, chunk, options);
}

function newUser(from, chatId) {
  return {
    id: String(from.id),
    chatId: String(chatId),
    username: from.username || '',
    firstName: from.first_name || '',
    approved: String(from.id) === ADMIN_ID,
    pending: false,
    products: [],
    scanProducts: null,
    addingProducts: false,
    pincodes: [],
    category: 'general',
    interval: 1,
    bankAlerts: false,
    bankAlertProducts: [],
    bankRunning: false,
    muted: false,
    running: false,
    stockRunning: false,
    results: [],
    lastMode: '',
    lastError: '',
    lastScanAt: ''
  };
}

function ensureUser(state, from, chatId) {
  const id = String(from.id);
  state.users ||= {};
  state.users[id] ||= newUser(from, chatId);
  const user = state.users[id];
  user.chatId = String(chatId);
  user.username = from.username || user.username || '';
  user.firstName = from.first_name || user.firstName || '';
  if (id === ADMIN_ID) user.approved = true;
  return user;
}

async function save(state) {
  await writeState(state);
}

function approved(user) {
  return user && (user.approved === true || user.id === ADMIN_ID);
}

function parseProductInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const queryMatch = raw.match(/(?:^|[?&\s])(pid|lid|sku|productid|fsn|id)=([A-Za-z0-9_-]{1,64})/i);
  if (queryMatch && isValidProductId(queryMatch[2])) return normalizeProductId(queryMatch[2]);
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      for (const name of ['pid', 'lid', 'sku', 'productId', 'fsn', 'id']) {
        const value = url.searchParams.get(name);
        if (value && isValidProductId(value)) return normalizeProductId(value);
      }
    } catch {}
    return null;
  }
  const withoutLabel = raw.replace(/^(pid|lid|sku|productid|fsn)\s*[:=]?\s*/i, '').trim();
  return isValidProductId(withoutLabel) ? normalizeProductId(withoutLabel) : null;
}

function parseCommand(text) {
  const match = String(text || '').trim().match(/^\/([a-z0-9_]+)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i);
  return match ? { name: match[1].toLowerCase(), args: (match[2] || '').trim() } : null;
}

function userPanel() {
  return telegramKeyboard([
    [{ text: 'Add product link / PID', callback_data: 'add_help' }, { text: 'Remove product', callback_data: 'remove_help' }],
    [{ text: 'Products', callback_data: 'show_products' }, { text: 'Pincodes', callback_data: 'show_pincodes' }],
    [{ text: 'Stock check', callback_data: 'scan_menu' }, { text: 'Bank offers check', callback_data: 'bank_menu' }],
    [{ text: 'Stop checking', callback_data: 'stop_menu' }],
    [{ text: 'Status', callback_data: 'status' }, { text: 'Clear results', callback_data: 'clear_results' }]
  ]);
}

function adminPanel(state) {
  const users = Object.values(state.users || {});
  const pending = users.filter(user => user.pending && !user.approved);
  const approvedUsers = users.filter(user => user.approved && user.id !== ADMIN_ID);
  const lines = [
    '<b>Admin control panel</b>',
    `Users: ${users.length} | Pending: ${pending.length} | Approved: ${approvedUsers.length}`
  ];
  const rows = [];
  pending.slice(0, 20).forEach(user => {
    lines.push(`\nPending: <code>${html(user.id)}</code> ${html(user.username || user.firstName || 'unknown')}`);
    rows.push([{ text: `Approve ${user.firstName || user.id}`, callback_data: `approve:${user.id}` }, { text: 'Reject', callback_data: `reject:${user.id}` }]);
  });
  approvedUsers.slice(0, 20).forEach(user => {
    rows.push([{ text: `Revoke ${user.firstName || user.id}`, callback_data: `revoke:${user.id}` }]);
  });
  return { text: lines.join('\n'), markup: telegramKeyboard(rows.length ? rows : [[{ text: 'No pending requests', callback_data: 'noop' }]]) };
}

async function requestAccess(state, user) {
  if (!ADMIN_ID) {
    await sendMessage(user.chatId, 'Admin access is not configured yet. Set TELEGRAM_ADMIN_ID first.');
    return;
  }
  const firstRequest = user.pending !== true;
  user.pending = true;
  await save(state);
  if (firstRequest) {
    await sendMessage(ADMIN_ID, `<b>Access request</b>\nUser: ${html(user.firstName || 'Unknown')}\nUsername: @${html(user.username || 'not set')}\nTelegram ID: <code>${html(user.id)}</code>`, {
      reply_markup: telegramKeyboard([[{ text: 'Approve', callback_data: `approve:${user.id}` }, { text: 'Reject', callback_data: `reject:${user.id}` }]])
    });
  }
  await sendMessage(user.chatId, 'Your access request is waiting for admin approval. You will receive a message after the decision.');
}

async function requireAccess(state, user) {
  if (approved(user)) return true;
  await requestAccess(state, user);
  return false;
}

function productList(user) {
  if (!user.products.length) return '<b>Products</b>\nNo products added.';
  const scanSet = new Set(selectedScanProducts(user));
  const bankSet = new Set(selectedBankAlertProducts(user));
  return `<b>Products (${user.products.length}/${MAX_PRODUCTS})</b>\n${user.products.map((product, index) => `${index + 1}. ${scanSet.has(product) ? '✅' : '⬜'} <code>${html(product)}</code> | bank ${bankSet.has(product) ? '✅' : '⬜'}`).join('\n')}`;
}

function productButtons(user) {
  return user.products.slice(0, 20).map(product => [{ text: `Remove ${product}`, callback_data: `rmprod:${product}` }]);
}

function addProductMarkup() {
  return telegramKeyboard([
    [{ text: 'Add another product', callback_data: 'add_more' }],
    [{ text: 'Done / show panel', callback_data: 'add_done' }]
  ]);
}

async function addProductAndAsk(state, user, product) {
  const alreadyAdded = user.products.includes(product);
  const canAdd = !alreadyAdded && user.products.length < MAX_PRODUCTS;
  if (canAdd) user.products = [...user.products, product];
  user.addingProducts = user.products.length < MAX_PRODUCTS;
  await save(state);
  const status = alreadyAdded ? 'Already added' : canAdd ? 'Product added' : 'Product limit reached';
  const markup = user.addingProducts ? addProductMarkup() : userPanel();
  return sendMessage(user.chatId, `${status}: <code>${html(product)}</code>\n\n${productList(user)}\n\nItne hi products hain ya aur add karne hain?`, { reply_markup: markup });
}

function selectedScanProducts(user) {
  const configured = Array.isArray(user.scanProducts) ? user.scanProducts : user.products;
  return uniqueProductIds(configured).filter(product => user.products.includes(product));
}

function selectedBankAlertProducts(user) {
  const configured = Array.isArray(user.bankAlertProducts)
    ? user.bankAlertProducts
    : (user.bankAlerts ? user.products : []);
  return uniqueProductIds(configured).filter(product => user.products.includes(product));
}

function selectionRows(user, kind) {
  const selected = new Set(kind === 'scan' ? selectedScanProducts(user) : selectedBankAlertProducts(user));
  const prefix = kind === 'scan' ? 'scanprod:' : 'bankprod:';
  const rows = [];
  for (let index = 0; index < user.products.length; index += 2) {
    rows.push(user.products.slice(index, index + 2).map((product, offset) => ({
      text: `${selected.has(product) ? '✅' : '⬜'} ${product}`,
      callback_data: `${prefix}${index + offset}`
    })));
  }
  rows.push([
    { text: '✅ Select all', callback_data: kind === 'scan' ? 'scan_all' : 'bank_all' },
    { text: '⬜ Clear all', callback_data: kind === 'scan' ? 'scan_none' : 'bank_none' }
  ]);
  rows.push([{ text: kind === 'scan' ? 'Start stock check' : 'Start bank offers check', callback_data: kind === 'scan' ? 'scan_start' : 'bank_start' }]);
  return rows;
}

function scanSelectionMessage(user) {
  const selected = selectedScanProducts(user);
  return `<b>Stock check</b>\nSelected: ${selected.length}/${user.products.length}\nTick/untick products below, then press Start stock check.`;
}

function bankSelectionMessage(user) {
  const selected = selectedBankAlertProducts(user);
  return `<b>Bank offers check</b>\nSelected: ${selected.length}/${user.products.length}\nFor selected products, current buy price and bank offers will be shown. Any price or bank-offer change will send an alert.`;
}

function scanSelectionMarkup(user) {
  return telegramKeyboard(selectionRows(user, 'scan'));
}

function bankSelectionMarkup(user) {
  return telegramKeyboard(selectionRows(user, 'bank'));
}

async function openScanMenu(user) {
  if (!user.products.length) return sendMessage(user.chatId, 'Add at least one product first with the Add product button or /add.');
  return sendMessage(user.chatId, scanSelectionMessage(user), { reply_markup: scanSelectionMarkup(user) });
}

async function openBankMenu(user) {
  if (!user.products.length) return sendMessage(user.chatId, 'Add at least one product first before choosing bank alerts.');
  return sendMessage(user.chatId, bankSelectionMessage(user), { reply_markup: bankSelectionMarkup(user) });
}

function selectedProductNames(user, kind) {
  const products = kind === 'stock' ? selectedScanProducts(user) : selectedBankAlertProducts(user);
  return products.length ? products.map(product => `<code>${html(product)}</code>`).join(', ') : 'None';
}

function stopMenuMarkup(user) {
  const rows = [];
  if (stockIsRunning(user)) rows.push([{ text: 'Stop stock products', callback_data: 'stop_mode:stock' }]);
  if (bankIsRunning(user)) rows.push([{ text: 'Stop bank-offer products', callback_data: 'stop_mode:bank' }]);
  if (stockIsRunning(user) || bankIsRunning(user)) rows.push([{ text: 'Stop everything', callback_data: 'stop_all' }]);
  if (!rows.length) rows.push([{ text: 'Nothing is running', callback_data: 'noop' }]);
  rows.push([{ text: 'Back to panel', callback_data: 'panel' }]);
  return telegramKeyboard(rows);
}

function stopProductMarkup(user, kind) {
  const products = kind === 'stock' ? selectedScanProducts(user) : selectedBankAlertProducts(user);
  const prefix = kind === 'stock' ? 'stopprod:stock:' : 'stopprod:bank:';
  const rows = products.map(product => [{ text: `Stop ${product}`, callback_data: `${prefix}${user.products.indexOf(product)}` }]);
  rows.push([{ text: `Stop all ${kind === 'stock' ? 'stock' : 'bank-offer'} products`, callback_data: `stopall:${kind}` }]);
  rows.push([{ text: 'Back to stop menu', callback_data: 'stop_menu' }]);
  return telegramKeyboard(rows);
}

async function openStopMenu(user) {
  return sendMessage(user.chatId, `<b>Stop checking</b>\nStock check: ${stockIsRunning(user) ? 'ON' : 'OFF'}\nBank offers check: ${bankIsRunning(user) ? 'ON' : 'OFF'}\nChoose what to stop.`, { reply_markup: stopMenuMarkup(user) });
}

async function openStopProductMenu(user, kind) {
  const products = kind === 'stock' ? selectedScanProducts(user) : selectedBankAlertProducts(user);
  if (!products.length) return openStopMenu(user);
  return sendMessage(user.chatId, `<b>Stop ${kind === 'stock' ? 'stock' : 'bank-offer'} checking</b>\nChoose the products to stop. Other selected products will continue.`, { reply_markup: stopProductMarkup(user, kind) });
}

function pincodeList(user) {
  return user.pincodes.length ? `<b>Pincodes (${user.pincodes.length})</b>\n${user.pincodes.map(pin => `<code>${html(pin)}</code>`).join(', ')}` : '<b>Pincodes</b>\nNo pincodes added.';
}

function pincodeButtons(user) {
  return user.pincodes.length
    ? user.pincodes.map(pin => [{ text: `Remove ${pin}`, callback_data: `rmpin:${pin}` }])
    : [[{ text: 'No pincodes added', callback_data: 'noop' }]];
}

function formatPrice(price, currency = 'INR') {
  if (price === null || price === undefined || !Number.isFinite(Number(price))) return 'Price unavailable';
  if (currency === 'INR') return `₹${Number(price).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  return `${currency} ${Number(price).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function formatResults(user) {
  if (!user.results?.length) return 'No scan results yet.';
  const lines = [`<b>Latest results</b>`, `Source: ${user.lastMode === 'demo' ? 'DEMO SAMPLE DATA, NOT LIVE STOCK' : 'authorized live service'}`];
  user.results.forEach(row => {
    lines.push(`\n<b>${html(row.name || row.key)}</b> <code>${html(row.key)}</code>`);
    lines.push(`Buy price: <b>${html(formatPrice(row.price, row.currency))}</b>`);
    lines.push(row.pincodes.length ? `Stock at: ${row.pincodes.map(html).join(', ')}` : 'No stock returned');
    if (row.locations.length) lines.push(`Locations: ${row.locations.map(html).join(', ')}`);
    if (row.bankOffers?.length) lines.push(`Bank offers: ${row.bankOffers.map(html).join(' | ')}`);
    row.errors.forEach(error => lines.push(`Error (${html(error.type)}): ${html(error.message)}`));
  });
  return lines.join('\n');
}

function aggregateResults(results, previousByKey) {
  const rows = new Map();
  results.forEach(result => {
    const row = rows.get(result.key) || {
      key: result.key,
      name: result.name || `Product ${result.key}`,
      price: previousByKey.get(result.key)?.price ?? null,
      currency: result.currency || previousByKey.get(result.key)?.currency || 'INR',
      pincodes: [],
      locations: [],
      bankOffers: previousByKey.get(result.key)?.bankOffers || [],
      bankOfferSignature: previousByKey.get(result.key)?.bankOfferSignature || '',
      bankOfferInitialized: previousByKey.get(result.key)?.bankOfferInitialized === true,
      bankOfferReady: false,
      errors: []
    };
    row.name = result.name || row.name;
    if (result.price !== null && result.price !== undefined) {
      row.price = Number(result.price);
      row.currency = result.currency || row.currency || 'INR';
    }
    if (result.available && !row.pincodes.includes(result.pincode)) row.pincodes.push(result.pincode);
    (result.locations || []).forEach(location => { if (!row.locations.includes(location)) row.locations.push(location); });
    if (result.productError) row.errors.push({ type: 'product', message: result.productError });
    if (result.inventoryError) row.errors.push({ type: `inventory ${result.pincode}`, message: result.inventoryError });
    if (result.bankOfferError) row.errors.push({ type: 'bank offer', message: result.bankOfferError });
    if (result.bankOfferCheck && !result.bankOfferError) {
      row.bankOffers = Array.isArray(result.bankOffers) ? result.bankOffers : [];
      row.bankOfferSignature = JSON.stringify([...row.bankOffers].sort());
      row.bankOfferInitialized = true;
      row.bankOfferReady = true;
    }
    rows.set(result.key, row);
  });
  return [...rows.values()];
}

function stockIsRunning(user) {
  return user.stockRunning === true || (user.stockRunning === undefined && user.running === true);
}

function bankIsRunning(user) {
  return user.bankRunning === true;
}

function syncRunning(user) {
  user.running = stockIsRunning(user) || bankIsRunning(user);
}

async function scanUser(userId, notifyErrors = false) {
  if (activeScans.has(userId)) return;
  activeScans.add(userId);
  try {
    const state = await readState();
    const user = state.users?.[userId];
    if (!user || !approved(user) || (!stockIsRunning(user) && !bankIsRunning(user))) return;
    const stockProducts = stockIsRunning(user) ? selectedScanProducts(user) : [];
    const bankProducts = bankIsRunning(user) ? selectedBankAlertProducts(user) : [];
    const monitoredProducts = uniqueProductIds([...stockProducts, ...bankProducts]);
    const bankAlertProducts = new Set(bankProducts);
    if (!monitoredProducts.length || !user.pincodes.length) {
      user.stockRunning = false;
      user.bankRunning = false;
      user.running = false;
      await save(state);
      await sendMessage(user.chatId, 'Add at least one product and one six-digit pincode before starting.');
      stopLoop(userId);
      return;
    }
    const stockProductsSet = new Set(stockProducts);
    const jobs = monitoredProducts.flatMap(productId => user.pincodes.map(pincode => ({
      productId,
      pincode,
      bankOfferCheck: bankAlertProducts.has(productId)
    })));
    const results = [];
    let mode = user.lastMode;
    let firstError = '';
    for (let index = 0; index < jobs.length; index += 50) {
      try {
        const response = await checkStockJobs({ jobs: jobs.slice(index, index + 50), category: user.category || 'general' });
        mode = response.mode;
        results.push(...response.results);
      } catch (error) {
        firstError ||= error.message;
        if (error.code === 'API_NOT_CONFIGURED' || error.code === 'INVALID_API_MODE') {
          user.stockRunning = false;
          user.bankRunning = false;
          user.running = false;
          stopLoop(userId);
          await save(state);
          await sendMessage(user.chatId, `Scan stopped: ${html(error.message)}`);
          return;
        }
      }
    }
    const previousByKey = new Map((user.results || []).map(row => [row.key, row]));
    const rowsByKey = new Map(aggregateResults(results, previousByKey).map(row => [row.key, row]));
    if (firstError) {
      for (const previous of previousByKey.values()) {
        const row = rowsByKey.get(previous.key) || {
          ...previous,
          pincodes: [...(previous.pincodes || [])],
          locations: [...(previous.locations || [])],
          bankOffers: [...(previous.bankOffers || [])],
          errors: [...(previous.errors || [])]
        };
        row.errors.push({ type: 'scan', message: firstError });
        rowsByKey.set(row.key, row);
      }
    }
    const rows = [...rowsByKey.values()];
    const alerts = [];
    rows.forEach(row => {
      const previous = previousByKey.get(row.key);
      if (stockProductsSet.has(row.key) && row.pincodes.length && !user.muted) alerts.push(`Stock available: ${row.name} at ${row.pincodes.join(', ')}. Press Stop stock to stop these alerts.`);
      if (bankIsRunning(user) && bankAlertProducts.has(row.key) && previous && previous.price !== null && previous.price !== undefined && row.price !== null && row.price !== undefined && Number(previous.price) !== Number(row.price) && !user.muted) {
        alerts.push(`Buy price changed: ${row.name}\nBefore: ${formatPrice(previous.price, previous.currency)}\nNow: ${formatPrice(row.price, row.currency)}`);
      }
      if (bankIsRunning(user) && bankAlertProducts.has(row.key) && row.bankOfferReady && row.bankOfferInitialized && previous?.bankOfferInitialized && previous.bankOfferSignature !== row.bankOfferSignature && !user.muted) {
        const before = previous.bankOffers?.length ? previous.bankOffers.join(' | ') : 'No bank offer';
        const now = row.bankOffers.length ? row.bankOffers.join(' | ') : 'No bank offer';
        alerts.push(`Bank offer changed: ${row.name}\nBefore: ${before}\nNow: ${now}`);
      }
    });
    user.results = rows;
    user.lastMode = mode || user.lastMode;
    user.lastError = firstError;
    user.lastScanAt = new Date().toISOString();
    await save(state);
    if (alerts.length) await sendLong(user.chatId, `<b>Flipkart Stock Signal</b>\n\n${alerts.map(html).join('\n\n')}`);
    if (notifyErrors && firstError) await sendMessage(user.chatId, `Temporary scan error. The bot will continue checking.\n${html(firstError)}`);
  } finally {
    activeScans.delete(userId);
  }
}

function startLoop(userId, intervalSeconds = 1) {
  if (loops.has(userId)) return;
  const run = async () => {
    const state = await readState();
    const user = state.users?.[userId];
    if (!user || (!stockIsRunning(user) && !bankIsRunning(user))) return stopLoop(userId);
    await scanUser(userId, true);
  };
  run().catch(() => {});
  const interval = setInterval(() => run().catch(() => {}), Math.max(1, Number(intervalSeconds) || 1) * 1000);
  loops.set(userId, interval);
}

function stopLoop(userId) {
  const interval = loops.get(userId);
  if (interval) clearInterval(interval);
  loops.delete(userId);
}

async function startStockScan(state, user) {
  if (!selectedScanProducts(user).length || !user.pincodes.length) {
    await sendMessage(user.chatId, 'Select at least one product and add one six-digit pincode first.', { reply_markup: userPanel() });
    return;
  }
  user.stockRunning = true;
  user.running = true;
  await save(state);
  startLoop(user.id, user.interval);
  await sendMessage(user.chatId, `Stock checking ${selectedScanProducts(user).length} selected product${selectedScanProducts(user).length === 1 ? '' : 's'} every ${user.interval} second${user.interval === 1 ? '' : 's'}.`, { reply_markup: userPanel() });
}

async function startBankScan(state, user) {
  if (!selectedBankAlertProducts(user).length || !user.pincodes.length) {
    await sendMessage(user.chatId, 'Select at least one bank-offer product and add one six-digit pincode first.', { reply_markup: userPanel() });
    return;
  }
  user.bankRunning = true;
  user.bankAlerts = true;
  user.running = true;
  await save(state);
  startLoop(user.id, user.interval);
  await sendMessage(user.chatId, `Bank offer and buy-price checking started for ${selectedBankAlertProducts(user).length} product${selectedBankAlertProducts(user).length === 1 ? '' : 's'}.`, { reply_markup: userPanel() });
}

async function stopStockScan(state, user) {
  user.stockRunning = false;
  syncRunning(user);
  await save(state);
  if (!user.running) stopLoop(user.id);
  await sendMessage(user.chatId, 'Stock checking stopped.');
}

async function stopBankScan(state, user) {
  user.bankRunning = false;
  syncRunning(user);
  await save(state);
  if (!user.running) stopLoop(user.id);
  await sendMessage(user.chatId, 'Bank offers and buy-price checking stopped.');
}

async function setRunning(state, user, running) {
  if (running) return startStockScan(state, user);
  return stopStockScan(state, user);
}

async function handleCommand(state, user, command) {
  const { name, args } = command;
  if (name === 'start') {
    if (!(await requireAccess(state, user))) return;
    await sendMessage(user.chatId, '<b>Flipkart Stock Signal</b>\nUse the control panel below. Product links, PIDs and pincodes can also be sent directly.', { reply_markup: userPanel() });
    return;
  }
  if (name === 'help') {
    await sendMessage(user.chatId, '<b>Commands</b>\n/add &lt;Flipkart link|PID|LID&gt; then choose Add another or Done\n/remove &lt;PID|LID|link&gt;\n/pin &lt;six digit pincode&gt;\n/rmpin &lt;pincode&gt;\n/scan opens the Stock check product checklist\n/stop stops stock checking\n/status, /results\n/interval &lt;1|2|5|10&gt;\n/bankalerts &lt;on|off&gt; selects all/none for Bank offers check\n/clear\n\nUse Bank offers check for a separate buy-price and bank-offer monitor.');
    return;
  }
  if (name === 'admin') {
    if (user.id !== ADMIN_ID) return sendMessage(user.chatId, 'Admin access only.');
    const panel = adminPanel(state);
    await sendMessage(user.chatId, panel.text, { reply_markup: panel.markup });
    return;
  }
  if (!(await requireAccess(state, user))) return;
  if (name === 'add') {
    if (!args) {
      user.addingProducts = true;
      await save(state);
      return sendMessage(user.chatId, 'Send a Flipkart product link or PID. After each product I will ask if you want to add another.');
    }
    const product = parseProductInput(args);
    if (!product) return sendMessage(user.chatId, 'Could not find a valid PID/SKU. Send a full product link or use /add PID123.');
    return addProductAndAsk(state, user, product);
  }
  if (name === 'remove') {
    const product = parseProductInput(args);
    if (!product) return sendMessage(user.chatId, 'Send the PID/LID or product link to remove.');
    user.products = user.products.filter(value => value !== product);
    if (Array.isArray(user.scanProducts)) user.scanProducts = user.scanProducts.filter(value => value !== product);
    if (Array.isArray(user.bankAlertProducts)) user.bankAlertProducts = user.bankAlertProducts.filter(value => value !== product);
    user.bankAlerts = selectedBankAlertProducts(user).length > 0;
    await save(state);
    await sendMessage(user.chatId, `Removed: <code>${html(product)}</code>`);
    return;
  }
  if (name === 'pin' || name === 'pincode') {
    const pin = String(args).trim();
    if (!isValidPincode(pin)) return sendMessage(user.chatId, 'Pincode must contain exactly six digits.');
    user.pincodes = uniquePincodes([...user.pincodes, pin]);
    await save(state);
    await sendMessage(user.chatId, `Pincode added: <code>${pin}</code>\n\n${pincodeList(user)}`, { reply_markup: telegramKeyboard(pincodeButtons(user)) });
    return;
  }
  if (name === 'rmpin') {
    user.pincodes = user.pincodes.filter(pin => pin !== String(args).trim());
    await save(state);
    await sendMessage(user.chatId, `Pincode removed: <code>${html(args)}</code>`);
    return;
  }
  if (name === 'interval') {
    const interval = Number(args);
    if (!INTERVALS.includes(interval)) return sendMessage(user.chatId, 'Interval must be 1, 2, 5 or 10 seconds.');
    user.interval = interval;
    await save(state);
    if (user.running) { stopLoop(user.id); startLoop(user.id, user.interval); }
    await sendMessage(user.chatId, `Refresh interval set to ${interval} second${interval === 1 ? '' : 's'}.`);
    return;
  }
  if (name === 'bankalerts') {
    user.bankAlerts = ['on', 'true', 'yes'].includes(args.toLowerCase());
    user.bankAlertProducts = user.bankAlerts ? [...user.products] : [];
    await save(state);
    await sendMessage(user.chatId, `Bank offer selection set for ${selectedBankAlertProducts(user).length} product${selectedBankAlertProducts(user).length === 1 ? '' : 's'}. Press Bank offers check to start monitoring buy price and bank offers.`);
    return;
  }
  if (name === 'mute') {
    user.muted = ['on', 'true', 'yes'].includes(args.toLowerCase());
    await save(state);
    await sendMessage(user.chatId, `Notifications muted: ${user.muted ? 'ON' : 'OFF'}.`);
    return;
  }
  if (name === 'scan') return openScanMenu(user);
  if (name === 'stop') return openStopMenu(user);
  if (name === 'clear') { user.results = []; await save(state); return sendMessage(user.chatId, 'Saved results cleared.'); }
  if (name === 'products') return sendMessage(user.chatId, productList(user), { reply_markup: telegramKeyboard(productButtons(user)) });
  if (name === 'pincodes') return sendMessage(user.chatId, pincodeList(user), { reply_markup: telegramKeyboard(pincodeButtons(user)) });
  if (name === 'results') return sendLong(user.chatId, formatResults(user));
  if (name === 'status') return sendMessage(user.chatId, `<b>Status</b>\nProducts: ${user.products.length}/${MAX_PRODUCTS}\nPincodes: ${user.pincodes.length}\nPincode list: ${user.pincodes.map(html).join(', ') || 'None'}\n\nStock check: ${stockIsRunning(user) ? 'ON' : 'OFF'}\nStock products: ${selectedProductNames(user, 'stock')}\n\nBank offers check: ${bankIsRunning(user) ? 'ON' : 'OFF'}\nBank-offer products: ${selectedProductNames(user, 'bank')}\n\nInterval: ${user.interval}s\nLast scan: ${html(user.lastScanAt || 'Never')}\n${user.lastError ? `Last error: ${html(user.lastError)}` : ''}`);
  return sendMessage(user.chatId, 'Unknown command. Use /help.', { reply_markup: userPanel() });
}

async function handleCallback(state, query) {
  const data = String(query.data || '');
  const fromId = String(query.from.id);
  await telegram('answerCallbackQuery', { callback_query_id: query.id });
  if (data === 'noop') return;
  if (['approve', 'reject', 'revoke'].some(prefix => data.startsWith(`${prefix}:`))) {
    if (fromId !== ADMIN_ID) return sendMessage(query.message.chat.id, 'Admin access only.');
    const [action, targetId] = data.split(':');
    const target = state.users?.[targetId];
    if (!target) return sendMessage(query.message.chat.id, 'User request no longer exists.');
    target.pending = false;
    target.approved = action === 'approve';
    await save(state);
    await sendMessage(target.chatId, target.approved ? 'Access approved. Send /start to open your control panel.' : 'Access rejected or revoked by admin.');
    return sendMessage(query.message.chat.id, `${action === 'approve' ? 'Approved' : action === 'revoke' ? 'Revoked' : 'Rejected'} <code>${html(targetId)}</code>.`);
  }
  const user = state.users?.[fromId];
  if (!user || !(await requireAccess(state, user))) return;
  if (data === 'add_help') {
    user.addingProducts = true;
    await save(state);
    return sendMessage(user.chatId, 'Send a Flipkart product link or PID. After each product I will ask if you want to add another.');
  }
  if (data === 'add_more') {
    user.addingProducts = true;
    await save(state);
    return sendMessage(user.chatId, 'Send the next Flipkart product link or PID.');
  }
  if (data === 'add_done') {
    user.addingProducts = false;
    await save(state);
    return sendMessage(user.chatId, `<b>Your products</b>\n${productList(user)}`, { reply_markup: userPanel() });
  }
  if (data === 'remove_help') return sendMessage(user.chatId, 'Use /remove PID/LID or tap a product in the Products list.', { reply_markup: telegramKeyboard(productButtons(user)) });
  if (data === 'show_products') return sendMessage(user.chatId, productList(user), { reply_markup: telegramKeyboard(productButtons(user)) });
  if (data === 'show_pincodes') return sendMessage(user.chatId, pincodeList(user), { reply_markup: telegramKeyboard(pincodeButtons(user)) });
  if (data === 'start_scan' || data === 'scan_menu') return openScanMenu(user);
  if (data === 'stop_menu' || data === 'stop_scan' || data === 'stop_bank') return openStopMenu(user);
  if (data === 'stop_mode:stock') return openStopProductMenu(user, 'stock');
  if (data === 'stop_mode:bank') return openStopProductMenu(user, 'bank');
  if (data === 'stop_all') {
    user.stockRunning = false;
    user.bankRunning = false;
    user.running = false;
    await save(state);
    stopLoop(user.id);
    return sendMessage(user.chatId, 'Stock and bank-offer checking stopped for all products.', { reply_markup: userPanel() });
  }
  if (data.startsWith('stopall:')) {
    const kind = data.slice(8);
    if (kind === 'stock') {
      user.scanProducts = [];
      user.stockRunning = false;
    } else if (kind === 'bank') {
      user.bankAlertProducts = [];
      user.bankAlerts = false;
      user.bankRunning = false;
    }
    syncRunning(user);
    await save(state);
    if (!user.running) stopLoop(user.id);
    return sendMessage(user.chatId, `All ${kind === 'stock' ? 'stock' : 'bank-offer'} product checks stopped.`, { reply_markup: userPanel() });
  }
  if (data.startsWith('stopprod:')) {
    const [kind, indexText] = data.slice(9).split(':');
    const index = Number(indexText);
    const product = user.products[index];
    if (!product || !['stock', 'bank'].includes(kind)) return sendMessage(user.chatId, 'That product is no longer active.');
    if (kind === 'stock') user.scanProducts = selectedScanProducts(user).filter(value => value !== product);
    else user.bankAlertProducts = selectedBankAlertProducts(user).filter(value => value !== product);
    if (kind === 'stock' && !user.scanProducts.length) user.stockRunning = false;
    if (kind === 'bank') {
      user.bankAlerts = user.bankAlertProducts.length > 0;
      if (!user.bankAlertProducts.length) user.bankRunning = false;
    }
    syncRunning(user);
    await save(state);
    if (!user.running) stopLoop(user.id);
    if (kind === 'stock' ? user.scanProducts.length : user.bankAlertProducts.length) return openStopProductMenu(user, kind);
    return sendMessage(user.chatId, `${product} stopped. No ${kind === 'stock' ? 'stock' : 'bank-offer'} products remain in that check.`, { reply_markup: userPanel() });
  }
  if (data === 'panel') return sendMessage(user.chatId, '<b>Control panel</b>', { reply_markup: userPanel() });
  if (data === 'bank_toggle' || data === 'bank_menu') return openBankMenu(user);
  if (data === 'mute_toggle') { user.muted = !user.muted; await save(state); return sendMessage(user.chatId, `Notifications muted: ${user.muted ? 'ON' : 'OFF'}.`); }
  if (data === 'status') return handleCommand(state, user, { name: 'status', args: '' });
  if (data === 'clear_results') return handleCommand(state, user, { name: 'clear', args: '' });
  if (data === 'scan_all' || data === 'scan_none') {
    user.scanProducts = data === 'scan_all' ? [...user.products] : [];
    await save(state);
    return sendMessage(user.chatId, scanSelectionMessage(user), { reply_markup: scanSelectionMarkup(user) });
  }
  if (data === 'bank_all' || data === 'bank_none') {
    user.bankAlertProducts = data === 'bank_all' ? [...user.products] : [];
    user.bankAlerts = user.bankAlertProducts.length > 0;
    await save(state);
    return sendMessage(user.chatId, bankSelectionMessage(user), { reply_markup: bankSelectionMarkup(user) });
  }
  if (data === 'scan_start') return startStockScan(state, user);
  if (data === 'bank_start') return startBankScan(state, user);
  if (data === 'bank_done') {
    user.bankAlerts = selectedBankAlertProducts(user).length > 0;
    await save(state);
    return sendMessage(user.chatId, `Bank offers selection saved for ${selectedBankAlertProducts(user).length} product${selectedBankAlertProducts(user).length === 1 ? '' : 's'}. Press Bank offers check to start.`, { reply_markup: userPanel() });
  }
  if (data.startsWith('rmpin:')) {
    const pin = data.slice(6);
    user.pincodes = user.pincodes.filter(value => value !== pin);
    await save(state);
    return sendMessage(user.chatId, `Pincode removed: <code>${html(pin)}</code>\n\n${pincodeList(user)}`, { reply_markup: telegramKeyboard(pincodeButtons(user)) });
  }
  if (data.startsWith('scanprod:') || data.startsWith('bankprod:')) {
    const kind = data.startsWith('scanprod:') ? 'scan' : 'bank';
    const index = Number(data.slice(kind === 'scan' ? 9 : 9));
    const product = user.products[index];
    if (!product) return sendMessage(user.chatId, 'That product is no longer in your list.');
    const field = kind === 'scan' ? 'scanProducts' : 'bankAlertProducts';
    const current = kind === 'scan' ? selectedScanProducts(user) : selectedBankAlertProducts(user);
    const next = current.includes(product) ? current.filter(value => value !== product) : [...current, product];
    user[field] = next;
    if (kind === 'bank') user.bankAlerts = next.length > 0;
    await save(state);
    return sendMessage(user.chatId, kind === 'scan' ? scanSelectionMessage(user) : bankSelectionMessage(user), {
      reply_markup: kind === 'scan' ? scanSelectionMarkup(user) : bankSelectionMarkup(user)
    });
  }
  if (data.startsWith('rmprod:')) {
    const product = normalizeProductId(data.slice(7));
    user.products = user.products.filter(value => value !== product);
    if (Array.isArray(user.scanProducts)) user.scanProducts = user.scanProducts.filter(value => value !== product);
    if (Array.isArray(user.bankAlertProducts)) user.bankAlertProducts = user.bankAlertProducts.filter(value => value !== product);
    user.bankAlerts = selectedBankAlertProducts(user).length > 0;
    await save(state);
    return sendMessage(user.chatId, `Removed: <code>${html(product)}</code>`);
  }
  if (data === 'admin_panel' && fromId === ADMIN_ID) { const panel = adminPanel(state); return sendMessage(user.chatId, panel.text, { reply_markup: panel.markup }); }
}

async function handleUpdate(update) {
  const message = update.message;
  if (update.callback_query) {
    const state = await readState();
    return handleCallback(state, update.callback_query);
  }
  if (!message?.from || !message.chat) return;
  const state = await readState();
  const user = ensureUser(state, message.from, message.chat.id);
  if (message.chat.type !== 'private') {
    await save(state);
    return sendMessage(message.chat.id, 'Use this bot in a private chat for access approval and saved watchlists.');
  }
  const command = parseCommand(message.text);
  if (command) {
    await save(state);
    return handleCommand(state, user, command);
  }
  if (!(await requireAccess(state, user))) return;
  const text = String(message.text || '').trim();
  const pin = text.match(/^\d{6}$/)?.[0];
  if (pin) {
    user.pincodes = uniquePincodes([...user.pincodes, pin]);
    await save(state);
    return sendMessage(user.chatId, `Pincode added: <code>${pin}</code>\n\n${pincodeList(user)}`, { reply_markup: telegramKeyboard(pincodeButtons(user)) });
  }
  const product = parseProductInput(text);
  if (product) return addProductAndAsk(state, user, product);
  if (user.addingProducts) return sendMessage(user.chatId, 'Please send a valid Flipkart product link or PID, or press Done / show panel.', { reply_markup: addProductMarkup() });
  await sendMessage(user.chatId, 'Send a Flipkart product link, a PID/LID, or a six-digit pincode. Use /help for commands.');
}

async function restoreLoops() {
  const state = await readState();
  for (const user of Object.values(state.users || {})) {
    if (user.running && user.stockRunning === undefined) user.stockRunning = true;
    if ((stockIsRunning(user) || bankIsRunning(user)) && approved(user)) startLoop(user.id, user.interval);
  }
}

async function poll() {
  let offset = 0;
  while (true) {
    try {
      const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates || []) {
        offset = update.update_id + 1;
        await handleUpdate(update).catch(() => {});
      }
    } catch {
      await sleep(3000);
    }
  }
}

async function start() {
  if (!TOKEN) throw new Error('Set TELEGRAM_BOT_TOKEN before starting the bot.');
  if (!ADMIN_ID || !/^[-]?\d+$/.test(ADMIN_ID)) throw new Error('Set TELEGRAM_ADMIN_ID to the numeric Telegram account ID that receives access requests.');
  await telegram('deleteWebhook', { drop_pending_updates: false });
  await telegram('setMyCommands', { commands: [
    { command: 'start', description: 'Open the control panel' },
    { command: 'add', description: 'Add a product link or PID' },
    { command: 'remove', description: 'Remove a product' },
    { command: 'pin', description: 'Add a pincode' },
    { command: 'scan', description: 'Start stock checking' },
    { command: 'stop', description: 'Stop stock checking' },
    { command: 'status', description: 'Show bot status' },
    { command: 'help', description: 'Show help' }
  ]});
  await restoreLoops();
  console.log('Telegram bot is running.');
  const heartbeat = setInterval(() => { telegram('getMe').catch(() => {}); }, HEARTBEAT_MS);
  try {
    await poll();
  } finally {
    clearInterval(heartbeat);
  }
}

if (require.main === module) {
  startHealthServer();
  start().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = {
  handleUpdate,
  parseCommand,
  parseProductInput,
  startHealthServer,
  start,
  _test: { aggregateResults, newUser, selectedScanProducts, selectedBankAlertProducts, selectionRows }
};
