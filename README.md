# VoIP On-Call Router

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
- `NTP_ENABLED`
- `NTP_SERVER`

## Ports

- Web portal: `8080/tcp`
- SIP listener: `5060/udp`

## Cloud firewall recommendation

Allow inbound `5060/udp` only from your SIP provider IPs.
Restrict `8080/tcp` to your management IP.
