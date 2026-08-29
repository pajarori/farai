---
name: web-assessment
description: Adaptive workflow for testing web applications and APIs with browser contexts, the managed proxy, HTTP requests, and Kali tools. Use for web CTFs, authenticated application testing, API assessment, session/authorization flaws, injection, upload, SSRF, or client/server behavior; do not use for passive subdomain discovery alone.
---

# web assessment

build a faithful model of application behavior, then test focused hypotheses.

1. use the browser for rendered state, navigation, forms, JavaScript behavior, and distinct identities. create named browser contexts when roles or sessions must remain isolated.
2. use proxy flows and the sitemap to recover exact requests, parameters, cookies, redirects, and background API traffic. use `http_request` or proxy replay when precise, repeatable request control is more useful than UI interaction.
3. map trust boundaries: unauthenticated versus authenticated, user versus user, client-controlled versus server-derived, and edge/CDN behavior versus application behavior.
4. change one meaningful variable at a time. compare status, headers, body semantics, timing, and durable state rather than relying on one anomalous response.
5. validate a candidate issue with the smallest reproducible proof that demonstrates the claimed effect. save the decisive request/response or browser evidence before claiming impact.

## decision rules

- treat automated findings and technology fingerprints as leads.
- do not duplicate every browser request with raw HTTP; switch interfaces when it improves control or observation.
- for authorization testing, compare equivalent operations across isolated identities and confirm server-side data or action differences.
- for injection, first prove control of the relevant parser or sink, then establish impact.
- never turn Cloudflare, WAF, cache, or generic edge behavior into an origin vulnerability without origin-specific evidence.

## recovery

- unstable or blocked automation: inspect proxy/network evidence, retry only after changing context, timing, or request shape.
- unclear endpoint behavior: return to the exact browser-generated request and minimize it.
- noisy enumeration: establish the not-found baseline and filter by meaningful response differences before widening the wordlist.
