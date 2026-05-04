# Custom Caddy build with the layer4 module so we can SNI-route + TLS-terminate
# TURNS on :5349 and proxy plaintext TURN-TCP to the app container. Without
# caddy-l4, stock Caddy can't speak non-HTTP TLS.
#
# Caddy version is pinned via ARG; caddy-l4 has no tagged releases so it
# tracks master at build time (cached by GHA scope=voice-hub-caddy until
# this Dockerfile changes). Bump CADDY_VERSION deliberately.

ARG CADDY_VERSION=2.8.4

FROM caddy:${CADDY_VERSION}-builder AS builder
RUN xcaddy build \
    --with github.com/mholt/caddy-l4

FROM caddy:${CADDY_VERSION}-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
