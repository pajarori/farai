#!/bin/bash
set -uo pipefail

chain=FARAI_PROXY
runtime_dir=/run/farai

iptables -t nat -D OUTPUT -p tcp -j "$chain" 2>/dev/null || true
iptables -t nat -F "$chain" 2>/dev/null || true
iptables -t nat -X "$chain" 2>/dev/null || true
iptables -D OUTPUT -p udp --dport 443 -j REJECT 2>/dev/null || true

if [ -s "$runtime_dir/redsocks.pid" ]; then
  kill "$(cat "$runtime_dir/redsocks.pid")" 2>/dev/null || true
  rm -f "$runtime_dir/redsocks.pid"
fi

echo "farai-proxy-init: transparent capture disabled"
