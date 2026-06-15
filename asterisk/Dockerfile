FROM ubuntu:22.04

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    asterisk \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

COPY etc/asterisk/pjsip.conf /etc/asterisk/pjsip.conf
COPY etc/asterisk/extensions.conf /etc/asterisk/extensions.conf
COPY etc/asterisk/rtp.conf /etc/asterisk/rtp.conf
COPY start-asterisk.sh /usr/local/bin/start-asterisk.sh

RUN chmod +x /usr/local/bin/start-asterisk.sh

EXPOSE 5070/udp
EXPOSE 10000-40000/udp

CMD ["/usr/local/bin/start-asterisk.sh"]
