# Security policy

## Reporting a vulnerability

Do not disclose an unpatched vulnerability in a public issue, discussion, social
post, or chat. Use GitHub's **Report a vulnerability** button in the Security tab
of the relevant public CheapCoin repository or email `Dev@cheapcoin.fun`. Include
the affected commit or address, impact, reproduction steps, and any proof of
concept that does not endanger users.

The project will acknowledge receipt through the same private channel. Never
send seed phrases, private keys, production credentials, or user data with a
report.

The team will acknowledge a complete report, reproduce it, classify impact, and
coordinate disclosure after a fix is available. Do not move funds, access data
that is not yours, degrade service, phish users, or test against third-party
systems without permission.

## Supported versions

The project is pre-deployment. Only the current `main` branch and the latest
signed release are supported. Canonical deployments will be listed in the public
protocol repository and in the app; an address not listed there is unsupported.

## Scope

In scope:

- CHEAP protocol and reward distributor contracts;
- deterministic allocation, artifact, and Merkle logic;
- CheapCoin web application and public API;
- authorization, signature, wallet, data-integrity, and payout issues.

Social engineering, denial-of-service traffic, third-party wallet internals,
Robinhood/Bankr infrastructure, and hypothetical findings without a CheapCoin
impact are outside project control, though relevant integration risks are welcome.

No bug bounty amount is promised unless a separate signed program says otherwise.
