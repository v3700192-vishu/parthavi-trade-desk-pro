# PARTHAVI TRADE DESK PRO

Production-oriented trading dashboard for NSE/BSE analysis with a risk-first architecture.

## Current status
- Web dashboard and protected execution UX are included.
- Angel One credentials are server-side only.
- Live broker/account/order execution remains disabled until server secrets, registered static IP, exchange-session checks and safety gates are verified.
- The UI never claims guaranteed profit. Any profit-chance field is historical/backtest based only.

## Run
npm install
npm start

Open http://localhost:3000

## Environment
Copy .env.example to .env and configure secrets on the server only.

## Deployment
See DEPLOYMENT.md.
