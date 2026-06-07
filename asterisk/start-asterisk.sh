#!/usr/bin/env bash
set -euo pipefail

: "${PROVIDER_HOST:?PROVIDER_HOST is required}"
: "${PROVIDER_USERNAME:?PROVIDER_USERNAME is required}"
: "${PROVIDER_PASSWORD:?PROVIDER_PASSWORD is required}"

cat > /etc/asterisk/pjsip.conf <<EOF
[global]
type=global
user_agent=OnCall-Asterisk

[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060

[provider-auth]
type=auth
auth_type=userpass
username=${PROVIDER_USERNAME}
password=${PROVIDER_PASSWORD}

[provider-aor]
type=aor
contact=sip:${PROVIDER_HOST}:5060

[provider-outbound]
type=endpoint
transport=transport-udp
context=from-internal
disallow=all
allow=ulaw,alaw
outbound_auth=provider-auth
aors=provider-aor
from_user=${PROVIDER_USERNAME}
from_domain=${PROVIDER_HOST}
trust_id_outbound=yes
send_pai=yes
send_rpid=yes
rpid_immediate=yes
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes

[provider-inbound]
type=endpoint
transport=transport-udp
context=inbound-from-provider
disallow=all
allow=ulaw,alaw
trust_id_inbound=yes
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes

[provider-identify-1]
type=identify
endpoint=provider-inbound
match=34.105.170.20

[provider-identify-2]
type=identify
endpoint=provider-inbound
match=35.242.140.109

[provider-identify-3]
type=identify
endpoint=provider-inbound
match=34.105.214.80

[provider-identify-4]
type=identify
endpoint=provider-inbound
match=34.105.209.181
EOF

exec asterisk -f -vvv
