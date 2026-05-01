FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends janus ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r janus2 && useradd -r -g janus2 -u 10002 -d /var/lib/janus -s /sbin/nologin janus2

COPY deploy/janus/janus.jcfg /etc/janus/janus.jcfg
COPY deploy/janus/janus.transport.websockets.jcfg /etc/janus/janus.transport.websockets.jcfg
COPY deploy/janus/janus.plugin.videoroom.jcfg /etc/janus/janus.plugin.videoroom.jcfg
COPY deploy/janus/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
  && chown -R janus2:janus2 /etc/janus

EXPOSE 8188
EXPOSE 10000-10100/udp

USER janus2:janus2

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
