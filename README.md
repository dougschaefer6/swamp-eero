# @dougschaefer/eero-network

A [Swamp](https://github.com/systeminit/swamp) extension model for managing eero mesh WiFi networks through the reverse-engineered cloud API at `api-user.e2ro.com`. Provides per-client band assignment (2.4/5/6 GHz), signal strength, channel info, which eero node each device is connected to, network health, speed tests, settings management, and a raw API passthrough for the full ~60 endpoint surface.

Built for diagnosing WiFi performance issues — particularly the kind of intermittent jitter and band-steering failures that are common with Apple devices on mesh networks.

## Methods

### Authentication

| Method | Description |
|--------|-------------|
| `auth-start` | Send SMS/email verification code to begin authentication |
| `auth-verify` | Complete authentication with verification code, returns session token |
| `auth-refresh` | Refresh an expired session token |

### Raw API Passthrough

| Method | Description |
|--------|-------------|
| `api` | Hit any eero API endpoint directly — covers all ~60 known endpoints |

### Network

| Method | Description |
|--------|-------------|
| `network` | Network overview — health, band steering, DNS, IPv6, SQM, speed test results, client/eero counts |
| `eeros` | All eero nodes — model, firmware, status, gateway flag, connected client count, mesh quality |
| `clients` | Every connected device with band (2.4/5/6 GHz), signal strength (dBm), channel, which eero node, connection type, manufacturer |

### Diagnostics

| Method | Description |
|--------|-------------|
| `speed-test` | Trigger a speed test or retrieve the latest result |
| `band-steering` | Get or toggle band steering |
| `reboot-node` | Reboot a specific eero node by name |
| `settings` | Get or update network settings (DNS, IPv6, SQM, WPA3, UPnP, band steering) |

## Installation

```bash
swamp extension pull @dougschaefer/eero-network
```

## Setup

### 1. Authenticate with the eero API

Eero uses SMS/email OTP authentication (the same flow as the mobile app). Amazon SSO accounts are not supported — if your eero is linked to an Amazon account, add a second admin user through the eero app first.

```bash
# Create vault for session token
swamp vault create local_encryption eero
swamp vault put eero session-token "placeholder"

# Create model instance
swamp model create @dougschaefer/eero-network eero-home \
  --global-arg 'sessionToken=${{ vault.get(eero, session-token) }}'

# Send verification code
swamp model method run eero-home auth-start --json \
  --input '{"login": "your-email@example.com"}'

# Check the output for the userToken, then verify with the code you received
swamp model method run eero-home auth-verify --json \
  --input '{"userToken": "TOKEN_FROM_AUTH_START", "code": "123456"}'

# Save the session token from the output
swamp vault put eero session-token "TOKEN_FROM_VERIFY"
```

### 2. Run methods

```bash
# Network overview
swamp model method run eero-home network --json

# List all eero nodes
swamp model method run eero-home eeros --json

# List connected clients with band/signal diagnostics
swamp model method run eero-home clients --json

# Trigger a speed test
swamp model method run eero-home speed-test --json --input '{"trigger": true}'

# Hit any endpoint directly
swamp model method run eero-home api --json \
  --input '{"path": "networks/12345/devices"}'
```

## Client Diagnostics Output

The `clients` method returns detailed WiFi diagnostics for every connected device:

- **Band**: 2.4 GHz, 5 GHz, or 6 GHz frequency
- **Channel**: Active WiFi channel number
- **Signal**: RSSI in dBm (e.g., -40 dBm is strong, -70 dBm is weak)
- **Connected To**: Which eero node the client is associated with
- **Connection Type**: Wireless or wired
- **Manufacturer**: Device manufacturer from MAC OUI

This data is useful for diagnosing band steering failures (devices stuck on 2.4 GHz), weak signal issues (clients connected to a distant node instead of a closer one), and roaming problems (Apple devices with private MAC addresses).

## Known Limitations

- **Amazon SSO**: Accounts created through Amazon cannot authenticate via the API. Add a second admin user through the eero app with a direct email/phone login.
- **Session expiry**: Tokens expire after approximately 30 days. Run `auth-refresh` to get a new token, or re-authenticate with `auth-start`/`auth-verify`.
- **Rate limiting**: The eero API will return HTTP 429 if polled too aggressively. The extension surfaces this as an error.
- **Premium features**: Activity insights, ad blocking, and content filtering require an eero Plus subscription.
- **No local access**: All management goes through eero's cloud at `api-user.e2ro.com`. There is no local management interface on eero hardware.

## API Reference

The eero cloud API at `https://api-user.e2ro.com/2.2` exposes approximately 60 endpoints across account, network, eero node, client device, DNS, DHCP reservation, port forwarding, profile, and firmware management. The `api` passthrough method can reach all of them. See the source code for the full endpoint inventory.

## Testing

Validated against a production eero Pro 6 / Pro 6E mesh network (3 nodes, wired backhaul, bridge mode) running firmware v7.13.5-98.

## License

MIT
