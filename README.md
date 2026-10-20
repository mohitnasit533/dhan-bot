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
- A bullish signal sells a stock PE near -0.40 delta; a bearish signal sells a stock CE near +0.40 delta. Both entries are short option orders.
- On stocks opening at least 3% away from the previous session close, wait for a completed 15-minute candle to close between EMA 21 and EMA 34. For a gap up, wait for a later close above EMA 21 to confirm BUY / sell PE. For a gap down, a close above EMA 21 is wait-only; then wait for a subsequent close back below EMA 21 to confirm SELL / sell CE. Either setup can signal only when the existing EMA crossover, Supertrend, VWAP, and narrow-CPR confirmations also agree, along with the usual liquidity, market, and risk checks.
- Stop loss, profit target, and daily max-loss limits are editable INR amounts. All three intentionally start blank, and entries/Auto trade stay blocked until positive values are saved; no percentage-based risk is assumed.
- Use the current monthly stock-option expiry through its final seven calendar days, then shift to the next month’s chain.
- New entries are restricted to weekdays from 09:45 until before 14:00 IST. Up to five positions may be open.
- The scanner discovers the current NSE stock-option universe from Dhan's security master and includes every underlying, even when a quote or turnover value is unavailable. It ranks rows with current quotes by turnover; the optional minimum turnover argument is not applied by the scanner. Cash prices refresh about once per second; indicators and entries use closed 15-minute candles.
- Option selection requires a minimum open interest of 1,000 and a maximum bid/ask spread of 2% by default. These are editable starting filters, not exchange guarantees; missing OI or invalid bid/ask data always blocks the contract.
- Auto trade is off by default. Paper Auto trade can be enabled without authorizing live orders and only simulates confirmed signals; positive daily-loss, stop-loss, and target values are still required. Paper and Live scanning both use verified Dhan API market data. If Dhan is disconnected, Paper Auto waits without opening simulated trades; it never falls back to a different quote provider. In Live mode, enabling Auto trade allows the server to place real option super orders without per-order confirmation. The server keeps scanning while it is running, even if the dashboard tab is closed.
- Paper trades, closed positions, bot-created live-order tracking, risk settings, and auto-signal deduplication are stored locally so restarts do not silently erase positions or permit a repeated signal. The daily max-loss control stops new bot entries when realized plus unrealized bot P&L reaches the configured INR limit; it does not liquidate an existing broker position.
- New entries are blocked when NSE holiday/F&O ban data is stale, unavailable, or says the market is closed for the selected symbol. Live orders also require a fresh broker position/order check and sufficient margin versus available funds. Alerts and rotating local logs are available; Telegram alerts are optional and require both Telegram environment variables.

The strategy and default OI/spread filters are implementation settings, not a guarantee of trading performance. Verify all contract details and order values before enabling live trading.

## Dhan connection and hosting

The green pulsing **Dhan verified** indicator appears only after the local server successfully calls Dhan's `/profile` endpoint and confirms the returned Client ID. While connected, the dashboard repeats this check every 30 seconds. A saved token or a demo-looking browser label by itself does not mean Dhan is connected.

This server intentionally binds to `127.0.0.1` and accepts localhost requests only. It is for a local dashboard, not an embeddable public webpage or an internet-facing deployment. Do not expose port 3000 through a router, tunnel, or public hosting service without separately designing authentication, TLS, and broker-secret protections. Run `.\install-startup.ps1` in PowerShell to install and start a Windows sign-in scheduled task; it restarts the app after failures and does not impose a run-time limit. Remove it with `.\uninstall-startup.ps1`. The app still runs only while that Windows account/session and machine are available.

Live order APIs require a Dhan-whitelisted static IP configured in Dhan Web under Access DhanHQ APIs; do not put an IP address in `.env`. A Data API plan is needed for Dhan market quotes, candles, feeds, and option-chain data. WebSocket live ticks also require the appropriate active data access; the current scanner uses REST snapshots and closed candles.

## Credentials and security

On the connection form, **Save verified credentials to this computer for auto-renewal** is selected by default. After Dhan `/profile` verifies the Client ID, the app saves that Client ID and token to the ignored local `.env`; it can then reconnect after a restart and renew the token. Uncheck it to keep credentials in server memory only. `.env` is plain text, so only select this on your private Windows account/device.

[Dhan's authentication docs](https://dhanhq.co/docs/v2/authentication/) say Web-generated access tokens are valid for 24 hours and that `RenewToken` works only for active Web-generated tokens.

Dhan also documents an API-key/secret OAuth flow: the key and secret last 12 months, but obtaining an access token requires generating consent, completing Dhan's browser login/2FA step, and consuming the consent. The docs do not promise a 30-day access token. This app does not currently implement that OAuth flow. Automatic renewal avoids routine daily token replacement when the app can reach Dhan and the Web token remains active. If the app stays offline until the token expires, or Dhan does not allow renewal for that token, generate a fresh token and reconnect. Disconnecting clears the in-memory connection but leaves explicitly saved `.env` credentials intact.

`.env` is plain text, not encrypted: keep access to your Windows account private, never share or commit the file, and never paste real credentials into `.env.example`.

The API accepts loopback hosts and same-origin browser mutations only. Live order submission checks broker positions and active super orders, and reserves each underlying while a submission is pending or its result is uncertain. Auto-trade signal timestamps are saved locally (without credentials) to prevent the same closed-candle signal from re-entering after a restart or after a position is squared off through another Dhan device. If a submission times out, check Dhan's order book before retrying; the app intentionally blocks another order until it can reconcile the first.
