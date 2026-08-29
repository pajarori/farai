---
name: binary-reversing
description: Workflow for understanding native, managed, Go, Rust, JVM, Android, firmware, or obfuscated binaries and recovering hidden logic or data. Use for reverse-engineering challenges, crackmes, malware logic, decompilation, key/flag recovery, or when source is unavailable; pair with binary-exploitation only when memory corruption is the objective.
---

# binary reversing

move from cheap structural facts to the smallest control-flow slice that answers the objective.

1. identify format, architecture, linkage, symbols, protections, runtime, imports, sections, and obvious embedded artifacts. record facts before interpreting them.
2. run the program with bounded, representative inputs when safe and useful. observe files, arguments, environment, stdout/stderr, and system interactions instead of guessing its interface from strings alone.
3. locate the success, comparison, decryption, parsing, or output path. work backward through callers and data references; avoid decompiling the entire binary without a question.
4. reconcile decompiler output with disassembly or runtime state whenever types, compiler optimizations, obfuscation, or stripped symbols make the pseudocode ambiguous.
5. extract constants and encode the recovered transformation in a small script. validate it against known program behavior or by round-tripping an input.

## runtime-aware guidance

- Go/Rust/managed binaries often retain metadata that is more useful than generic string scraping; use runtime-aware symbols and metadata before treating the file as ordinary stripped native code.
- packed or self-modifying code may require observing the unpacked memory image before static analysis becomes meaningful.
- when execution is silent, inspect exit status and side effects and trace the relevant path; do not repeatedly rerun with random input.

## completion

the result is complete when the recovered logic or data is independently reproduced, not when a likely function or interesting string has merely been identified.
