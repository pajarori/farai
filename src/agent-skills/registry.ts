import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

export type SkillSource = "builtin" | "user" | "environment" | "project";

export type SkillMeta = {
  name: string;
  description: string;
  source: SkillSource;
  directory: string;
  hash: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata: Record<string, string>;
  resources: string[];
};

export type SkillDiagnostic = {
  path: string;
  severity: "warning" | "error";
  message: string;
};

export type SkillDiscoveryOptions = {
  workspace?: string;
  includeUser?: boolean;
  extraRoots?: string[];
};

export type SkillDiscovery = {
  skills: SkillMeta[];
  diagnostics: SkillDiagnostic[];
};

export type LoadedSkill = SkillMeta & {
  body: string;
  resource?: { path: string; content: string };
};

type InternalSkill = LoadedSkill & { priority: number };
type SkillRoot = { path: string; source: SkillSource; priority: number };

const BUILTIN_DIR = resolveBuiltinSkillDir();
const MAX_SKILL_BYTES = 64 * 1024;
const RECOMMENDED_SKILL_BYTES = 20 * 1024;
const MAX_RESOURCE_BYTES = 128 * 1024;
const MAX_RESOURCES = 256;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function discoverSkills(options: SkillDiscoveryOptions = {}): SkillDiscovery {
  const diagnostics: SkillDiagnostic[] = [];
  const selected = new Map<string, InternalSkill>();
  for (const root of skillRoots(options)) {
    for (const skill of scanRoot(root, diagnostics)) {
      const existing = selected.get(skill.name);
      if (existing && skill.priority >= existing.priority) {
        diagnostics.push({
          path: skill.directory,
          severity: "warning",
          message: `${skill.name} overrides ${existing.source} skill at ${existing.directory}`
        });
      }
      if (!existing || skill.priority >= existing.priority) selected.set(skill.name, skill);
    }
  }
  const skills = [...selected.values()]
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
    .map(({ priority: _priority, body: _body, ...skill }) => skill);
  return { skills, diagnostics };
}

export function listSkills(input: string | SkillDiscoveryOptions = {}): SkillMeta[] {
  const options = typeof input === "string" ? { workspace: input } : input;
  return discoverSkills(options).skills;
}

export function loadSkill(name: string, options: SkillDiscoveryOptions & { resource?: string } = {}): LoadedSkill | undefined {
  const selected = new Map<string, InternalSkill>();
  for (const root of skillRoots(options)) {
    for (const skill of scanRoot(root, [])) {
      const existing = selected.get(skill.name);
      if (!existing || skill.priority >= existing.priority) selected.set(skill.name, skill);
    }
  }
  const skill = selected.get(name);
  if (!skill) return undefined;
  const { priority: _priority, ...loaded } = skill;
  if (!options.resource) return loaded;
  const resourcePath = normalizeResourcePath(options.resource);
  if (!resourcePath || !skill.resources.includes(resourcePath)) return undefined;
  const absolute = resolve(skill.directory, resourcePath);
  const canonical = realpathSync(absolute);
  if (!inside(skill.directory, canonical)) return undefined;
  const stats = statSync(canonical);
  if (!stats.isFile() || stats.size > MAX_RESOURCE_BYTES) return undefined;
  const content = readFileSync(canonical, "utf8");
  if (content.includes("\0")) return undefined;
  return { ...loaded, resource: { path: resourcePath, content } };
}

export function renderSkillCatalog(workspace: string, maxChars = 8_000): string | undefined {
  const skills = listSkills(workspace);
  if (!skills.length || maxChars < 80) return undefined;
  const header = "available skills use progressive disclosure. call skill_load with one exact name, then load a referenced resource only when needed.";
  const compact = skills.map((skill) => `- ${skill.name}: ${compactText(skill.description, 240)}`);
  const full = [header, ...compact].join("\n");
  if (full.length <= maxChars) return full;
  const short = skills.map((skill) => `- ${skill.name}: ${compactText(skill.description, 120)}`);
  const lines = [header];
  for (const line of short) {
    if ([...lines, line].join("\n").length > maxChars) break;
    lines.push(line);
  }
  const omitted = skills.length - (lines.length - 1);
  if (omitted > 0) lines.push(`- ${omitted} additional skills omitted from this context budget`);
  return lines.join("\n");
}

