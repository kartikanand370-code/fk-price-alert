# Flipkart Stock Signal Telegram Bot

This project is a Telegram bot, not a browser app. Each approved Telegram user gets a saved watchlist of up to 50 product IDs/SKUs and any number of six-digit pincodes. A product can be added from a Flipkart link or directly by PID, LID, SKU, or FSN.

The control panel is built with Telegram inline buttons. It supports:

- Product add/remove, including links and PID/LID values.
- Multiple pincodes per product.
- Start, stop, clear, status, and results controls.
- 1, 2, 5, and 10 second scan intervals.
- Current buy/selling price display and price-change notifications.
- Stock by product and pincode, locations, product details, and separate errors.
- Bank offer snapshots and notifications when bank offers are added, removed, or changed.
- Per-user mute and persistent settings/results.
- Admin approval, rejection, revocation, and a user control panel.

Telegram replaces browser-only features such as wake lock and browser network badges with a persistent worker, scan status, and Telegram notifications. Telegram itself controls notification sound; `/mute on` suppresses bot alerts for that user.

## Access workflow

Set `TELEGRAM_ADMIN_ID` to the numeric Telegram account ID of the administrator. Do not use the bot ID from the bot token. When a new user sends `/start`, the admin receives an approval message with Approve and Reject buttons. Approved users can use the control panel. The admin can run `/admin` to see pending users and revoke an approved user.

## API modes

Use `FLIPKART_API_MODE=live` with a private, authorized inventory service, or deliberately use `FLIPKART_API_MODE=demo` for labelled sample data. The bot never claims demo data is live. It does not scrape storefront pages or bypass authentication, CAPTCHA, rate limits, or security controls.

The adapter uses these configurable contracts:

- `POST /inventory/check` with `{ productId, sku, pincode, category }`.
- `GET /products/:productId` returning a name/basic information and the current buy/selling price when available.
- `GET /offers/:productId` returning explicit `bankOffers`/`bank_offers`, or offer items explicitly marked `isBankOffer: true` or with a bank type/category.

Generic promotions are ignored. Price fields are read only from explicit product fields such as `buyingPrice`, `buyPrice`, `sellingPrice`, `salePrice`, or the corresponding `price`/`pricing` fields.

## Environment

Copy `.env.example` into the environment of the long-running Node host. Never commit the bot token, API token, admin ID, or Redis token.

Required:

- `TELEGRAM_BOT_TOKEN`: token from BotFather. Keep it private and rotate it if exposed.
- `TELEGRAM_ADMIN_ID`: numeric Telegram account ID that approves users.
- `FLIPKART_API_BASE_URL` for live mode, or `FLIPKART_API_MODE=demo` for labelled sample data.

Optional:

- `FLIPKART_API_TOKEN`: private bearer token for the authorized service.
- `FLIPKART_INVENTORY_PATH`, `FLIPKART_PRODUCT_PATH`, `FLIPKART_BANK_OFFERS_PATH`.
- `FLIPKART_API_TIMEOUT_MS`, `FLIPKART_API_RETRIES`, `FLIPKART_API_CONCURRENCY`, `FLIPKART_API_MIN_INTERVAL_MS`.
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and `UPSTASH_REDIS_KEY` for durable hosted state. Without Redis, local development uses `data/telegram-state.json`.

## Run

Node.js 18 or newer is required.

```bash
npm install
npm start
```

The bot uses Telegram long polling so second-level intervals work. Run it on a persistent Node host such as Railway, Render, Fly.io, a VPS, or a similar worker service. A short-lived serverless function cannot guarantee 1/2/5/10 second scans. The existing `api/stock.js` route remains available for authorized server-to-server use, but it is not the bot worker.

## Commands

- `/start` opens the control panel and requests access when needed.
- `/add <Flipkart link|PID|LID|SKU>` adds a product.
- `/remove <PID|LID|link>` removes a product.
- `/pin <six digit pincode>` and `/rmpin <pincode>` manage pincodes.
- `/scan` and `/stop` control scanning.
- `/interval <1|2|5|10>` changes the refresh interval.
- `/bankalerts <on|off>` tracks bank-offer changes.
- `/mute <on|off>` suppresses Telegram alerts.
- `/status`, `/products`, `/pincodes`, `/results`, and `/clear` show or clear data.
- `/admin` opens the admin approval panel for the configured administrator.

## Testing

Run `npm test`. Tests cover validation, duplicate product/pincode handling, link/PID parsing, explicit bank-offer filtering, price normalization, access workflow helpers, and static configuration. Do not put real credentials in test files.
