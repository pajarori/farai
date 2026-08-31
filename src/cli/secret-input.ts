export async function readSecretFromStdin(label: string, maxBytes = 64 * 1024): Promise<string> {
  if (process.stdin.isTTY) throw new Error(`${label} expects a secret on stdin`);
  process.stdin.setEncoding("utf8");
  let value = "";
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const text = String(chunk);
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    value += text;
  }
  const secret = value.trim();
  if (!secret) throw new Error(`${label} received an empty secret`);
  return secret;
}
