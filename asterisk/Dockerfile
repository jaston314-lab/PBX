FROM debian:12-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    asterisk \
    asterisk-core-sounds-en \
    asterisk-moh-opsound-wav \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

COPY etc/asterisk/pjsip.conf /etc/asterisk/pjsip.conf
COPY etc/asterisk/extensions.conf /etc/asterisk/extensions.conf
COPY etc/asterisk/rtp.conf /etc/asterisk/rtp.conf

EXPOSE 5060/udp
EXPOSE 10000-40000/udp

CMD ["asterisk", "-f", "-vvv"]
