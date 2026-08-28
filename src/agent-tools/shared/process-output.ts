import { sanitizeToolOutput } from "./output-sanitize";

export function processOutput(stdout: string, stderr: string): string {
  return sanitizeToolOutput([stdout, stderr.trim() ? `STDERR:\n${stderr}` : ""].filter(Boolean).join("\n"));
}
