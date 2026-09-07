export type Cvss31AttackVector = "N" | "A" | "L" | "P";
export type Cvss31AttackComplexity = "L" | "H";
export type Cvss31PrivilegesRequired = "N" | "L" | "H";
export type Cvss31UserInteraction = "N" | "R";
export type Cvss31Scope = "U" | "C";
export type Cvss31Impact = "N" | "L" | "H";

export type Cvss31Metrics = {
  attackVector: Cvss31AttackVector;
  attackComplexity: Cvss31AttackComplexity;
  privilegesRequired: Cvss31PrivilegesRequired;
  userInteraction: Cvss31UserInteraction;
  scope: Cvss31Scope;
  confidentiality: Cvss31Impact;
  integrity: Cvss31Impact;
  availability: Cvss31Impact;
};

export type Cvss31Assessment = {
  version: "3.1";
  vector: string;
  score: number;
  severity: "info" | "low" | "medium" | "high" | "critical";
  metrics: Cvss31Metrics;
};

const METRIC_KEYS = {
  AV: "attackVector",
  AC: "attackComplexity",
  PR: "privilegesRequired",
  UI: "userInteraction",
  S: "scope",
  C: "confidentiality",
  I: "integrity",
  A: "availability"
} as const;

export function calculateCvss31(vector: string): Cvss31Assessment {
  const metrics = parseCvss31Vector(vector);
  const score = baseScore(metrics);
  return {
    version: "3.1",
    vector: normalizeVector(vector),
    score,
    severity: severityFromCvssScore(score),
    metrics
  };
}

export function parseCvss31Vector(vector: string): Cvss31Metrics {
  const normalized = normalizeVector(vector);
  const parts = normalized.split("/");
  if (parts.shift() !== "CVSS:3.1") throw new Error("cvss vector must start with CVSS:3.1");
  const values: Partial<Record<keyof typeof METRIC_KEYS, string>> = {};
  for (const part of parts) {
    const separator = part.indexOf(":");
    if (separator <= 0 || separator === part.length - 1) throw new Error(`invalid cvss metric: ${part}`);
    const key = part.slice(0, separator) as keyof typeof METRIC_KEYS;
    const value = part.slice(separator + 1);
    if (!(key in METRIC_KEYS)) throw new Error(`unsupported cvss 3.1 metric: ${key}`);
    if (values[key]) throw new Error(`duplicate cvss metric: ${key}`);
    values[key] = value;
  }
  const required = Object.keys(METRIC_KEYS) as Array<keyof typeof METRIC_KEYS>;
  const missing = required.filter((key) => !values[key]);
  if (missing.length > 0) throw new Error(`cvss vector is missing: ${missing.join(", ")}`);
  const metrics = {
    attackVector: valueOf(values.AV, ["N", "A", "L", "P"], "AV"),
    attackComplexity: valueOf(values.AC, ["L", "H"], "AC"),
    privilegesRequired: valueOf(values.PR, ["N", "L", "H"], "PR"),
    userInteraction: valueOf(values.UI, ["N", "R"], "UI"),
    scope: valueOf(values.S, ["U", "C"], "S"),
    confidentiality: valueOf(values.C, ["N", "L", "H"], "C"),
    integrity: valueOf(values.I, ["N", "L", "H"], "I"),
    availability: valueOf(values.A, ["N", "L", "H"], "A")
  } satisfies Cvss31Metrics;
  return metrics;
}

export function severityFromCvssScore(score: number): Cvss31Assessment["severity"] {
  if (!Number.isFinite(score) || score < 0 || score > 10) throw new Error("cvss score must be between 0 and 10");
  if (score === 0) return "info";
  if (score < 4) return "low";
  if (score < 7) return "medium";
  if (score < 9) return "high";
  return "critical";
}

function baseScore(metrics: Cvss31Metrics): number {
  const impact = impactSubScore(metrics);
  if (impact <= 0) return 0;
  const exploitability = 8.22
    * attackVectorValue(metrics.attackVector)
    * attackComplexityValue(metrics.attackComplexity)
    * privilegesRequiredValue(metrics.privilegesRequired, metrics.scope)
    * userInteractionValue(metrics.userInteraction);
  const raw = metrics.scope === "U"
    ? Math.min(impact + exploitability, 10)
    : Math.min(1.08 * (impact + exploitability), 10);
  return roundUp(raw);
}

function impactSubScore(metrics: Cvss31Metrics): number {
  const confidentiality = impactValue(metrics.confidentiality);
  const integrity = impactValue(metrics.integrity);
  const availability = impactValue(metrics.availability);
  const iss = 1 - ((1 - confidentiality) * (1 - integrity) * (1 - availability));
  if (metrics.scope === "U") return 6.42 * iss;
  return 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
}

function attackVectorValue(value: Cvss31AttackVector): number {
  return { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[value];
}

function attackComplexityValue(value: Cvss31AttackComplexity): number {
  return value === "L" ? 0.77 : 0.44;
}

function privilegesRequiredValue(value: Cvss31PrivilegesRequired, scope: Cvss31Scope): number {
  if (value === "N") return 0.85;
  if (value === "L") return scope === "U" ? 0.62 : 0.68;
  return scope === "U" ? 0.27 : 0.5;
}

function userInteractionValue(value: Cvss31UserInteraction): number {
  return value === "N" ? 0.85 : 0.62;
}

function impactValue(value: Cvss31Impact): number {
  return { N: 0, L: 0.22, H: 0.56 }[value];
}

function roundUp(value: number): number {
  return Math.ceil((value - 1e-10) * 10) / 10;
}

function normalizeVector(vector: string): string {
  return vector.trim().replace(/\s+/g, "");
}

function valueOf<T extends string>(value: string | undefined, allowed: readonly T[], key: string): T {
  if (!value || !allowed.includes(value as T)) throw new Error(`invalid cvss ${key} value: ${value ?? "missing"}; use one of: ${allowed.join(", ")}`);
  return value as T;
}
