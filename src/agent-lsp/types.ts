export type LspServerId = "typescript" | "pyright" | "gopls" | "rust-analyzer";

export type LspInspectOperation =
  | "definition"
  | "references"
  | "hover"
  | "document_symbols"
  | "workspace_symbols";

export type LspDiagnostic = {
  message: string;
  severity?: number;
  code?: string | number;
  source?: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
};

export type LspDiagnosticReport = {
  server: LspServerId;
  path: string;
  diagnostics: LspDiagnostic[];
  truncated?: boolean;
};

export type LspInspectEntry = {
  path?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  name?: string;
  kind?: string;
  detail?: string;
};

export type LspInspectInput = {
  operation: LspInspectOperation;
  path?: string;
  content?: string;
  line?: number;
  column?: number;
  query?: string;
};

export type LspInspectResult = {
  server: LspServerId;
  projectRoot: string;
  operation: LspInspectOperation;
  entries: LspInspectEntry[];
  truncated?: boolean;
};

export type LspPort = {
  diagnose(input: { path: string; content: string }): Promise<LspDiagnosticReport | undefined>;
  inspect(input: LspInspectInput): Promise<LspInspectResult>;
};
