# ZKTeco ADMS HTTP-to-HTTPS Reverse Proxy (`legacy-adms-proxy`)

Older ZKTeco biometric terminals speak plain HTTP on port 80 and cannot negotiate modern TLS directly. This zero-dependency Node.js proxy runs on a school LAN box or dedicated VM and safely forwards ADMS traffic to your SmartSkoolz HTTPS origin.

## Security Controls

- **Explicit Upstream Configuration**: Requires `UPSTREAM_URL` (no hardcoded staging or cloud URLs).
- **Strict ADMS Endpoint Allowlist**: Only forwards:
  - `GET /iclock/cdata` and `POST /iclock/cdata`
  - `GET /iclock/getrequest`
  - `POST /iclock/devicecmd`
  All other paths return `403 Forbidden`; disallowed HTTP verbs return `405 Method Not Allowed`.
- **Header Sanitization**: Strips incoming `X-Forwarded-For`, `X-Real-IP`, `X-Device-Token`, `Authorization`, and `Cookie` headers so LAN clients cannot spoof client IPs, forge admin sessions, or smuggle tokens.
- **Per-Device Authentication Injection**: Injects `X-Device-Token` per hardware serial number from `DEVICE_TOKENS_JSON` (falling back to `ZKTECO_DEVICE_SECRET` if configured).
- **Resource Limits**: Enforces a 1 MiB body limit (`413`) and a 15-second upstream timeout (`504`).

## Configuration

| Environment Variable | Required | Description |
| --- | --- | --- |
| `UPSTREAM_URL` | **Yes** | Target SmartSkoolz origin, e.g. `https://attendance.school.example.com` |
| `DEVICE_TOKENS_JSON` | Recommended | JSON object mapping serial numbers to per-device tokens, e.g. `{"SNA0001":"tok_gate_1","SNA0002":"tok_gate_2"}` |
| `ZKTECO_DEVICE_SECRET` | Optional | Fallback token when a serial is not listed in `DEVICE_TOKENS_JSON` |
| `PORT` | Optional | Local TCP port to listen on (defaults to `80`) |
| `BIND_HOST` | Optional | Bind address (defaults to `0.0.0.0`) |

## Running

```bash
export UPSTREAM_URL="https://attendance.school.example.com"
export DEVICE_TOKENS_JSON='{"SNA0001":"replace-with-device-token"}'
sudo -E node server.js
```
