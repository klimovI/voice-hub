FROM golang:1.24-bookworm AS build

WORKDIR /src

COPY backend/go.mod ./
RUN go mod download

COPY backend ./

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /out/audio-room-app ./cmd/server

FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -r app && useradd -r -g app -u 10001 -d /app -s /sbin/nologin app

WORKDIR /app

COPY --from=build /out/audio-room-app /app/audio-room-app
COPY web /app/web

ENV APP_ADDR=:8080
ENV WEB_DIR=/app/web

EXPOSE 8080

USER app:app

CMD ["/app/audio-room-app"]
