type BunWidthRuntime = {
  stringWidth?: (text: string) => number;
  stripANSI?: (text: string) => string;
};

const ANSI_SEQUENCE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

export function terminalWidth(value: string): number {
  if (!value) return 0;
  const bun = (globalThis as typeof globalThis & { Bun?: BunWidthRuntime }).Bun;
  if (typeof bun?.stringWidth === "function") {
    try {
      return bun.stringWidth(value);
    } catch {
    }
  }
  return fallbackTerminalWidth(value);
}

export function truncateTerminal(value: string, width: number, ellipsis = "…"): string {
  const available = Math.max(0, Math.floor(width));
  if (available === 0) return "";
  const plain = stripAnsi(value);
  if (terminalWidth(plain) <= available) return plain;

  const ellipsisWidth = terminalWidth(ellipsis);
  if (ellipsisWidth >= available) return clipTerminal(ellipsis, available);
  const clipped = clipTerminal(plain, available - ellipsisWidth).trimEnd();
  return `${clipped}${ellipsis}`;
}

export function clipTerminal(value: string, width: number): string {
  const available = Math.max(0, Math.floor(width));
  if (available === 0 || !value) return "";

  let used = 0;
  let result = "";
  for (const grapheme of graphemes(stripAnsi(value))) {
    const graphemeWidth = terminalWidth(grapheme);
    if (used + graphemeWidth > available) break;
    result += grapheme;
    used += graphemeWidth;
  }
  return result;
}

export function padTerminalEnd(value: string, width: number): string {
  const missing = Math.max(0, Math.floor(width) - terminalWidth(value));
  return `${value}${" ".repeat(missing)}`;
}

export function padTerminalStart(value: string, width: number): string {
  const missing = Math.max(0, Math.floor(width) - terminalWidth(value));
  return `${" ".repeat(missing)}${value}`;
}

export function fitTerminal(value: string, width: number): string {
  const available = Math.max(0, Math.floor(width));
  return padTerminalEnd(truncateTerminal(value, available), available);
}

function graphemes(value: string): string[] {
  if (!GRAPHEME_SEGMENTER) return Array.from(value);
  return Array.from(GRAPHEME_SEGMENTER.segment(value), (part) => part.segment);
}

function fallbackTerminalWidth(value: string): number {
  const plain = stripAnsi(value);
  let width = 0;
  for (const grapheme of graphemes(plain)) width += fallbackGraphemeWidth(grapheme);
  return width;
}

function stripAnsi(value: string): string {
  const bun = (globalThis as typeof globalThis & { Bun?: BunWidthRuntime }).Bun;
  if (typeof bun?.stripANSI === "function") {
    try {
      return bun.stripANSI(value);
    } catch {
    }
  }
  return value.replace(ANSI_SEQUENCE, "");
}

function fallbackGraphemeWidth(grapheme: string): number {
  if (!grapheme || /^[\p{Cc}\p{Cf}\p{Mn}\p{Me}]+$/u.test(grapheme)) return 0;
  if (/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u20E3]/u.test(grapheme)) return 2;

  for (const char of grapheme) {
    if (/^[\p{Cc}\p{Cf}\p{Mn}\p{Me}]$/u.test(char)) continue;
    return isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return 0;
}

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
