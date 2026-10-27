# Polybots

A dashboard for running many rule-based bots on Polymarket's **Bitcoin Up or Down – hourly** markets (polymarket.com).
Every bot reads the closed BTCUSDT 1h candles at the top of each hour, picks UP or DOWN, and the trade settles
when that hour's candle closes (UP wins when close ≥ open, the same rule Polymarket uses).

**Paper trading only.** Bots trade simulated money on real candle data. Nothing is sent to Polymarket and no wallet or private key is used.

## Features

- 15 strategies across trend, range, volume, support/resistance, candle reactions/rejections and oscillators. Every one can be flipped, and any number of bots can share a strategy with different settings.
- Per-bot starting balance (default $100), lot per trade, entry price, and martingale (multiplier + reset to base after N losses in a row).
- Bot cards: realized PnL, balance, balance curve, record, current and best streaks, max drawdown, runtime, and streak hit counts (`L2×4 L3×2 …`).
- Sort and filter by top profit, top loss, top win streak, top loss streak, win rate, drawdown; filter by status, method, name.
- Hourly PnL page: pick one or many dates (or 7d / 30d / 1y presets), see won and lost dollars per PKT hour plus the net, summed over the selection.
- Backtest on create or reset: replay up to 365 days so stats and the calendar fill immediately. Backtest trades are tagged `BT` and can be hidden.
- Email/password accounts. Each account sees only its own bots.

## Run it

```bash
npm install
npm run build
npm start            # http://localhost:8080
```

Development with hot reload: `npm run dev` (API on :8080, UI on :5173).

Settings live in environment variables, see `.env.example`. The important ones:

| Variable | Default | Meaning |
|---|---|---|
| `DATA_SOURCE` | `binance` | `binance` = real BTCUSDT 1h candles. `sim` = synthetic candles for offline testing. |
| `JWT_SECRET` | generated | Secret for login cookies. Set it in production. |
| `ALLOW_SIGNUP` | `true` | Set to `false` after creating your account. |
| `TAKER_FEE_RATE` | `0` | Polymarket taker fee rate, applied as `shares × rate × p × (1−p)`. |
| `ENTRY_WINDOW_SEC` | `120` | How late into an hour a bot may still enter. Later and the hour is skipped. |

The server needs outbound access to `api.binance.com` or `data-api.binance.vision`. Binance blocks some regions (for example the US);
run the server somewhere those hosts answer.

### Deploy

The `Dockerfile` runs the app on port 8080 and keeps the SQLite database in `/data`. Mount a volume there (on Railway: add a volume at `/data`).

## How a trade is priced

A bot buys shares of its side at the entry price (default 51¢). A win pays $1 per share, so a $5 stake at 51¢ wins $4.80 and loses $5.00.
Martingale multiplies the next stake after a loss, resets to the base lot after a win or after the set number of losses in a row,
and is capped by the bot's remaining balance. A bot whose balance falls below $1 stops with status `busted`.

## Layout

```
server/            Fastify API, SQLite, engine
  strategies/      indicator helpers and the strategy rules
  engine/core.ts   pure trade maths, martingale, stats (unit tested)
  engine/runner.ts hourly loop, settlement, backtest
  market.ts        candle feed (Binance or synthetic)
web/src/           React UI
shared/types.ts    types used by both
```

Tests: `npm test`.
