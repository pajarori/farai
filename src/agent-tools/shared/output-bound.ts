export function takeBytes(value: string, max: number, side: "head" | "tail"): string {
  const chars = Array.from(value);
  let bytes = 0;
  const selected: string[] = [];
  const iterable = side === "head" ? chars : chars.reverse();
  for (const char of iterable) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > max) break;
    bytes += size;
    if (side === "head") selected.push(char);
    else selected.unshift(char);
  }
  return selected.join("");
}
