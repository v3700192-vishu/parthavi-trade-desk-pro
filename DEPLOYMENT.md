# Deployment checklist

1. Deploy the Node service on a server with HTTPS.
2. Configure environment variables server-side; never commit .env.
3. Register the server's static public IPv4 with the broker when required.
4. Verify NSE and BSE session/holiday adapters.
5. Connect Angel One SmartAPI on the server.
6. Verify funds, positions, orders, quotes and WebSocket streams.
7. Run read-only/safe tests before enabling live orders.
8. Keep ORDER_EXECUTION_ENABLED=false until all gates pass and the user explicitly confirms each live order.
