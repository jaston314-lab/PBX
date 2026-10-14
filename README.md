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
- `INTEGRATION_API_TOKEN` (long random value Archer Hub uses to read the rota and
  set overrides; leave blank to disable)
- `PROVIDER_HOST` (for example `talk.voipcp.com`)
- `PROVIDER_USERNAME`
- `PROVIDER_PASSWORD`
- `PROVIDER_FROM_USER` (deprecated — no longer used; the original caller ID is
  passed through in the `From` header automatically)
- `NTP_ENABLED`
- `NTP_SERVER`

## Ports

- Web portal: `8080/tcp`
- SIP listener (Asterisk): `5070/udp`
- RTP media (Asterisk): `10000-40000/udp`

## Cloud firewall recommendation

Allow inbound `5070/udp` only from your SIP provider IPs.
Allow inbound `10000-40000/udp` from your SIP provider RTP IPs.
Restrict `8080/tcp` to your management IP.

## Caller ID forwarding

The Asterisk bridge preserves the inbound caller ID when it dials the on-call
engineer by setting the outbound caller ID plus SIP identity headers
(`P-Asserted-Identity`, `Remote-Party-ID`, and `Diversion`). It also stores the
original called number as `ORIG_DID` for the diversion header. Caller IDs are
preserved in `+44` format on the outbound SIP leg by default.

Your SIP provider must allow CLI pass-through / caller ID presentation for
forwarded calls. If Asterisk logs show the correct original caller ID being sent
but the receiving phone still shows the trunk number, the provider is replacing
the CLI and needs to enable pass-through or accept the forwarded-call identity
headers for the trunk.

To confirm what Asterisk actually sends to the provider, enable SIP packet
logging before a test call:

```bash
docker exec -it asterisk-bridge asterisk -rvvv
pjsip set logger on
```

Then check the outbound `INVITE` for `From`, `P-Asserted-Identity`,
`Remote-Party-ID`, and `Diversion`. If those contain the original caller ID but
the receiving phone still shows the trunk number, the provider is rewriting the
CLI after Asterisk sends the call.

## Archer Hub integration

Archer Hub uses `INTEGRATION_API_TOKEN` (sent as `Authorization: Bearer <token>`
or `X-Api-Token`) instead of the admin login. The token only reaches these
endpoints:

- `GET /api/engineers`, `GET /api/time`
- `GET /api/rota/*`: including `GET /api/rota/days?from=YYYY-MM-DD&to=YYYY-MM-DD`
  (up to 120 days) and `GET /api/rota/current` (who is on call now and the number
  calls are going to)
- `PUT /api/rota/override/*`: including `PUT /api/rota/override/days`, which sets
  or clears several days in one transaction:
  `{ "changes": [{ "date": "2026-10-20", "engineer_id": 2 }], "note": "...", "updated_by": "..." }`
  (`engineer_id: null` puts the day back to the normal rota)

Each override records `note`, `updated_by` and `updated_at`. Changes made in this
portal are recorded as `portal`.

Allow the Archer Hub server's address through the firewall to `8080/tcp`.
