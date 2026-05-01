#!/bin/sh
set -e

CFG=/etc/janus/janus.jcfg

if [ -n "$PUBLIC_IP" ]; then
  sed -i "s/__PUBLIC_IP__/${PUBLIC_IP}/" "$CFG"
else
  sed -i '/__PUBLIC_IP__/d' "$CFG"
fi

exec /usr/bin/janus -F /etc/janus
