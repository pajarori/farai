"""Farai's multi-protocol recorder extension for mitmproxy-mcp 0.6.1."""

from __future__ import annotations

import base64
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from typing import Any

from mitmproxy import dns, http, tcp, udp
from mitmproxy_mcp.core import server


UPSTREAM_TRAFFIC_RECORDER = server.TrafficRecorder


def env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


MAX_BODY_PREVIEW = env_int("FARAI_PROXY_BODY_PREVIEW_BYTES", 65536, 1024, 1024 * 1024)
MAX_MESSAGE_PREVIEW = env_int("FARAI_PROXY_MESSAGE_PREVIEW_BYTES", 16384, 1024, 256 * 1024)
MAX_MESSAGES = env_int("FARAI_PROXY_MAX_MESSAGES", 200, 1, 1000)


class FlowStoreV2:
    def __init__(self, db_path: str):
        self.db_path = db_path
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS farai_flows_v2 (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    timestamp REAL NOT NULL,
                    summary_json TEXT NOT NULL,
                    detail_json TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_farai_flows_v2_timestamp "
                "ON farai_flows_v2(timestamp)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_farai_flows_v2_kind "
                "ON farai_flows_v2(kind)"
            )

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=5, check_same_thread=False)
        conn.execute("PRAGMA busy_timeout = 5000")
        return conn

    def save(self, summary: dict[str, Any], detail: dict[str, Any], timestamp: float) -> None:
        encoded_summary = json.dumps(summary, separators=(",", ":"), ensure_ascii=True)
        encoded_detail = json.dumps(detail, separators=(",", ":"), ensure_ascii=True)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO farai_flows_v2(id, kind, timestamp, summary_json, detail_json)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    kind=excluded.kind,
                    timestamp=excluded.timestamp,
                    summary_json=excluded.summary_json,
                    detail_json=excluded.detail_json
                """,
                (summary["id"], summary["kind"], timestamp, encoded_summary, encoded_detail),
            )

    def summaries(self, limit: int, kind: str | None = None) -> list[dict[str, Any]]:
        bounded_limit = max(1, min(int(limit), 1000))
        sql = "SELECT summary_json FROM farai_flows_v2"
        params: list[Any] = []
        if kind:
            sql += " WHERE kind = ?"
            params.append(kind)
        sql += " ORDER BY timestamp DESC LIMIT ?"
        params.append(bounded_limit)
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [json.loads(row[0]) for row in rows]

    def detail(self, flow_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT detail_json FROM farai_flows_v2 WHERE id = ?", (flow_id,)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def clear(self) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM farai_flows_v2")


class FaraiTrafficRecorder(UPSTREAM_TRAFFIC_RECORDER):
    def __init__(self, scope: Any):
        super().__init__(scope)
        self.v2 = FlowStoreV2(self.db.db_path)

    def request(self, flow: http.HTTPFlow) -> None:
        super().request(flow)
        self._capture(flow)

    def response(self, flow: http.HTTPFlow) -> None:
        super().response(flow)
        self._capture(flow)

    def error(self, flow: http.HTTPFlow) -> None:
        super().error(flow)
        self._capture(flow)

    def websocket_start(self, flow: http.HTTPFlow) -> None:
        self._capture(flow)

    def websocket_message(self, flow: http.HTTPFlow) -> None:
        self._capture(flow)

    def websocket_end(self, flow: http.HTTPFlow) -> None:
        self._capture(flow)

    def tcp_start(self, flow: tcp.TCPFlow) -> None:
        self._capture(flow)

    def tcp_message(self, flow: tcp.TCPFlow) -> None:
        self._capture(flow)

    def tcp_end(self, flow: tcp.TCPFlow) -> None:
        self._capture(flow)

    def tcp_error(self, flow: tcp.TCPFlow) -> None:
        self._capture(flow)

    def udp_start(self, flow: udp.UDPFlow) -> None:
        self._capture(flow)

    def udp_message(self, flow: udp.UDPFlow) -> None:
        self._capture(flow)

    def udp_end(self, flow: udp.UDPFlow) -> None:
        self._capture(flow)

    def udp_error(self, flow: udp.UDPFlow) -> None:
        self._capture(flow)

    def dns_request(self, flow: dns.DNSFlow) -> None:
        self._capture(flow)

    def dns_response(self, flow: dns.DNSFlow) -> None:
        self._capture(flow)

    def dns_error(self, flow: dns.DNSFlow) -> None:
        self._capture(flow)

    def get_flow_summary_v2(self, limit: int = 20, kind: str | None = None) -> list[dict[str, Any]]:
        return self.v2.summaries(limit, kind)

    def get_flow_detail_v2(self, flow_id: str) -> dict[str, Any] | None:
        return self.v2.detail(flow_id)

    def clear(self) -> None:
        super().clear()
        self.v2.clear()

    def _capture(self, flow: Any) -> None:
        try:
            if not self._is_allowed(flow):
                return
            summary, detail, timestamp = serialize_flow(flow)
            self.v2.save(summary, detail, timestamp)
        except Exception as exc:
            print(f"Failed to save Farai v2 flow: {exc}", file=sys.stderr)

    def _is_allowed(self, flow: Any) -> bool:
        if isinstance(flow, http.HTTPFlow):
            return self.scope.is_allowed(flow)
        allowed_domains = self.scope.config.allowed_domains
        if not allowed_domains:
            return True
        candidates = endpoint_hosts(flow)
        if isinstance(flow, dns.DNSFlow) and flow.request:
            candidates.extend(str(question.name) for question in flow.request.questions)
        return any(domain in candidate for domain in allowed_domains for candidate in candidates)


def serialize_flow(flow: Any) -> tuple[dict[str, Any], dict[str, Any], float]:
    if isinstance(flow, http.HTTPFlow):
        if flow.websocket is not None:
            return serialize_websocket(flow)
        return serialize_http(flow)
    if isinstance(flow, tcp.TCPFlow):
        return serialize_stream(flow, "tcp")
    if isinstance(flow, udp.UDPFlow):
        return serialize_stream(flow, "udp")
    if isinstance(flow, dns.DNSFlow):
        return serialize_dns(flow)
    raise TypeError(f"Unsupported mitmproxy flow: {type(flow).__name__}")


def serialize_http(flow: http.HTTPFlow) -> tuple[dict[str, Any], dict[str, Any], float]:
    request = flow.request
    response = flow.response
    timestamp = float(request.timestamp_start or flow.timestamp_start)
    summary = base_http_summary(flow, "http", timestamp)
    detail = {
        **summary,
        "request": http_message(request),
    }
    if response:
        detail["response"] = {
            **http_message(response),
            "status": response.status_code,
            "reason": response.reason,
        }
    return summary, detail, timestamp


def serialize_websocket(flow: http.HTTPFlow) -> tuple[dict[str, Any], dict[str, Any], float]:
    request = flow.request
    response = flow.response
    websocket = flow.websocket
    timestamp = float(request.timestamp_start or flow.timestamp_start)
    messages = [stream_message(message, websocket=True) for message in websocket.messages[-MAX_MESSAGES:]]
    summary = {
        **base_http_summary(flow, "websocket", timestamp),
        "method": "WS",
        "messageCount": len(websocket.messages),
    }
    optional(summary, "closeCode", websocket.close_code)
    optional(summary, "closeReason", websocket.close_reason)
    optional(summary, "closedByClient", websocket.closed_by_client)
    detail = {
        **summary,
        "handshake": {
            "request": http_message(request),
        },
        "messages": messages,
    }
    if response:
        detail["handshake"]["response"] = {
            **http_message(response),
            "status": response.status_code,
            "reason": response.reason,
        }
    return summary, detail, timestamp


def base_http_summary(flow: http.HTTPFlow, kind: str, timestamp: float) -> dict[str, Any]:
    request = flow.request
    response = flow.response
    display_host = http_display_host(request)
    summary: dict[str, Any] = {
        "id": flow.id,
        "kind": kind,
        "timestamp": iso_timestamp(timestamp),
        "method": request.method,
        "url": request.pretty_url,
        "host": display_host,
        "path": request.path,
        "requestBytes": content_size(request),
    }
    if response:
        summary["status"] = response.status_code
        summary["responseBytes"] = content_size(response)
        content_type = response.headers.get("content-type")
        optional(summary, "contentType", content_type)
        if response.timestamp_end and request.timestamp_start:
            summary["durationMs"] = max(0, round((response.timestamp_end - request.timestamp_start) * 1000))
    optional(summary, "error", flow_error(flow))
    return summary


def http_display_host(request: Any) -> str:
    pretty_host = getattr(request, "pretty_host", None)
    if pretty_host:
        return text_value(pretty_host)
    host_header = getattr(request, "host_header", None)
    if not host_header:
        headers = getattr(request, "headers", None)
        host_header = headers.get(":authority") if headers else None
        host_header = host_header or (headers.get("host") if headers else None)
    if host_header:
        authority = text_value(host_header)
        if authority.startswith("["):
            return authority[1:authority.find("]")] if "]" in authority else authority
        return authority.rsplit(":", 1)[0] if authority.count(":") == 1 else authority
    return text_value(getattr(request, "host", "unknown"))


def serialize_stream(flow: tcp.TCPFlow | udp.UDPFlow, kind: str) -> tuple[dict[str, Any], dict[str, Any], float]:
    timestamp = float(flow.timestamp_start or flow.timestamp_created)
    client = endpoint(flow.client_conn, client=True)
    server_endpoint = endpoint(flow.server_conn, client=False)
    host = server_endpoint.get("host", "unknown")
    messages = [stream_message(message) for message in flow.messages[-MAX_MESSAGES:]]
    summary: dict[str, Any] = {
        "id": flow.id,
        "kind": kind,
        "timestamp": iso_timestamp(timestamp),
        "method": kind.upper(),
        "url": f"{kind}://{server_endpoint.get('label', host)}",
        "host": host,
        "path": f"{client.get('label', 'client')} -> {server_endpoint.get('label', host)}",
        "messageCount": len(flow.messages),
        "requestBytes": sum(byte_size(message.content) for message in flow.messages if message.from_client),
        "responseBytes": sum(byte_size(message.content) for message in flow.messages if not message.from_client),
    }
    if kind == "tcp":
        summary["tls"] = bool(getattr(flow.server_conn, "tls_established", False))
    else:
        summary["dtls"] = bool(getattr(flow.server_conn, "tls_established", False))
    optional(summary, "error", flow_error(flow))
    detail = {**summary, "client": client, "server": server_endpoint, "messages": messages}
    return summary, detail, timestamp


def serialize_dns(flow: dns.DNSFlow) -> tuple[dict[str, Any], dict[str, Any], float]:
    timestamp = float(flow.timestamp_start or flow.timestamp_created)
    request = dns_message(flow.request) if flow.request else None
    response = dns_message(flow.response) if flow.response else None
    questions = request.get("questions", []) if request else []
    first_question = questions[0] if questions else {}
    query_name = str(first_question.get("name", "unknown"))
    query_type = first_question.get("type")
    answers = response.get("answers", []) if response else []
    summary: dict[str, Any] = {
        "id": flow.id,
        "kind": "dns",
        "timestamp": iso_timestamp(timestamp),
        "method": "DNS",
        "url": f"dns://{query_name}",
        "host": query_name,
        "path": str(query_type or "query"),
        "queryName": query_name,
        "answerCount": len(answers),
    }
    optional(summary, "queryType", query_type)
    if response:
        optional(summary, "responseCode", response.get("responseCode"))
    optional(summary, "error", flow_error(flow))
    detail: dict[str, Any] = {
        **summary,
        "client": endpoint(flow.client_conn, client=True),
        "server": endpoint(flow.server_conn, client=False),
        "request": request or empty_dns_message(True),
    }
    if response:
        detail["response"] = response
    return summary, detail, timestamp


def http_message(message: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "headers": header_pairs(message.headers),
        "bodyBytes": content_size(message),
    }
    optional(result, "httpVersion", getattr(message, "http_version", None))
    result.update(content_preview(getattr(message, "raw_content", None), MAX_BODY_PREVIEW, "body"))
    return result


def stream_message(message: Any, websocket: bool = False) -> dict[str, Any]:
    content = getattr(message, "content", b"")
    message_type = enum_name(getattr(message, "type", None)) if websocket else None
    result: dict[str, Any] = {
        "direction": "client" if message.from_client else "server",
        "timestamp": iso_timestamp(float(message.timestamp)),
        "contentBytes": byte_size(content),
    }
    optional(result, "messageType", message_type)
    result.update(
        content_preview(
            content,
            MAX_MESSAGE_PREVIEW,
            "content",
            force_binary=message_type == "binary",
        )
    )
    if getattr(message, "dropped", False):
        result["dropped"] = True
    if getattr(message, "injected", False):
        result["injected"] = True
    return result


def dns_message(message: Any) -> dict[str, Any]:
    raw = message.to_json() if callable(getattr(message, "to_json", None)) else {}
    result = {
        "id": int(message.id),
        "query": bool(message.query),
        "responseCode": int(message.response_code),
        "questions": [dns_question(question, raw_item(raw, "questions", index)) for index, question in enumerate(message.questions)],
        "answers": [dns_record(record, raw_item(raw, "answers", index)) for index, record in enumerate(message.answers)],
        "authorities": [dns_record(record, raw_item(raw, "authorities", index)) for index, record in enumerate(message.authorities)],
        "additionals": [dns_record(record, raw_item(raw, "additionals", index)) for index, record in enumerate(message.additionals)],
    }
    return result


def dns_question(question: Any, raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": text_value(raw.get("name", question.name)),
        "type": text_value(raw.get("type", question.type)),
        "class": text_value(raw.get("class", raw.get("class_", question.class_))),
    }


def dns_record(record: Any, raw: dict[str, Any]) -> dict[str, Any]:
    result = {
        "name": text_value(raw.get("name", record.name)),
        "type": text_value(raw.get("type", record.type)),
        "class": text_value(raw.get("class", raw.get("class_", record.class_))),
        "ttl": int(record.ttl),
    }
    optional(result, "data", raw.get("data", text_value(record.data)))
    return result


def content_preview(content: Any, limit: int, prefix: str, force_binary: bool = False) -> dict[str, Any]:
    if content is None:
        return {}
    if isinstance(content, str):
        encoded = content.encode("utf-8")
        preview = encoded[:limit].decode("utf-8", errors="replace")
        result = {f"{prefix}Text": preview}
        if len(encoded) > limit:
            result[f"{prefix}Truncated" if prefix == "body" else "truncated"] = True
        return result
    raw = bytes(content)
    preview = raw[:limit]
    if not force_binary and is_readable_utf8(preview):
        result = {f"{prefix}Text": preview.decode("utf-8", errors="replace")}
    else:
        result = {f"{prefix}Base64": base64.b64encode(preview).decode("ascii")}
    if len(raw) > limit:
        result[f"{prefix}Truncated" if prefix == "body" else "truncated"] = True
    return result


def header_pairs(headers: Any) -> list[list[str]]:
    fields = getattr(headers, "fields", [])
    return [[text_value(name, "latin-1"), text_value(value, "latin-1")] for name, value in fields]


def endpoint(connection: Any, client: bool) -> dict[str, Any]:
    candidates = [
        getattr(connection, "peername", None),
        getattr(connection, "address", None),
        getattr(connection, "sockname", None),
    ]
    address = next((candidate for candidate in candidates if candidate), None)
    if isinstance(address, (tuple, list)) and address:
        host = text_value(address[0])
        port = address[1] if len(address) > 1 and isinstance(address[1], int) else None
    elif address:
        host, port = text_value(address), None
    else:
        host, port = ("client" if client else "server"), None
    return {
        "host": host,
        **({"port": port} if port is not None else {}),
        "label": f"{host}:{port}" if port is not None else host,
    }


def endpoint_hosts(flow: Any) -> list[str]:
    return [
        endpoint(flow.client_conn, client=True)["host"],
        endpoint(flow.server_conn, client=False)["host"],
    ]


def raw_item(raw: Any, field: str, index: int) -> dict[str, Any]:
    items = raw.get(field, []) if isinstance(raw, dict) else []
    return items[index] if index < len(items) and isinstance(items[index], dict) else {}


def empty_dns_message(query: bool) -> dict[str, Any]:
    return {"query": query, "questions": [], "answers": [], "authorities": [], "additionals": []}


def content_size(message: Any) -> int:
    return byte_size(getattr(message, "raw_content", None))


def byte_size(content: Any) -> int:
    if content is None:
        return 0
    return len(content.encode("utf-8")) if isinstance(content, str) else len(bytes(content))


def is_readable_utf8(content: bytes) -> bool:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return all(character.isprintable() or character in "\r\n\t" for character in text)


def enum_name(value: Any) -> str | None:
    if value is None:
        return None
    name = getattr(value, "name", None)
    return str(name).lower() if name else str(value).lower()


def flow_error(flow: Any) -> str | None:
    error = getattr(flow, "error", None)
    if error is None:
        return None
    return text_value(getattr(error, "msg", error))


def text_value(value: Any, encoding: str = "utf-8") -> str:
    if isinstance(value, bytes):
        return value.decode(encoding, errors="replace")
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=True)
    return str(value)


def iso_timestamp(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def optional(target: dict[str, Any], key: str, value: Any) -> None:
    if value is not None and value != "":
        target[key] = value


@server.mcp.tool()
async def get_flow_summary_v2(limit: int = 20, kind: str | None = None) -> str:
    """Return HTTP, WebSocket, TCP, UDP, and DNS flow summaries."""
    recorder = server.controller.recorder
    if not isinstance(recorder, FaraiTrafficRecorder):
        return "[]"
    return json.dumps(recorder.get_flow_summary_v2(limit, kind), indent=2)


@server.mcp.tool()
async def inspect_flow_v2(flow_id: str) -> str:
    """Return protocol-aware detail for a captured flow."""
    recorder = server.controller.recorder
    if not isinstance(recorder, FaraiTrafficRecorder):
        return "Couldn't find that flow."
    detail = recorder.get_flow_detail_v2(flow_id)
    return json.dumps(detail, indent=2) if detail else "Couldn't find that flow."


server.TrafficRecorder = FaraiTrafficRecorder


if __name__ == "__main__":
    server.start()
