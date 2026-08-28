#!/bin/sh
set -e

proxy_user="${FARAI_PROXY_USER:-mitm}"
chown "$proxy_user:$proxy_user" "$PWD" 2>/dev/null || true

exec setpriv --reuid="$proxy_user" --regid="$proxy_user" --init-groups \
  env HOME=/home/mitm PATH=/opt/uv/bin:/usr/local/bin:/usr/bin:/bin \
  /opt/uv/tools/mitmproxy-mcp/bin/python /usr/local/share/farai/farai_mitmproxy_mcp.py "$@"
