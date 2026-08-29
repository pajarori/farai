---
name: source-security-review
description: Evidence-driven security review of application source, infrastructure code, scripts, and patches. Use when asked to audit a repository, find exploitable vulnerabilities, review security behavior, or validate a fix; do not use for general style review without a security objective.
---

# source security review

trace attacker-controlled data and trust decisions through real code paths.

1. identify entry points, deployment/runtime assumptions, authentication and authorization boundaries, sensitive assets, parsers, interpreters, storage, network egress, and privileged operations.
2. map external input to security-sensitive sinks while accounting for validation, normalization, encoding, framework behavior, and configuration between them.
3. inspect callers and downstream consumers before declaring a local pattern vulnerable. determine whether the path is reachable with the attacker's actual identity and control.
4. rank findings by demonstrated impact and realistic prerequisites. use focused tests or a minimal reproducer when execution is available.
5. for a proposed fix, test the vulnerable path, intended behavior, alternate encodings or routes, and regression boundary; do not accept a guard that protects only one caller.

## evidence standard

- separate confirmed findings from hardening ideas and unverified concerns.
- cite the exact function, configuration, or data flow that creates the issue.
- do not report dependency names, dangerous APIs, missing headers, or scanner matches as vulnerabilities without reachable impact in this project.
- describe remediation at the correct boundary: fix the invariant or trust decision, not only the sample payload.

## completion

return findings ordered by severity with concise reproduction, impact, and remediation. if no confirmed issue is found, say so and identify the remaining untested surfaces.
