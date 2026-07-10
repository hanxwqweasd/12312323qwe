const http = require('http');
const port = process.env.PORT || 3000;
const path = process.env.HEALTHCHECK_PATH || '/health';
const req = http.request({ host: '127.0.0.1', port, path, timeout: 5000 }, (res) => {
  process.exit(res.statusCode >= 200 && res.statusCode < 500 ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.end();
