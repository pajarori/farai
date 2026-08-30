---
name: searchsploit
description: How to search for and validate public exploits with the exploit_search tool (searchsploit-backed) before running them against a target. Use this whenever the user asks to find a known/public exploit, mentions a CVE, exploit-db, or a specific vulnerable service version.
---

# exploit search

- Search by exact product + version string first (e.g. `"vsftpd 2.3.4"`), then broaden if no hit
  (drop the version, then drop to just the product name).
- A search hit is a *candidate*, not a confirmed working exploit — always read the exploit source
  with `shell_exec` inside Kali (for example `searchsploit -x <id>` or the reported container path) before running it,
  to understand exactly what it does and whether it matches the target's actual configuration.
- Prefer the smallest, most targeted PoC over a fully-weaponized Metasploit module when you just
  need to confirm a vulnerability exists — easier to reason about and adapt if it doesn't work
  out of the box.
- If no local exploit-db entry matches, fall back to `internet_search`/`internet_fetch` for the CVE/product
  name — public writeups often show the exact working payload for CTF-style intentionally
  vulnerable services (which are frequently older/unpatched versions on purpose).
