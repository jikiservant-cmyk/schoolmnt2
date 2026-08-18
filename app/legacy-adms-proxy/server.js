const http = require('http');
const https = require('https');

// The secure Google Cloud Run app URL where the web app lives
const TARGET_HOSTNAME = 'ais-dev-akkeowfawefwrcoub3t3e3-159837012533.europe-west3.run.app';
const TARGET_PORT = 443;

const server = http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ADMS Request -> ${req.method} ${req.url}`);

  const options = {
    hostname: TARGET_HOSTNAME,
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      // We must override the host header to match the target, 
      // otherwise Google Cloud will reject the HTTPS request
      host: TARGET_HOSTNAME, 
    }
  };

  // Forward the HTTP request out securely over HTTPS
  const proxyReq = https.request(options, (proxyRes) => {
    // Forward the response headers and status code back to the ZKTeco device
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    // Pipe the response body back to the ZKTeco device
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error(`[PROXY ERROR]: Failed to reach cloud server ->`, err.message);
    res.writeHead(502);
    res.end('Bad Gateway');
  });

  // Pipe the incoming request body (if any) to the outgoing HTTPS request
  req.pipe(proxyReq, { end: true });
});

// Run on port 80 (Standard HTTP port that the ZKTeco device expects)
const PORT = process.env.PORT || 80;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===================================================`);
  console.log(`🚀 ZKTeco ADMS HTTP -> HTTPS Proxy Server Running!`);
  console.log(`===================================================`);
  console.log(`Listening on local HTTP Port: ${PORT}`);
  console.log(`Forwarding all traffic to: https://${TARGET_HOSTNAME}`);
  console.log(`===================================================`);
});
