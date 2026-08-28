import type { LspDiagnosticReport, LspInspectResult } from "./types";

const DIAGNOSTIC_MAX_BYTES = 4 * 1024;
const INSPECT_MAX_BYTES = 32 * 1024;

export function formatDiagnosticReport(report: LspDiagnosticReport): string {
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === 1).slice(0, 20);
  if (errors.length === 0) return `LSP (${safe(report.server, 60)}): no errors`;
  const lines = [`LSP errors (${safe(report.server, 60)}):`];
  for (const diagnostic of errors) {
    const line = diagnostic.range.start.line + 1;
    const column = diagnostic.range.start.character + 1;
    const source = diagnostic.source ? `${safe(diagnostic.source, 60)} ` : "";
    const code = diagnostic.code === undefined ? "" : `[${safe(String(diagnostic.code), 60)}] `;
    lines.push(`${safe(report.path, 300)}:${line}:${column}: ${source}${code}${safe(diagnostic.message, 600)}`);
  }
  if (report.diagnostics.filter((diagnostic) => diagnostic.severity === 1).length > errors.length || report.truncated) lines.push("... more errors omitted");
  return limitUtf8(lines.join("\n"), DIAGNOSTIC_MAX_BYTES);
}

export function appendDiagnosticReport(output: string | undefined, report: LspDiagnosticReport | undefined): string | undefined {
  if (!report) return output;
  return [output, formatDiagnosticReport(report)].filter(Boolean).join("\n\n");
}

export function appendDiagnosticReports(output: string | undefined, reports: Array<LspDiagnosticReport | undefined>): string | undefined {
  const formatted = reports.filter((report): report is LspDiagnosticReport => !!report).map(formatDiagnosticReport);
  if (formatted.length === 0) return output;
  return [output, limitUtf8(formatted.join("\n\n"), DIAGNOSTIC_MAX_BYTES)].filter(Boolean).join("\n\n");
}

export function formatInspectResult(result: LspInspectResult): string {
  const lines = [`${safe(result.operation, 60)} via ${safe(result.server, 60)} (root ${safe(result.projectRoot, 300)})`];
  for (const entry of result.entries) {
    const location = entry.path
      ? `${safe(entry.path, 300)}${entry.line ? `:${entry.line}${entry.column ? `:${entry.column}` : ""}` : ""}`
      : "";
    const label = [entry.kind, entry.name].filter(Boolean).map((value) => safe(String(value), 200)).join(" ");
    const detail = entry.detail ? safe(entry.detail, 2_000) : "";
    lines.push([location, label, detail].filter(Boolean).join(" - ") || "(empty result)");
  }
  if (result.entries.length === 0) lines.push("no results");
  if (result.truncated) lines.push("... more results omitted");
  return limitUtf8(lines.join("\n"), INSPECT_MAX_BYTES);
}

function safe(value: string, maxChars: number): string {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}...` : clean;
}

function limitUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return `${bytes.subarray(0, Math.max(0, maxBytes - 18)).toString("utf8").replace(/\uFFFD$/g, "")}\n... output clipped`;
}
