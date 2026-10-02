# PARTHAVI TRADE DESK — Phase 12 Live Prep Status

Updated: 2026-10-02

## Verified
- Phase 11 automated tests: PASS
- Phase 12 automated tests: PASS
- Release ZIP integrity: PASS
- Angel One SmartAPI order flow reviewed against current static-IP requirement
- Render deployment shape prepared
- Production safety gates remain OFF/LOCKED by default

## Production path
Browser -> HTTPS -> Node backend -> Angel One SmartAPI -> live market/account data -> analysis/risk engine -> explicit order confirmation -> broker

## Required before real-money execution
1. Production server with a registered static IPv4 source path.
2. Angel One static-IP API configuration matching that source IP.
3. Server-side Angel One secrets only; never commit credentials.
4. Protective-stop mechanism independently verified.
5. External news/global/event provider credentials if those feeds are used.
6. HTTPS custom domain and production environment variables.
7. Credentialed smoke tests for login, LTP/quotes, funds, positions, orders and exits.

## Safety defaults
ORDER_EXECUTION_ENABLED=false
STATIC_IP_VERIFIED=false
PROTECTIVE_SL_VERIFIED=false
TRADING_KILL_SWITCH=true

No live order is implied by this repository status until the production gates are independently verified.
