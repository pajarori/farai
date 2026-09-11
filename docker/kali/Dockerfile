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
ARG INTERACTSH_VERSION=1.3.1
ARG TYPESCRIPT_VERSION=5.9.3
ARG TYPESCRIPT_LANGUAGE_SERVER_VERSION=4.3.4
ARG PYRIGHT_VERSION=1.1.408

COPY farai-tool-manifest.json /usr/local/share/farai/farai-tool-manifest.json

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3-minimal \
  && python3 -c 'import json, subprocess; manifest=json.load(open("/usr/local/share/farai/farai-tool-manifest.json", encoding="utf-8")); subprocess.run(["apt-get", "install", "-y", "--no-install-recommends", *manifest["aptPackages"]], check=True)' \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  case "${TARGETARCH:-amd64}" in \
    amd64) \
      pd_arch=amd64; \
      interactsh_arch=amd64; interactsh_sha=d553fb3dd4c2684c953aedeb555f13f0d1ca94bd75112c949a5fd975d385a903 ;; \
    arm64) \
      pd_arch=arm64; \
      interactsh_arch=arm64; interactsh_sha=475aa78c59afad115149a5b0d6d9c99d2410a4f12d0c6f5a24c32e7338fc6adb ;; \
    *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  install_pd() { \
    tool="$1"; \
    version="$(python3 -c 'import json,sys; print(json.load(open("/usr/local/share/farai/farai-tool-manifest.json", encoding="utf-8"))["pinnedTools"][sys.argv[1]]["version"])' "${tool}")"; \
    checksum="$(python3 -c 'import json,sys; print(json.load(open("/usr/local/share/farai/farai-tool-manifest.json", encoding="utf-8"))["pinnedTools"][sys.argv[1]]["sha256"][sys.argv[2]])' "${tool}" "${pd_arch}")"; \
    archive="/tmp/${tool}.zip"; \
    directory="/tmp/${tool}"; \
    curl -fsSL "https://github.com/projectdiscovery/${tool}/releases/download/v${version}/${tool}_${version}_linux_${pd_arch}.zip" -o "${archive}"; \
    echo "${checksum}  ${archive}" | sha256sum -c -; \
    mkdir -p "${directory}"; \
    unzip -q "${archive}" -d "${directory}"; \
    install -m 0755 "${directory}/${tool}" "/usr/local/bin/${tool}"; \
  }; \
  for tool in dnsx httpx katana naabu nuclei subfinder tlsx urlfinder vulnx; do install_pd "${tool}"; done; \
  curl -fsSL "https://github.com/projectdiscovery/interactsh/releases/download/v${INTERACTSH_VERSION}/interactsh-client_${INTERACTSH_VERSION}_linux_${interactsh_arch}.zip" -o /tmp/interactsh.zip; \
  echo "${interactsh_sha}  /tmp/interactsh.zip" | sha256sum -c -; \
  unzip -q /tmp/interactsh.zip -d /tmp/interactsh; \
  install -m 0755 /tmp/interactsh/interactsh-client /usr/local/bin/interactsh-client; \
  templates_version="$(python3 -c 'import json; print(json.load(open("/usr/local/share/farai/farai-tool-manifest.json", encoding="utf-8"))["pinnedAssets"]["nuclei-templates"]["version"])')"; \
  templates_checksum="$(python3 -c 'import json; print(json.load(open("/usr/local/share/farai/farai-tool-manifest.json", encoding="utf-8"))["pinnedAssets"]["nuclei-templates"]["sha256"])')"; \
  curl -fsSL "https://github.com/projectdiscovery/nuclei-templates/archive/refs/tags/v${templates_version}.zip" -o /tmp/nuclei-templates.zip; \
  echo "${templates_checksum}  /tmp/nuclei-templates.zip" | sha256sum -c -; \
  unzip -q /tmp/nuclei-templates.zip -d /tmp/nuclei-templates; \
  mkdir -p /usr/local/share/farai/nuclei-templates; \
  cp -a "/tmp/nuclei-templates/nuclei-templates-${templates_version}/." /usr/local/share/farai/nuclei-templates/; \
  rm -rf /tmp/dnsx /tmp/httpx /tmp/katana /tmp/naabu /tmp/nuclei /tmp/subfinder /tmp/tlsx /tmp/urlfinder /tmp/vulnx /tmp/interactsh /tmp/nuclei-templates \
    /tmp/dnsx.zip /tmp/httpx.zip /tmp/katana.zip /tmp/naabu.zip /tmp/nuclei.zip /tmp/subfinder.zip /tmp/tlsx.zip /tmp/urlfinder.zip /tmp/vulnx.zip /tmp/interactsh.zip /tmp/nuclei-templates.zip

RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
  && ln -sf /root/.local/bin/uv /usr/local/bin/uv \
  && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx

RUN UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/opt/uv/bin uv tool install --with 'mcp>=1.25.0,<2' mitmproxy-mcp==0.6.1 \
  && chmod -R a+rX /opt/uv \
  && npm install -g \
    typescript@${TYPESCRIPT_VERSION} \
    typescript-language-server@${TYPESCRIPT_LANGUAGE_SERVER_VERSION} \
    pyright@${PYRIGHT_VERSION} \
  && uv cache clean \
  && npm cache clean --force

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

