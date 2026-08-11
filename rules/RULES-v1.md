# Diamond Drop rules: proposed version 1

These rules are implemented as the technical V1 proposal. The owner must still
approve the new CHEAP supply, eligibility floor, window cadence, start block,
exclusions, and first funded reward budget before activation.

## Eligibility

- A window is a published inclusive pair of Robinhood Chain block numbers.
- Eligibility uses a fixed CHEAP-token floor, not a floating USD floor.
- A wallet's minimum CHEAP balance over the entire window is its payout base.
- A wallet first acquiring CHEAP during a window starts with a zero minimum and
  can qualify in the next window.
- Falling below the floor makes the wallet ineligible for that window and resets
  its next streak to zero.
- The first Robinhood Chain window starts every wallet at streak zero. Solana
  balances and history never enter the calculation.
- A window closes only after its end block reaches the selected finality level.

The interface currently illustrates a 5,000 CHEAP floor and seven-day windows.
Those figures remain preview values until the new supply is approved.

## Streak ladder

| Consecutive eligible windows | Multiplier |
|---:|---:|
| 1 | 1.00x |
| 2 | 1.15x |
| 3 | 1.30x |
| 4 | 1.50x |
| 5-9 | 1.75x |
| 10+ | 2.00x |

`holder weight = minimum CHEAP balance × multiplier`

`holder reward = funded asset amount × holder weight ÷ total eligible weight`

All calculations use token base units and integer arithmetic. Division dust uses
largest remainder and lowercase wallet-address order, so every funded unit is
assigned deterministically.

## Exclusions

The versioned exclusion list includes the CHEAP primary pool, routers, fee
splitter, holder Safe, every reward distributor, zero/burn addresses, liquidity
lockers, vaults, and project-controlled operational wallets. Each entry has a
public reason and effective block range.

## Reward assets and budgets

- COST is the planned primary quote asset. The splitter routes 75% of collected
  COST creator fees to the holder Safe and 25% to the creator recipient.
- A Diamond Drop may use COST or another approved canonical Robinhood RWA token.
- Each reward asset has a separate immutable distributor deployment.
- Each drop names exactly one token address, symbol, decimals value, distributor,
  funding source, and total amount.
- The same holding window can have several independent asset-specific drops.
- A drop can use only tokens already held by its distributor and not reserved.
- Additional assets require Safe approval and a current canonical-registry check.
- Timing and size depend on funded balances. No amount, asset, frequency, or
  market value is guaranteed.
- Rule changes apply only to future windows under a new rules hash.

## Partner benefits

Partner offers are separate entitlements. Each live offer names the partner,
category, eligibility rule, dates, inventory, redemption limits, region, and
published terms. The application never labels a planned slot as an active
partnership.
