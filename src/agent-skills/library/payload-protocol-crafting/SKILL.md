---
name: payload-protocol-crafting
description: Bottom-up methodology for crafting exploits against custom, legacy, or undocumented network protocols (read the spec, build a minimal reproducer, add the injection point last). Use this whenever the target speaks something other than plain HTTP -- a custom TCP protocol, a legacy service like LPD, or any case involving raw sockets, handshakes, or command injection into a non-HTTP protocol.
---

# Crafting Exploits Against Custom/Legacy Protocols

When a target service speaks something other than plain HTTP (a legacy or custom TCP protocol,
e.g. LPD, a proprietary binary protocol, etc.), trial-and-error against the full exploit is slow
and confusing. Work bottom-up instead:

1. **Read the spec first.** Look up the RFC or protocol documentation (`http_request`/web search)
   before writing any code — legacy protocols usually have a short, precise spec (e.g. RFC 1179
   for LPD) that tells you the exact byte sequence/framing expected, far faster than guessing.
2. **Build the smallest possible reproducer.** Write a minimal script that performs just the
   protocol handshake/framing and confirms the target responds as expected — no injected payload
   yet. Validate this piece works byte-for-byte before adding anything else.
3. **Add the injection point once framing is confirmed.** Only after step 2 works reliably,
   insert the actual command-injection/shell payload into the appropriate protocol field.
4. **Iterate on the smallest unit that failed**, not the whole exploit. If step 3 doesn't work,
   go back to isolating exactly which part is wrong (framing vs. payload vs. escaping) rather than
   rewriting the entire script and re-running end-to-end each time — that's what turns a
   straightforward exploit into many confused iterations.
5. **Prefer `shell_exec` for the throwaway reproducer scripts** (fast iteration, inspect raw
   output immediately) and only wrap the validated logic into a saved script via
   `code_write_script` once it's confirmed working.
