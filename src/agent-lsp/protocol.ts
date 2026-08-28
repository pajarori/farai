export type JsonRpcId = string | number;

export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const HEADER_END = Buffer.from("\r\n\r\n");
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export function encodeJsonRpcMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export class ContentLengthParser {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly onMessage: (message: JsonRpcMessage) => void,
    private readonly onError: (error: Error) => void = () => {}
  ) {}

  push(chunk: Buffer | string): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    try {
      this.drain();
    } catch (error) {
      this.buffer = Buffer.alloc(0);
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private drain(): void {
    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd === -1) {
        if (this.buffer.length > 8 * 1024) throw new Error("LSP header exceeds 8 KB");
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
      if (!match) throw new Error("LSP frame is missing Content-Length");
      const length = Number.parseInt(match[1]!, 10);
      if (!Number.isFinite(length) || length < 0 || length > MAX_FRAME_BYTES) throw new Error("Invalid LSP Content-Length");
      const bodyStart = headerEnd + HEADER_END.length;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      const parsed = JSON.parse(body) as JsonRpcMessage;
      if (parsed.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC version from LSP server");
      this.onMessage(parsed);
    }
  }
}
