---
name: ffuf
description: Wordlist strategy, soft-404 filtering, and failure recovery for directory/file fuzzing via the dir_enum tool (ffuf-backed). Use this whenever the user wants to enumerate hidden directories/files/endpoints on a web target, or mentions ffuf, gobuster, or fuzzing.
---

# Directory Enumeration Playbook (dir_enum / ffuf)

Fuzz the `FUZZ` keyword position in the URL against a wordlist.

Useful defaults:
- Filter noisy 200s from a catch-all page: match by size/words rather than status when the
  target returns 200 for everything (soft-404) — compare a known-bad path's response size first.
- Start with a small, common wordlist (common.txt / raft-small) before escalating to a large one —
  most useful hits show up early; a huge wordlist mostly adds noise and runtime.
- Add file extensions relevant to the stack once identified (`.php`, `.aspx`, `.bak`, `.json`)
  rather than fuzzing extensions blindly from the start.
- Recurse only into directories that returned a real (not soft-404) response.

## Failure recovery
- All-200 responses with identical body size → soft-404 page; filter by size (`-fs <bytes>`) or
  by matching a known regex instead of status code.
- No hits at all → verify the FUZZ position/URL is actually correct with one manual request first,
  and confirm the target isn't returning a WAF block page for every request (check response size).
