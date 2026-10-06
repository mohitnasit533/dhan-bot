# dhan-bot

Auto trade stock options with multi confirmation and an automatic scanner.

A local DhanHQ dashboard for scanning NSE F&O stock underlyings using closed 15-minute candles. The scanner builds its universe from NSE stock-option contracts in Dhan's instrument master, ranks stocks by today's traded value, and includes stocks with at least INR 5 crore of turnover.

## Requirements

- Node.js 18 or newer
- A Dhan account and current access token for live market data
- Dhan Data API access for quotes, candles, and option chains
- A Dhan-whitelisted static IP for live order placement

## Run locally

Run `npm install` and then `npm start` from PowerShell.

Open <http://localhost:3000/>.

Run the strategy tests with `npm test`.

## Strategy and controls

- Signals require a closed 15-minute EMA 21/34 crossover, matching Supertrend direction, a close beyond VWAP, and a narrow CPR breakout. Narrow CPR is configured as width no greater than 0.5% of the prior close.
- A bullish signal selects a stock PE near -0.40 delta; a bearish signal selects a stock CE near +0.40 delta. Both entries are short option orders.
- Short-option premium risk is fixed at a 20% stop loss and 50% target.
- Use the current monthly stock-option expiry until its final seven calendar days; during that final week, use the next month's monthly expiry.
- New entries are allowed only on weekdays from 09:45 until before 14:00 IST. A maximum of five positions may be open.
- The scanner derives all NSE stock-option underlyings from Dhan's instrument master, then filters for at least INR 5 crore in traded value today. Qualifying stocks are ordered by traded value; the dashboard displays turnover in crore.
- Auto scan refreshes the dashboard at one-second intervals when enabled, subject to Dhan's market-data rate limits. Manual refresh remains available.
- Auto trade is off by default. In Paper mode it can open simulated positions on confirmed signals. Live orders always require a separate preview and user confirmation.

The turnover filter and strategy rules are implementation settings, not a guarantee of trading performance. Verify all contract details and order values before enabling live trading.

## Credentials and security

Enter the Dhan client ID and access token in the local dashboard. The server holds credentials in memory only; do not commit access tokens or .env files. Disconnecting clears the in-memory connection.
