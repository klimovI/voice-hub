FROM golang:1.24-bookworm AS build

WORKDIR /src

COPY backend/go.mod ./
RUN go mod download

COPY backend ./

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/audio-room-app ./cmd/server

FROM debian:bookworm-slim

WORKDIR /app

COPY --from=build /out/audio-room-app /app/audio-room-app
COPY web /app/web

ENV APP_ADDR=:8080
ENV WEB_DIR=/app/web

EXPOSE 8080

CMD ["/app/audio-room-app"]
