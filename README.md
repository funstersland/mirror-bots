# Polybots

A dashboard for running many rule-based bots on Polymarket's **Bitcoin Up or Down** markets (polymarket.com): the 1 hour, 15 minute and 5 minute windows.

Everything uses real market data:

- **Signals** come from real Binance BTCUSDT candles of the bot's timeframe.
- **Entries** walk the live Polymarket order book of the chosen outcome when the window opens, like a market buy, and pay Polymarket's taker fee (`shares × 0.07 × p × (1 − p)`, read from the market).
- **Results** come from Polymarket's resolution. 1h markets resolve on the Binance 1h candle, so they settle when it closes and are then checked against Polymarket. 5m and 15m markets resolve on Chainlink and settle when Polymarket resolves them.
- **Replays** use Polymarket's recorded minute prices at each window's open and the real result (up to 30 days for 1H, 7 for 15M, 2 for 5M). Replayed trades are tagged BT.

**Paper trading.** No orders are sent and no wallet or private key is used; balances are virtual. Each bot's fill ignores the other bots.

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
| `JWT_SECRET` | generated | Secret for login cookies. Set it in production. |
| `ALLOW_SIGNUP` | `true` | Set to `false` after creating your account. |

The server needs outbound access to `api.binance.com` or `data-api.binance.vision`. Binance blocks some regions (for example the US);
run the server somewhere those hosts answer.

### Deploy

The `Dockerfile` runs the app on port 8080 and keeps the SQLite database in `/data`. Mount a volume there (on Railway: add a volume at `/data`).

## Martingale

Martingale multiplies the next stake after a loss, resets to the base lot after a win or after the set number of losses in a row,
and is capped by the bot's balance. Martingale bots wait for their last trade to settle before entering. A bot whose balance falls below $1 stops as `busted`.

## Layout

```
server/            Fastify API, SQLite, engine
  strategies/      indicator helpers and the strategy rules
  engine/core.ts   pure trade maths, martingale, stats (unit tested)
  engine/runner.ts hourly loop, settlement, backtest
  market.ts        Binance candle feed (1h, 15m, 5m)
  polymarket.ts    Polymarket markets, order books, fees, price history
web/src/           React UI
shared/types.ts    types used by both
```

Tests: `npm test`.
