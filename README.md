# CheapCoin Rewards Ledger

Public, MIT-licensed, append-only evidence for CheapCoin reward distributions.
This repository publishes Diamond Drop artifacts, Safe transaction references,
post-execution reconciliations, rules hashes, verified notices, and incident
records without exposing production service credentials.

This repository does not create entitlement by itself. The canonical onchain
distributor state and verified Robinhood Chain transactions control execution;
the files here let anyone reproduce and audit what was proposed and completed.
The validator pins the public protocol implementation as a Git submodule and
recomputes eligibility, weights, randomness, allocations, Merkle roots and proofs,
batch contents, and Safe/operator calldata from every published snapshot. V6 is
the strict holder-only COST Diamond format, including the outbound-transfer flags
and reproducible hidden-window selection. V7 is the separate weighted-random
CHEAP Surprise format, including privacy-preserving event commitments, the fully
reproducible score and candidate set, and future-block entropy. V3/V4/V5 remain
historical formats. The validator also compiles
the deployment schema directly from that exact protocol commit, rejects
non-canonical deployment files, independently hashes their exact UTF-8 bytes,
requires one active deployment at most, and verifies that every superseded
record resolves to the active replacement.

## Publication workflow

1. Build an artifact from finalized CHEAP chain data using the pinned public
   protocol implementation.
2. Reproduce the allocation independently and compare every total and root.
3. Have the reward Safe verify token, distributor, budget, roots, and calldata.
4. Add the artifact in a pull request. Existing evidence files cannot be edited,
   renamed, or deleted.
5. After execution, append a reconciliation with transaction hashes and the
   SHA-256 digest of the exact artifact.

Run `pnpm install --frozen-lockfile && pnpm check` before opening a pull
request. The validator compiles the published JSON Schemas, verifies exact
rules-file hashes, and reproduces the checked-in drop and reconciliation test
vectors even before the first live record exists. Deployment tag signatures and
live-chain bytecode are verified by the protocol release commands before the
submodule is advanced; this ledger independently checks the pinned files and
their canonical identity. Report vulnerabilities
privately according to `SECURITY.md`; never
publish an exploitable issue first.
