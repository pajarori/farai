---
name: nmap
description: Nmap CLI syntax, safe two-pass scan patterns, and failure recovery (filtered ports, timeouts) for the nmap_scan tool. Use this whenever the user asks to port-scan, enumerate services, or check what's open on a target, even before they mention nmap by name.
---

# Nmap Playbook

Canonical syntax: `nmap [Scan Type(s)] [Options] {target specification}`

High-signal flags:
- `-n` skip DNS resolution
- `-Pn` skip host discovery when ICMP/ping is filtered (common in lab/VPN targets)
- `-sS` SYN scan (needs privilege); `-sT` TCP connect scan (no raw-socket privilege needed)
- `-sV` service/version detection; `-sC` default NSE scripts
- `-p <ports>` explicit ports, `-p-` for all 65535 (slow — avoid unless required)
- `--top-ports <n>` quick common-port sweep
- `--open` show only hosts/ports that are open
- `-T4` reasonable speed for lab targets
- `--max-retries 1 --host-timeout 90s` bound worst-case runtime

## Two-pass workflow (preferred over one giant scan)
1. Fast discovery pass: `nmap -n -Pn --top-ports 100 --open -T4 --max-retries 1 --host-timeout 90s <target>`
2. Enrichment pass on discovered ports only: `nmap -n -Pn -sV -sC -p <comma_ports> --script-timeout 30s --host-timeout 3m <target>`

## Failure recovery
- Host looks down unexpectedly → add `-Pn` (many lab/CTF targets block ICMP).
- Scan stalls or times out → tighten `-p`/`--top-ports` and lower `--max-retries`.
- A "filtered" result that you expect to be open may be transient (target-side rate limiting from
  prior scan/exploit traffic, or a momentary VPN blip) — a single retry a few seconds later is
  reasonable before concluding the port is genuinely filtered.
