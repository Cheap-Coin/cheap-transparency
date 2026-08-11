# Diamond Drop artifacts

Add one generated JSON artifact per committed reward distribution. Use a stable
path such as `drops/000001-COST/<drop-id>.json`. Files are append-only after
merge. Each artifact must include the complete finalized holder snapshot used
for its allocation so CI can reproduce eligibility, roots, proofs, and calldata.
Preview data, unsigned proposals, and secrets do not belong here.
