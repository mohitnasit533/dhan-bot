# dhan-bot

Auto trade stock options with multi confirmation and auto scanner.

A local dashboard for scanning stock-option setups through DhanHQ. The scanner uses closed 15-minute candles and the configured stock symbols in `dhan.js`.

## Requirements

- Node.js 18 or newer
- A Dhan account and current access token for live market data
- Dhan Data API access for quotes, candles, and option chains
- A Dhan-whitelisted static IP for live order placement

## Run locally

```powershell
npm install
npm start
```

Open <http://localhost:3000/>.

Run the strategy tests with:

```powershell
npm test
```

## Strategy and controls

- Signals require a closed 15-minute EMA 21/34 crossover, matching Supertrend direction, a close beyond VWAP, and a narrow CPR breakout. Narrow CPR is configured as width no greater than 0.5% of the prior close.
- A bullish signal selects a stock PE near -0.40 delta; a bearish signal selects a stock CE near +0.40 delta. Both entries are short option orders.
- Short-option premium risk is fixed at a 20% stop loss and 50% target.
- During the final seven calendar days before the nearest listed expiry, the selector uses the next calendar-month expiry.
- New entries are restricted to weekdays from 09:15 until before 14:00 IST. Up to five positions may be open.
- Auto scan refreshes the dashboard at one-second intervals when enabled, subject to Dhan's market-data rate limits. Manual refresh remains available.
- Auto trade is off by default. In Paper mode it can open simulated positions on confirmed signals. Live orders always require a separate preview and user confirmation.

The CPR threshold and strategy rules are implementation settings, not a guarantee of trading performance. Verify all contract details and order values before enabling live trading.

## Credentials and security

Enter the Dhan client ID and access token in the local dashboard. The server holds credentials in memory only; do not commit access tokens or `.env` files. Disconnecting clears the in-memory connection.
