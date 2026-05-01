#!/bin/sh
set -e

SRC=/etc/janus/janus.jcfg
DST=/tmp/janus.jcfg

if [ -n "$PUBLIC_IP" ]; then
  sed "s/__PUBLIC_IP__/${PUBLIC_IP}/" "$SRC" > "$DST"
else
  sed '/__PUBLIC_IP__/d' "$SRC" > "$DST"
fi

cp "$DST" "$SRC" 2>/dev/null || {
  mkdir -p /tmp/janus-cfg
  cp /etc/janus/*.jcfg /tmp/janus-cfg/
  cp "$DST" /tmp/janus-cfg/janus.jcfg
  exec /usr/bin/janus -F /tmp/janus-cfg
}

exec /usr/bin/janus -F /etc/janus
