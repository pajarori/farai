#!/bin/bash
set -euo pipefail

proxy_port="${FARAI_PROXY_PORT:-31337}"
redsocks_port="${FARAI_REDSOCKS_PORT:-31338}"
tcp_ports="${FARAI_PROXY_TCP_PORTS:-80,443,3000,5000,8000,8008,8080,8081,8443,8888,9000}"
proxy_user="${FARAI_PROXY_USER:-mitm}"
runtime_dir=/run/farai
chain=FARAI_PROXY

mkdir -p "$runtime_dir"

proxy_listening() {
  (exec 3<>"/dev/tcp/127.0.0.1/$proxy_port") 2>/dev/null || return 1
  exec 3>&- 3<&-
  return 0
}

attempts=0
until proxy_listening; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 60 ]; then
    echo "farai-proxy-init: no proxy listening on 127.0.0.1:$proxy_port" >&2
    exit 1
  fi
  sleep 0.5
done

if ! [ -s "$runtime_dir/redsocks.pid" ] || ! kill -0 "$(cat "$runtime_dir/redsocks.pid")" 2>/dev/null; then
  sed -e "s/__LOCAL_PORT__/$redsocks_port/" -e "s/__PROXY_PORT__/$proxy_port/" \
    /usr/local/share/farai/redsocks.conf.tmpl >"$runtime_dir/redsocks.conf"
  redsocks -c "$runtime_dir/redsocks.conf" -p "$runtime_dir/redsocks.pid"
fi

iptables -t nat -N "$chain" 2>/dev/null || true
iptables -t nat -F "$chain"
iptables -t nat -A "$chain" -d 127.0.0.0/8 -j RETURN
iptables -t nat -A "$chain" -m owner --uid-owner "$proxy_user" -j RETURN
iptables -t nat -A "$chain" -p tcp -m multiport --dports "$tcp_ports" -j REDIRECT --to-ports "$redsocks_port"
iptables -t nat -C OUTPUT -p tcp -j "$chain" 2>/dev/null || iptables -t nat -A OUTPUT -p tcp -j "$chain"
iptables -C OUTPUT -p udp --dport 443 -j REJECT 2>/dev/null || iptables -A OUTPUT -p udp --dport 443 -j REJECT

echo "farai-proxy-init: transparent capture active on tcp $tcp_ports via 127.0.0.1:$proxy_port"