RUN mkdir -p /opt/playwright-mcp \
  && printf '%s' '{"name":"farai-playwright-mcp","private":true,"dependencies":{"@playwright/mcp":"latest","patchright":"latest"},"overrides":{"playwright":"npm:patchright@latest","playwright-core":"npm:patchright-core@latest"}}' > /opt/playwright-mcp/package.json \
  && cd /opt/playwright-mcp \
  && npm install --omit=dev --no-audit --no-fund \
  && if [ -e node_modules/.bin/mcp-server-playwright ]; then ln -sf /opt/playwright-mcp/node_modules/.bin/mcp-server-playwright /usr/local/bin/playwright-mcp; else ln -sf /opt/playwright-mcp/node_modules/@playwright/mcp/cli.js /usr/local/bin/playwright-mcp; fi \
  && node_modules/.bin/patchright install --with-deps chromium \
  && chmod -R a+rX /opt/ms-playwright /opt/playwright-mcp \
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

ENV PIP_BREAK_SYSTEM_PACKAGES=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    apktool jadx dex2jar adb aapt apksigner \
    fcrackzip stegseek hashid python3-pwntools proxychains4 \
    ruby ruby-dev \
    cmake ninja-build pkg-config libicu-dev libcapstone-dev libunicorn-dev \
    clang automake autoconf libtool libgmp-dev libmpc-dev libmpfr-dev libssl-dev libffi-dev \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN export GOBIN=/usr/local/bin GOFLAGS=-buildvcs=false GOSUMDB=off \
  && go install github.com/lc/gau/v2/cmd/gau@latest \
  && go install github.com/tomnomnom/waybackurls@latest \
  && go install github.com/jaeles-project/gospider@latest \
  && go install github.com/hakluke/hakrawler@latest \
  && go install github.com/sensepost/gowitness@latest \
  && go install github.com/projectdiscovery/notify/cmd/notify@latest \
  && go install github.com/tomnomnom/anew@latest \
  && go install github.com/tomnomnom/qsreplace@latest \
  && go install github.com/tomnomnom/unfurl@latest \
  && go install github.com/zricethezav/gitleaks/v8@latest \
  && rm -rf /root/go/pkg /root/.cache/go-build

RUN curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh | sh -s -- -b /usr/local/bin

RUN gem install --no-document -n /usr/local/bin one_gadget zsteg

ENV PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin

RUN pipx install ROPgadget \
  && pipx install apkleaks \
  && pipx install git-dumper \
  && chmod -R a+rX /opt/pipx

RUN pipx install git+https://github.com/RsaCtfTool/RsaCtfTool.git \
  && chmod -R a+rX /opt/pipx \
  || echo "[warn] RsaCtfTool install skipped"

RUN git clone --depth 1 https://github.com/hugsy/gef.git /opt/gef \
  && echo "source /opt/gef/gef.py" >> /root/.gdbinit

RUN git clone --depth 1 https://github.com/ticarpi/jwt_tool.git /opt/jwt_tool \
  && pip install termcolor cprint pycryptodomex requests ratelimit \
  && printf '#!/bin/sh\nexec python3 /opt/jwt_tool/jwt_tool.py "$@"\n' > /usr/local/bin/jwt_tool \
  && chmod 0755 /usr/local/bin/jwt_tool

RUN git clone --depth 1 https://github.com/worawit/blutter.git /opt/blutter \
  && pip install pyelftools requests \
  && printf '#!/bin/sh\nexec python3 /opt/blutter/blutter.py "$@"\n' > /usr/local/bin/blutter \
  && chmod 0755 /usr/local/bin/blutter

RUN git clone --depth 1 https://github.com/danielmiessler/SecLists.git /usr/share/seclists

RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb xauth \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY redsocks.conf.tmpl /usr/local/share/farai/redsocks.conf.tmpl
COPY farai-proxy-init.sh /usr/local/bin/farai-proxy-init
COPY farai-proxy-teardown.sh /usr/local/bin/farai-proxy-teardown
COPY farai-mitmproxy-mcp.sh /usr/local/bin/mitmproxy-mcp
COPY farai_mitmproxy_mcp.py /usr/local/share/farai/farai_mitmproxy_mcp.py
COPY farai-image-doctor.py /usr/local/bin/farai-image-doctor
COPY farai-image-contract /usr/local/share/farai/farai-image-contract
RUN chmod 0755 /usr/local/bin/farai-proxy-init /usr/local/bin/farai-proxy-teardown /usr/local/bin/mitmproxy-mcp /usr/local/bin/farai-image-doctor \
  && farai-image-doctor --write /usr/local/share/farai/kali-capabilities.json

ENV NODE_EXTRA_CA_CERTS=/usr/local/share/farai/farai-mitmproxy-ca.pem \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt

WORKDIR /workspace

ARG KALI_CONTRACT=curated-security-runtime-2026-10
LABEL org.farai.kali.contract="${KALI_CONTRACT}"
