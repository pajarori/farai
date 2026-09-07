import type { Finding } from "../../types";

export function sameFinding(left: Finding, right: Finding): boolean {
  return left.id === right.id
    && left.sessionId === right.sessionId
    && left.title === right.title
    && left.severity === right.severity
    && left.cvssVector === right.cvssVector
    && left.cvssScore === right.cvssScore
    && left.target === right.target
    && left.impact === right.impact
    && left.reproduction === right.reproduction
    && left.remediation === right.remediation
    && left.status === right.status
    && left.campaignId === right.campaignId
    && left.hypothesisId === right.hypothesisId
    && left.duplicateOf === right.duplicateOf
    && left.evidenceIds.length === right.evidenceIds.length
    && left.evidenceIds.every((id, index) => id === right.evidenceIds[index]);
}

export function isOpenFinding(finding: Finding): boolean {
  return finding.status === undefined || finding.status === "candidate" || finding.status === "needs_verification";
}
