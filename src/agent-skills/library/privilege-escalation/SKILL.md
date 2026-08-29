---
name: privilege-escalation
description: Targeted local privilege-escalation and post-exploitation workflow for Linux, Windows, containers, and directory-backed hosts. Use after an authorized foothold when the objective requires a higher-privileged identity, secrets, lateral context, or proof of administrative/root access.
---

# privilege escalation

prioritize paths supported by the current host context instead of dumping every enumeration check.

1. establish the current identity, groups, privileges, host/container boundary, operating system, architecture, domain context, writable locations, and available execution channel.
2. enumerate high-signal surfaces: delegated privileges, service/task configuration, credentials and tokens, writable execution paths, capabilities, mounts, sockets, containers, kernel/version constraints, and application secrets.
3. rank candidates by evidence, prerequisites, reliability, and reversibility. inspect the exact configuration or file before trying an exploit.
4. prove the next privilege boundary with the smallest controlled action. verify the resulting identity and execution context rather than assuming success from command output alone.
5. preserve useful credentials, paths, and failed hypotheses so later attempts do not repeat the same checks.

## recovery

- automated enumerator noise: return to the underlying permission, owner, service, token, or version and verify it manually.
- exploit mismatch: confirm kernel/build, architecture, mitigations, namespace, and required primitives before changing payloads.
- apparent root inside a container: determine whether the objective concerns container root or the host boundary and prove the actual context.

## completion

show the requested privileged effect and current identity. a suspicious permission, public exploit match, or writable file is a candidate path, not completed escalation.
