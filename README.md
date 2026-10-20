# dhan-bot

Auto trade stock options with multi confirmation and an automatic scanner.

A local dashboard for scanning current NSE stock-option underlyings through DhanHQ. It uses closed 15-minute candles and refreshes cash price snapshots about once per second.

## Requirements

- Node.js 18 or newer
- A Dhan account and current access token for live market data
- Dhan Data API access for quotes, candles, and option chains
- A Dhan-whitelisted static IP for live order placement

## Run locally

From PowerShell, run `npm.cmd install` and then `npm.cmd start`. Keep that terminal open while using the dashboard; pressing Ctrl+C or closing the terminal stops the server.

Open <http://localhost:3000/>.

Run the strategy tests with `npm.cmd test`.

Check whether the server is running at <http://localhost:3000/api/health>. If startup reports that the port is already in use, stop the other process using it or choose another `PORT` in `.env`.

## Strategy and controls

- Signals require a closed 15-minute EMA 21/34 crossover, matching Supertrend direction, a close beyond VWAP, and a narrow CPR breakout. Narrow CPR is configured as width no greater than 0.5% of the prior close.
- A bullish signal selects a stock PE near -0.40 delta; a bearish signal selects a stock CE near +0.40 delta. Both entries are short option orders.
- Short-option premium risk is fixed at a 20% stop loss and 50% target.
- Use the current monthly stock-option expiry through its final seven calendar days, then shift to the next month’s chain.
- New entries are restricted to weekdays from 09:45 until before 14:00 IST. Up to five positions may be open.
- The scanner discovers NSE stock-option underlyings from Dhan's security master, filters for at least INR 5 crore in daily traded value, and ranks qualifying stocks by turnover. Cash prices refresh about once per second; indicators and entries use closed 15-minute candles.
- Auto trade is off by default. Paper mode simulates confirmed signals. In Live mode, enabling Auto trade allows the server to place real option super orders without per-order confirmation. The server keeps scanning while it is running, even if the dashboard tab is closed.

The turnover filter and strategy rules are implementation settings, not a guarantee of trading performance. Verify all contract details and order values before enabling live trading.

## Credentials and security

Save the Dhan client ID and a current access token in `.env` (copy the names from `.env.example`); this file is ignored by Git. With both values set, the server verifies the account on startup, renews the active token, and saves the replacement token back to `.env`. It then renews every 20 hours while the server is running. Use an access token generated through Dhan Web: [Dhan's authentication docs](https://dhanhq.co/docs/v2/authentication/) document the `RenewToken` endpoint for active Web-generated tokens only.

Dhan currently documents access tokens as valid for 24 hours, not 30 days. Automatic renewal avoids routine daily token replacement when the app can reach Dhan and the original token is still active. If the app stays offline until the token expires, or Dhan does not allow renewal for that token, generate a fresh token and update `.env`. Tokens entered only in the dashboard are held in memory and are not persisted for automatic renewal. Disconnecting clears the in-memory connection.

`.env` is plain text, not encrypted: keep access to your Windows account private, never share or commit the file, and never paste real credentials into `.env.example`.

The API accepts loopback hosts and same-origin browser mutations only. Live order submission checks broker positions and active super orders, and reserves each underlying while a submission is pending or its result is uncertain. Auto-trade signal timestamps are saved locally (without credentials) to prevent the same closed-candle signal from re-entering after a restart or after a position is squared off through another Dhan device. If a submission times out, check Dhan's order book before retrying; the app intentionally blocks another order until it can reconcile the first.
