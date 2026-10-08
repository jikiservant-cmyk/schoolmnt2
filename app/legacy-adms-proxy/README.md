# ZKTeco Legacy ADMS HTTP-to-HTTPS Proxy

Because Google Cloud physically rejects unencrypted HTTP connections at its front door, legacy ZKTeco devices (which lack HTTPS/Port settings) cannot connect directly to it.

This small Node.js proxy server solves the problem by acting as a "translator".

## How it works:
1. The ZKTeco device sends plain `HTTP` traffic (Port 80) to this proxy running on a local PC.
2. The proxy catches it, wraps it in secure `HTTPS` (Port 443), and forwards it to Google Cloud.
3. Google Cloud replies securely to the proxy, which then hands it back to the ZKTeco device.

## What it refuses (by design)

The proxy is deliberately not a general-purpose relay, so that anything else on
the school network cannot borrow the school's connection to reach the app:

- only `GET`, `POST` and `HEAD` requests to **`/iclock/...`** are forwarded
  (everything else gets `404` / `405`);
- request bodies are capped at 1 MB (`ADMS_MAX_BODY_BYTES`);
- only device-related headers are passed upstream — no cookies, no `Host`
  rewriting by the client, no `X-Forwarded-*`, no `Connection` /
  `Transfer-Encoding` / `Upgrade`;
- the upstream target must be `https://`, unless it is a loopback address used
  for local testing.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `80` | Local listen port (the device expects 80). |
| `ADMS_TARGET_URL` | the deployed app URL in `server.js` | Where device traffic is forwarded. Update this if the app moves. |
| `ADMS_MAX_BODY_BYTES` | `1048576` | Maximum accepted request body. |
| `ADMS_UPSTREAM_TIMEOUT_MS` | `15000` | Upstream timeout before the proxy answers `504`. |

```bash
# example: point at a different deployment
ADMS_TARGET_URL=https://your-app.example.run.app npm start
```

## Instructions to Run

1. Copy this entire `legacy-adms-proxy` folder onto a Windows PC, Mac, or Linux computer (like a Raspberry Pi) that sits on the **same local Wi-Fi or Ethernet network** as the ZKTeco device.
2. Ensure you have [Node.js](https://nodejs.org/) installed on that computer.
3. Open a Command Prompt or Terminal as **Administrator / Sudo** (because running on Port 80 requires elevated privileges).
4. Navigate to the folder:
   ```bash
   cd legacy-adms-proxy
   ```
5. Run the proxy server:
   ```bash
   npm start
   ```

## Configuring the ZKTeco F18 Device

Once the proxy says it is running, it will tell you what to do next:

1. Find the local IP address of the computer running the proxy (e.g., `192.168.1.55`).
2. Go to your F18 Device Menu: **Comm. -> Cloud Server Setting**
3. **Enable Domain Name:** OFF
4. **Server Address:** `192.168.1.55` (The IP of the proxy computer).

The device will now connect to the proxy, which will securely route the data to your cloud dashboard!
