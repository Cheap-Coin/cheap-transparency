# Diamond Drop artifacts

Add one generated JSON artifact per committed reward distribution. Use a stable
path such as `drops/000001-COST/<drop-id>.json`. Files are append-only after
merge. Each artifact must include the complete finalized holder snapshot used
for its allocation so CI can reproduce eligibility, roots, proofs, and calldata.
The artifact also names the exact published rules path and SHA-256 digest used
for that window. A rules label without the matching byte digest is invalid.
Preview data, unsigned proposals, and secrets do not belong here.

V3, V4, and V5 are retained legacy formats. New COST Diamond distributions use
V6 and publish every outbound-transfer flag plus the future entropy that selected
the hidden end block. New CHEAP Surprise distributions use V7 and publish score
commitments, the complete candidate set, capped weights, future entropy, selected
winners, and exact allocations—never X/TikTok usernames, content text, OAuth
tokens, raw event IDs, raw signatures, or rejected identity associations.
