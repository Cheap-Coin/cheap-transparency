# Community reward rules v0 test vector

Status: validator fixture only. This is not an active reward campaign and does
not create eligibility or entitlement.

The deterministic test vector recognizes two already-verified actions:

- `educational_post`: 5 points, at most 2 per UTC day and 2 per round.
- `project_work`: 15 points, at most 1 per UTC day and 1 per round.

Provider identity control, wallet signatures, consent, and human anti-Sybil
review occur before an event enters the approved input. The public artifact
contains only approved event commitments and never contains usernames, OAuth
tokens, post text, raw event identifiers, or wallet signatures.

Live actions, caps, funding, exclusions, dates, and appeal terms require a new
owner-approved rules file published before collection opens.
