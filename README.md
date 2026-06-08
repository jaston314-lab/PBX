# VoIP On-Call Router

This project now runs as two services:

- `voip-oncall-router`: web portal, rota engine, and routing API.
- `asterisk-bridge`: SIP ingress and bridged outbound calling via provider trunk.

## Quick Start (Ubuntu VM)

1. Install Docker and Docker Compose plugin on your VM.
2. Clone this repository.
3. Enter the project directory.
4. Run the installer.

```bash
git clone <your-repo-url> pbx
cd pbx
chmod +x install.sh
./install.sh
```

## Updating after changes

```bash
cd pbx
git pull
./install.sh
```

## Environment

Set values in `.env`:

- `ADMIN_USER`
- `ADMIN_PASS`
- `FALLBACK_NUMBER` (UK E.164 format, for example `+447700900000`)
- `ROUTING_API_TOKEN` (long random value used by Asterisk to fetch current target)
- `PROVIDER_HOST` (for example `talk.voipcp.com`)
- `PROVIDER_USERNAME`
- `PROVIDER_PASSWORD`
- `NTP_ENABLED`
- `NTP_SERVER`

## Ports

- Web portal: `8080/tcp`
- SIP listener (Asterisk): `5060/udp`
- RTP media (Asterisk): `10000-40000/udp`

## Cloud firewall recommendation

Allow inbound `5060/udp` only from your SIP provider IPs.
Allow inbound `10000-40000/udp` from your SIP provider RTP IPs.
Restrict `8080/tcp` to your management IP.

## Caller ID forwarding

The Asterisk bridge preserves the inbound caller ID when it dials the on-call
engineer by setting the outbound caller ID plus SIP identity headers
(`P-Asserted-Identity`, `Remote-Party-ID`, and `Diversion`). It also stores the
original called number as `ORIG_DID` for the diversion header. Caller IDs are
normalised to digits-only E.164 on the outbound SIP leg, which is the format many
UK providers expect for CLI screening.

Your SIP provider must allow CLI pass-through / caller ID presentation for
forwarded calls. If Asterisk logs show the correct original caller ID being sent
but the receiving phone still shows the trunk number, the provider is replacing
the CLI and needs to enable pass-through or accept the forwarded-call identity
headers for the trunk.
