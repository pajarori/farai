---
name: packet-analysis
description: Workflow for PCAP, PCAPNG, network-forensics, protocol-reassembly, malware traffic, and encrypted C2 challenges. Use when packet captures or recorded network streams are primary evidence; combine with binary-reversing when an extracted executable defines encoding or encryption.
---

# packet analysis

turn the capture into a timeline of conversations, artifacts, and transformations.

1. preserve the original capture and record its basic properties. inventory endpoints, protocols, ports, conversations, packet counts, durations, and obvious anomalies before applying narrow filters.
2. build a timeline around the objective. identify which stream contains setup, authentication, delivery, command/control, exfiltration, or the final answer.
3. reassemble application streams and extract transferred objects with protocol-aware tools when possible. verify extracted file type and hash before analysis.
4. distinguish capture bytes from dissector interpretation. inspect raw stream bytes when framing, retransmission, encoding, or a custom protocol makes decoded fields misleading.
5. if content is encoded or encrypted, locate keys and transformations in associated binaries, scripts, configuration, handshakes, or repeated structure; then implement a reproducible decoder.

## recovery

- no useful high-level decode: follow individual streams, inspect raw payloads, and infer framing from direction and length.
- apparent missing data: check packet loss, truncation, out-of-order segments, retransmissions, alternate channels, and archive contents before concluding absence.
- too much traffic: rank conversations by timing, volume, protocol, and relationship to the known event instead of applying random display filters.

## completion

support the answer with the relevant stream, extracted artifact, timeline, or decoder output. protocol labels and suspicious traffic alone are not the conclusion.
