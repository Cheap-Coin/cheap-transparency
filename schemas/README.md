# Evidence schemas

Schema versions are immutable after publication. New evidence formats receive a
new file and version number.

Diamond Drop v2 is retained as the prelaunch draft. No new v2 artifacts are
accepted. Production artifacts use v3, which binds every holding window to the
exact published rules path and SHA-256 digest. V4 is the additive format for a
drop with both a normal holder pool and a separately disclosed community pool.
It commits the reviewed community inputs, deterministic score, budget split,
source allocations, merged recipients, proofs, batches, and Safe calldata. V3
remains valid for holder-only distributions and is never rewritten as V4.
