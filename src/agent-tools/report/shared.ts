export function severity(value: unknown): "info" | "low" | "medium" | "high" | "critical" {
  if (value === "critical" || value === "high" || value === "medium" || value === "low" || value === "info") return value;
  return "info";
}
