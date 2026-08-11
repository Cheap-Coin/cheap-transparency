# Reconciliations

After a drop is finalized, append a reconciliation JSON file with the executed
transaction hashes, exact totals, timestamp, and SHA-256 digest of its published
artifact. Existing reconciliations are immutable; corrections are new files
that explicitly reference the superseded record.
