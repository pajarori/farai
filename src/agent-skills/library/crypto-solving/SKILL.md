---
name: crypto-solving
description: "Workflow for cryptography challenges and custom encoding: formalize the construction, identify exploitable structure, implement attacks, and validate recovered plaintext or keys. Use for classical ciphers, RSA/ECC mistakes, symmetric misuse, PRNG attacks, hashes/MACs, secret sharing, lattice-style tasks, or layered encodings."
---

# crypto solving

model the exact construction before choosing an attack.

1. extract all known values, unknowns, equations, encodings, lengths, randomness assumptions, and attacker capabilities from source and output. preserve byte-versus-text and endian boundaries.
2. identify the primitive and the implementation weakness separately. the name of a cipher does not establish the vulnerability.
3. test the simplest structural explanation first: classical transformation, reused nonce/keystream, weak randomness, small parameter, oracle, algebraic relation, truncation, or encoding confusion.
4. create a small script that reproduces the known output before using it to recover unknown values. validate intermediate equations on toy or supplied samples.
5. use brute force only after bounding the search space and exploiting every available constraint. report the actual tested space and stopping condition.

## recovery

- plausible but unreadable plaintext: re-check alphabet, offsets, block boundaries, padding, endian order, and whether another encoding layer remains.
- attack almost works: compare the implementation line by line with the mathematical assumption; challenge code often differs from the standard primitive in one decisive detail.
- multiple candidates: use format-independent constraints or re-encryption, not an assumed flag prefix alone, to select the answer.

## completion

validate recovered plaintext, key material, or forged output by reversing the construction, re-encrypting, or satisfying the challenge verifier whenever possible.
