# Diamond Drop artifacts

Add one generated JSON artifact per committed reward distribution. Use a stable
path such as `drops/000001-COST/<drop-id>.json`. Files are append-only after
merge. Each artifact must include the complete finalized holder snapshot used
for its allocation so CI can reproduce eligibility, roots, proofs, and calldata.
The artifact also names the exact published rules path and SHA-256 digest used
for that window. A rules label without the matching byte digest is invalid.
Preview data, unsigned proposals, and secrets do not belong here.

Use v3 for a holder-only distribution. Use v4 only when an independently
reviewed community pool is included. A v4 artifact must publish approved event
commitments and deterministic outcomes, never X usernames, post text, OAuth
tokens, raw event IDs, raw signatures, or rejected identity associations.
