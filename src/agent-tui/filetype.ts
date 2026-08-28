const EXTENSIONS: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  json: "json", jsonl: "json", md: "markdown", markdown: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", py: "python", rb: "ruby",
  rs: "rust", go: "go", java: "java", c: "c", h: "c", cpp: "cpp",
  cc: "cpp", hpp: "cpp", css: "css", html: "html", xml: "xml",
  yaml: "yaml", yml: "yaml", toml: "toml", sql: "sql", diff: "diff"
};

export function inferFiletype(path?: string, contentType?: string): string {
  if (contentType?.toLowerCase().includes("json")) return "json";
  if (!path) return "text";
  const base = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (["dockerfile", "containerfile"].includes(base)) return "dockerfile";
  if (["makefile", "gnumakefile"].includes(base)) return "make";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return EXTENSIONS[ext] ?? "text";
}
