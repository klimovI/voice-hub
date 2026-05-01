FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends janus ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY deploy/janus/janus.jcfg /etc/janus/janus.jcfg
COPY deploy/janus/janus.transport.websockets.jcfg /etc/janus/janus.transport.websockets.jcfg
COPY deploy/janus/janus.plugin.videoroom.jcfg /etc/janus/janus.plugin.videoroom.jcfg
COPY deploy/janus/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8188
EXPOSE 10000-10100/udp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
