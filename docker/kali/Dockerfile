ARG GO_VERSION=1.25.0
ARG GOPLS_VERSION=v0.20.0
ARG RUST_ANALYZER_VERSION=2025-08-25

FROM golang:${GO_VERSION}-bookworm AS lsp-builder
ARG GOPLS_VERSION
ARG RUST_ANALYZER_VERSION
ARG TARGETARCH
RUN mkdir -p /out \
  && GOBIN=/out go install golang.org/x/tools/gopls@${GOPLS_VERSION}

RUN set -eux; \
  case "${TARGETARCH:-amd64}" in \
    amd64) rust_analyzer_arch=x86_64; rust_analyzer_sha=487fb1cb99e567fd6b818cc88a7c1452d5260da57dbc171fc1359a4b604348ae ;; \
    arm64) rust_analyzer_arch=aarch64; rust_analyzer_sha=c738e00a5caa712f9d9c8f81f9661884c7108ef94db6df48985c11fe3c2695bd ;; \
    *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/rust-lang/rust-analyzer/releases/download/${RUST_ANALYZER_VERSION}/rust-analyzer-${rust_analyzer_arch}-unknown-linux-gnu.gz" -o /tmp/rust-analyzer.gz; \
  echo "${rust_analyzer_sha}  /tmp/rust-analyzer.gz" | sha256sum -c -; \
  gzip -dc /tmp/rust-analyzer.gz >/out/rust-analyzer; \
  chmod 0755 /out/rust-analyzer; \
  /out/rust-analyzer --version; \
  rm -f /tmp/rust-analyzer.gz

FROM kalilinux/kali-rolling

ENV DEBIAN_FRONTEND=noninteractive

ARG TARGETARCH
ARG NAABU_VERSION=2.6.1
ARG INTERACTSH_VERSION=1.3.1
ARG TYPESCRIPT_VERSION=5.9.3
ARG TYPESCRIPT_LANGUAGE_SERVER_VERSION=4.3.4
ARG PYRIGHT_VERSION=1.1.408

LABEL org.farai.kali.contract="curated-security-runtime"

COPY farai-tool-manifest.json /usr/local/share/farai/farai-tool-manifest.json

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3-minimal \
  && python3 -c 'import json, subprocess; manifest=json.load(open("/usr/local/share/farai/farai-tool-manifest.json", encoding="utf-8")); subprocess.run(["apt-get", "install", "-y", "--no-install-recommends", *manifest["aptPackages"]], check=True)' \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  case "${TARGETARCH:-amd64}" in \
    amd64) \
      naabu_arch=amd64; naabu_sha=018c4c9884dea971eda860435ede3021d1150732f34cfd245498c6726d8cab90; \
      interactsh_arch=amd64; interactsh_sha=d553fb3dd4c2684c953aedeb555f13f0d1ca94bd75112c949a5fd975d385a903 ;; \
    arm64) \
      naabu_arch=arm64; naabu_sha=3adc2bb2395c3efff89623499b20eea66ef54924c485d3ae86762393a31736ea; \
      interactsh_arch=arm64; interactsh_sha=475aa78c59afad115149a5b0d6d9c99d2410a4f12d0c6f5a24c32e7338fc6adb ;; \
    *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/projectdiscovery/naabu/releases/download/v${NAABU_VERSION}/naabu_${NAABU_VERSION}_linux_${naabu_arch}.zip" -o /tmp/naabu.zip; \
  echo "${naabu_sha}  /tmp/naabu.zip" | sha256sum -c -; \
  unzip -q /tmp/naabu.zip -d /tmp/naabu; \
  install -m 0755 /tmp/naabu/naabu /usr/local/bin/naabu; \
  curl -fsSL "https://github.com/projectdiscovery/interactsh/releases/download/v${INTERACTSH_VERSION}/interactsh-client_${INTERACTSH_VERSION}_linux_${interactsh_arch}.zip" -o /tmp/interactsh.zip; \
  echo "${interactsh_sha}  /tmp/interactsh.zip" | sha256sum -c -; \
  unzip -q /tmp/interactsh.zip -d /tmp/interactsh; \
  install -m 0755 /tmp/interactsh/interactsh-client /usr/local/bin/interactsh-client; \
  rm -rf /tmp/naabu /tmp/interactsh /tmp/naabu.zip /tmp/interactsh.zip

RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
  && ln -sf /root/.local/bin/uv /usr/local/bin/uv \
  && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx

RUN UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/opt/uv/bin uv tool install --with fastmcp mitmproxy-mcp==0.6.1 \
  && chmod -R a+rX /opt/uv \
  && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g \
    @playwright/mcp@latest \
    typescript@${TYPESCRIPT_VERSION} \
    typescript-language-server@${TYPESCRIPT_LANGUAGE_SERVER_VERSION} \
    pyright@${PYRIGHT_VERSION} \
  && uv cache clean \
  && npm cache clean --force

COPY --from=lsp-builder /out/gopls /usr/local/bin/gopls
COPY --from=lsp-builder /out/rust-analyzer /usr/local/bin/rust-analyzer

RUN useradd --system --create-home --home-dir /home/mitm --shell /usr/sbin/nologin mitm \
  && mkdir -p /home/mitm/.mitmproxy /usr/local/share/farai \
  && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout /tmp/farai-ca-key.pem -out /tmp/farai-ca-cert.pem \
    -subj "/CN=farai mitmproxy/O=farai" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
  && cat /tmp/farai-ca-key.pem /tmp/farai-ca-cert.pem >/home/mitm/.mitmproxy/mitmproxy-ca.pem \
  && cp /tmp/farai-ca-cert.pem /home/mitm/.mitmproxy/mitmproxy-ca-cert.pem \
  && cp /tmp/farai-ca-cert.pem /usr/local/share/ca-certificates/farai-mitmproxy.crt \
  && cp /tmp/farai-ca-cert.pem /usr/local/share/farai/farai-mitmproxy-ca.pem \
  && rm -f /tmp/farai-ca-key.pem /tmp/farai-ca-cert.pem \
  && chown -R mitm:mitm /home/mitm \
  && chmod 700 /home/mitm/.mitmproxy \
  && update-ca-certificates \
  && mkdir -p /root/.pki/nssdb \
  && certutil -d sql:/root/.pki/nssdb -N --empty-password \
  && certutil -d sql:/root/.pki/nssdb -A -n farai-mitmproxy -t "C,," -i /usr/local/share/farai/farai-mitmproxy-ca.pem

COPY redsocks.conf.tmpl /usr/local/share/farai/redsocks.conf.tmpl
COPY farai-proxy-init.sh /usr/local/bin/farai-proxy-init
COPY farai-proxy-teardown.sh /usr/local/bin/farai-proxy-teardown
COPY farai-mitmproxy-mcp.sh /usr/local/bin/mitmproxy-mcp
COPY farai_mitmproxy_mcp.py /usr/local/share/farai/farai_mitmproxy_mcp.py
COPY farai-image-doctor.py /usr/local/bin/farai-image-doctor
RUN chmod 0755 /usr/local/bin/farai-proxy-init /usr/local/bin/farai-proxy-teardown /usr/local/bin/mitmproxy-mcp /usr/local/bin/farai-image-doctor \
  && farai-image-doctor --write /usr/local/share/farai/kali-capabilities.json

ENV NODE_EXTRA_CA_CERTS=/usr/local/share/farai/farai-mitmproxy-ca.pem \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt

WORKDIR /workspace
