---
name: ctf-solving
description: End-to-end workflow for solving CTF challenges and benchmark tasks across web, crypto, pwn, reversing, forensics, and misc. Use when the user asks to solve a challenge, recover a flag, or continue a stalled challenge run; combine it with one domain skill when the category is known.
---

# ctf solving

drive the challenge to a validated answer, not merely an analysis report.

1. identify the exact objective, supplied artifacts, reachable targets, constraints, and current working directory. verify that required files or services are actually accessible before analyzing them.
2. classify the dominant domain from evidence, then load at most the relevant specialist skill. a mixed challenge may change domains later; do not preload every playbook.
3. establish one concrete hypothesis and run the cheapest discriminating test. preserve useful artifacts, commands, decoded values, offsets, endpoints, and credentials as the solve progresses.
4. when a path fails, explain what the result ruled out and change the method. do not spend the run repeating filesystem searches, scanners, decoders, or equivalent payload variants.
5. automate repetitive transformations or interaction once the manual primitive is understood. keep scripts in the workspace when they are part of the reproducible solve.
6. continue past reconnaissance and partial reverse engineering until the requested objective is reached or a specific missing dependency blocks progress.

## completion

- validate the answer against the challenge behavior or available oracle when possible.
- do not assume a fixed flag prefix or format.
- report the answer first, then the shortest reproducible explanation and any remaining uncertainty.

## recovery

- missing artifact: verify the manifest, workspace mapping, archive contents, and target lifecycle once; report the exact missing input instead of searching the entire system repeatedly.
- insufficient tooling: use an available Kali alternative or write a focused parser/script rather than stopping at a tool name.
- remote/local mismatch: compare architecture, libc, protocol, timing, and paths; preserve the working local primitive before adapting it.
