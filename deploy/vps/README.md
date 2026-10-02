# PARTHAVI TRADE DESK PRO — VPS (Option B)

VPS deployment keeps the backend on a fixed-public-IPv4 server so Angel One API requests originate from that server.

Store broker secrets only in /opt/parthavi/app/.env on the VPS. Do not commit secrets to GitHub.

Required: Ubuntu 22.04+ or Debian 12+, Node.js 22+, fixed public IPv4, SSH access, and a domain for HTTPS.

Target: Internet → Nginx → Node.js 127.0.0.1:3000 → Angel One SmartAPI.

Before any real-money execution, verify the VPS outbound IPv4 exactly matches the IPv4 registered with Angel One. Keep ORDER_EXECUTION_ENABLED=false, STATIC_IP_VERIFIED=false, PROTECTIVE_SL_VERIFIED=false, and TRADING_KILL_SWITCH=true until verified.

Useful checks: curl -s http://127.0.0.1:3000/api/health and curl -s http://127.0.0.1:3000/api/network/status

Production execution should only be considered after VPS IP match, broker login, live stream, and protective-SL behavior are verified.
