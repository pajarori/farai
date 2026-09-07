import { calculateCvss31, type Cvss31Assessment } from "../../security/cvss31";

export function cvssAssessment(value: unknown): Cvss31Assessment {
  if (typeof value !== "string" || !value.trim()) throw new Error("cvssVector is required and must be a CVSS:3.1 base vector");
  return calculateCvss31(value);
}
