# CheapCoin transparency ledger

This public, MIT-licensed repository is the append-only evidence ledger for
CheapCoin. It publishes Diamond Drop artifacts, Safe transaction references,
post-execution reconciliations, rules hashes, verified notices, and incident
records without exposing production service credentials.

This repository does not create entitlement by itself. The canonical onchain
distributor state and verified Robinhood Chain transactions control execution;
the files here let anyone reproduce and audit what was proposed and completed.
The validator pins the public protocol implementation as a Git submodule and
recomputes holder eligibility, weights, allocations, Merkle roots and proofs,
batch contents, and Safe/operator calldata from every published snapshot. V4
also reproduces approved community-event scoring, caps, exclusions, funding
splits, source allocations, and the final merged recipient set.

## Publication flow

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
vectors even before the first live record exists. Report vulnerabilities
privately according to `SECURITY.md`; never
publish an exploitable issue first.
