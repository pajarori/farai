---
name: digital-forensics
description: Evidence-preserving workflow for disk, filesystem, memory, archive, document, image, log, browser, and metadata forensics. Use when the task asks what happened, who acted, when an event occurred, or to recover deleted/hidden content from supplied artifacts; use packet-analysis for capture-centric evidence.
---

# digital forensics

preserve provenance while reducing a large artifact set to evidence relevant to the question.

1. inventory supplied artifacts, container/archive layers, sizes, timestamps, types, and hashes. work from copies or extracted views when an operation may alter metadata.
2. translate the user question into evidence categories and a timeline: identities, execution, persistence, access, deletion, transfer, or hidden content.
3. inspect high-signal metadata and indexes before broad carving or string searches. correlate independent sources rather than trusting one timestamp or parser.
4. recover embedded, deleted, encoded, or renamed content with format-aware tools. verify recovered object types and relationships to the parent artifact.
5. keep observed timestamps, normalized time zones, inferred ordering, and uncertain clock assumptions separate.

## recovery

- parser failure: verify file signatures, truncation, compression, encryption, and tool support; use an alternate parser or inspect the structure directly.
- no result from a keyword search: broaden through metadata, encodings, alternate names, and timeline neighbors rather than repeating the same strings command.
- conflicting timestamps: identify each timestamp's semantics and corroborate with logs or adjacent events.

## completion

answer the forensic question with a traceable artifact or correlation. absence from one parser or index is not proof that evidence never existed.
