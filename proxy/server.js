'use strict';

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

// Configuration via environment variables
const TARGET_URL = process.env.VPLAN_URL;
const VPLAN_USER = process.env.VPLAN_USER || '';
const VPLAN_PASS = process.env.VPLAN_PASS || '';
const PORT = process.env.PORT || 3000;
// Allowed origin for CORS (e.g. http://localhost:5000 or your production domain)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!TARGET_URL) {
  console.error('Error: VPLAN_URL environment variable is required.');
  console.error('Example: VPLAN_URL=https://vertretungsplan.example.de node server.js');
  process.exit(1);
}

const targetOrigin = new URL(TARGET_URL).origin;

const app = express();

// CORS headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(
  '/proxy',
  createProxyMiddleware({
    target: targetOrigin,
    changeOrigin: true,
    pathRewrite: { '^/proxy': '' },
    on: {
      proxyReq: (proxyReq) => {
        if (VPLAN_USER) {
          const encoded = Buffer.from(`${VPLAN_USER}:${VPLAN_PASS}`).toString('base64');
          proxyReq.setHeader('Authorization', `Basic ${encoded}`);
        }
      },
    },
  })
);

app.listen(PORT, () => {
  console.log(`Vertretungsplan proxy running on http://localhost:${PORT}/proxy`);
  console.log(`Proxying to: ${targetOrigin}`);
});