function skillRoots(options: SkillDiscoveryOptions): SkillRoot[] {
  const roots: SkillRoot[] = [{ path: BUILTIN_DIR, source: "builtin", priority: 0 }];
  if (options.includeUser !== false) roots.push({ path: join(homedir(), ".agents", "skills"), source: "user", priority: 10 });
  const environmentRoots = [
    ...(process.env.FARAI_SKILLS_DIR?.split(delimiter) ?? []),
    ...(options.extraRoots ?? [])
  ].map((path) => path.trim()).filter(Boolean);
  for (const path of environmentRoots) roots.push({ path: resolve(path), source: "environment", priority: 20 });
  if (options.workspace) roots.push({ path: join(resolve(options.workspace), ".agents", "skills"), source: "project", priority: 30 });
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = resolve(root.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scanRoot(root: SkillRoot, diagnostics: SkillDiagnostic[]): InternalSkill[] {
  if (!existsSync(root.path)) return [];
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(root.path, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    diagnostics.push({ path: root.path, severity: "error", message: errorMessage(error) });
    return [];
  }
  const skills: InternalSkill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const directory = join(root.path, entry.name);
    const file = join(directory, "SKILL.md");
    if (!existsSync(file)) continue;
    const parsed = parseSkill(file, directory, entry.name, root, diagnostics);
    if (parsed) skills.push(parsed);
  }
  return skills;
}

function resolveBuiltinSkillDir(): string {
  const candidates = [
    join(import.meta.dir, "library"),
    join(import.meta.dir, "..", "..", "src", "agent-skills", "library")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function parseSkill(file: string, directory: string, directoryName: string, root: SkillRoot, diagnostics: SkillDiagnostic[]): InternalSkill | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    diagnostics.push({ path: file, severity: "error", message: errorMessage(error) });
    return undefined;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_SKILL_BYTES) {
    diagnostics.push({ path: file, severity: "error", message: `SKILL.md exceeds ${MAX_SKILL_BYTES} bytes` });
    return undefined;
  }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    diagnostics.push({ path: file, severity: "error", message: "missing YAML frontmatter" });
    return undefined;
  }
  let frontmatter: unknown;
  try {
    frontmatter = Bun.YAML.parse(match[1] ?? "");
  } catch (error) {
    diagnostics.push({ path: file, severity: "error", message: `invalid YAML: ${errorMessage(error)}` });
    return undefined;
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    diagnostics.push({ path: file, severity: "error", message: "frontmatter must be a mapping" });
    return undefined;
  }
  const fields = frontmatter as Record<string, unknown>;
  const name = scalar(fields.name);
  const description = scalar(fields.description);
  if (!name || name.length > 64 || !NAME_PATTERN.test(name)) {
    diagnostics.push({ path: file, severity: "error", message: "name must be 1-64 lowercase letters, digits, and single hyphens" });
    return undefined;
  }
  if (name !== directoryName) {
    diagnostics.push({ path: file, severity: "error", message: `name ${name} must match directory ${directoryName}` });
    return undefined;
  }
  if (!description || description.length > 1024) {
    diagnostics.push({ path: file, severity: "error", message: "description must be 1-1024 characters" });
    return undefined;
  }
  const compatibility = optionalScalar(fields.compatibility);
  if (compatibility && compatibility.length > 500) {
    diagnostics.push({ path: file, severity: "error", message: "compatibility must be at most 500 characters" });
    return undefined;
  }
  const metadata = stringMap(fields.metadata, file, diagnostics);
  if (metadata === undefined) return undefined;
  const canonicalDirectory = realpathSync(directory);
  const body = (match[2] ?? "").trim();
  if (Buffer.byteLength(body, "utf8") > RECOMMENDED_SKILL_BYTES) {
    diagnostics.push({ path: file, severity: "warning", message: "SKILL.md exceeds the recommended progressive-disclosure budget; move detail into references" });
  }
  const license = optionalScalar(fields.license);
  const allowedTools = optionalScalar(fields["allowed-tools"]);
  return {
    name,
    description,
    source: root.source,
    directory: canonicalDirectory,
    hash: createHash("sha256").update(raw).digest("hex"),
    ...(license ? { license } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    metadata,
    resources: listResources(canonicalDirectory, diagnostics),
    body,
    priority: root.priority
  };
}

function listResources(directory: string, diagnostics: SkillDiagnostic[]): string[] {
  const resources: string[] = [];
  const visit = (current: string): void => {
    if (resources.length >= MAX_RESOURCES) return;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      diagnostics.push({ path: current, severity: "warning", message: errorMessage(error) });
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (resources.length >= MAX_RESOURCES || entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      let canonical: string;
      try {
        canonical = realpathSync(path);
      } catch {
        continue;
      }
      if (!inside(directory, canonical)) continue;
      if (entry.isDirectory()) visit(canonical);
      else if ((entry.isFile() || entry.isSymbolicLink()) && canonical !== join(directory, "SKILL.md")) {
        resources.push(relative(directory, canonical).split(sep).join("/"));
      }
    }
  };
  visit(directory);
  return [...new Set(resources)].sort();
}

function stringMap(value: unknown, path: string, diagnostics: SkillDiagnostic[]): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push({ path, severity: "error", message: "metadata must be a string-to-string mapping" });
    return undefined;
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      diagnostics.push({ path, severity: "error", message: `metadata.${key} must be a scalar` });
      return undefined;
    }
    output[key] = String(item);
  }
  return output;
}

function scalar(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function optionalScalar(value: unknown): string | undefined {
  const text = scalar(value);
  return text || undefined;
}

function normalizeResourcePath(path: string): string | undefined {
  const trimmed = path.trim().replaceAll("\\", "/");
  if (!trimmed || isAbsolute(trimmed) || trimmed.includes("\0")) return undefined;
  const normalized = trimmed.split("/").filter((part) => part && part !== ".").join("/");
  if (!normalized || normalized.split("/").includes("..")) return undefined;
  return normalized;
}

function inside(directory: string, path: string): boolean {
  const rel = relative(realpathSync(directory), path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function compactText(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
