process.env.ENCRYPTION_KEY ??= 'a'.repeat(64)
process.env.ADMIN_SECRET ??= 'b'.repeat(64)
process.env.CTRADER_CLIENT_ID ??= 'test-client-id'
process.env.CTRADER_CLIENT_SECRET ??= 'test-client-secret'
process.env.TRADINGVIEW_IPS ??= '127.0.0.1'
process.env.LOG_DIR ??= './tests/.tmp-logs'
