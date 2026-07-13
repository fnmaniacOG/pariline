# Demo video cue cards (target 3 min, dApp-first)

Prep: server running (Helius RPC), dApp open, Phantom on devnet, one open market, Explorer tab with a settlement tx's Logs view.

## 1. Hook (0:00, on the dApp grid)

- "PariLine: a World Cup betting market nobody controls"
- No oracle wallet, no admin key, outcomes are proven with cryptography, not reported

## 2. Bet (0:15, live)

- Connect Phantom, bet on the open match, approve
- Point out: pool bar and payout multiplier move instantly
- "Parimutuel: winners split the whole pot, no fees"
- "Locks at kickoff, enforced by the on-chain clock, not this page"

## 3. Settlement (0:45, settled card timeline + quick Explorer flash)

- "Match ends, it settles itself within a minute, with a Merkle proof"
- TxODDS publishes score fingerprints on-chain; the contract re-does the math against them
- Flash Explorer logs: point at "Evaluate predicate to: true"
- "A wrong or forged score physically cannot pass"

## 4. Trust (1:30, Paraguay v France card history)

- "Why trust the bot that settled it? You don't. Look:"
- Point at DRAW line, then AWAY line: settled wrong off an early data point, overwritten by a later proof
- "2 hour objection window, anyone with a later proof wins. No admin, no ticket"

## 5. Claim (2:15, live)

- Click claim, approve, SOL arrives
- "Final 2 hours after full time. Winners paid, and if nobody backed the winner, everyone refunds, no stuck pots"

## 6. Close (2:35, back to grid)

- "Finds new fixtures, opens markets, settles, corrects, pays, all by itself"
- Live on devnet, same TxLINE integration as SharpLine (our Trading Tools entry), repo in the submission

## Submission one-liners

- Outcomes are proven, not reported
- Only trusted party: TxODDS publishing Merkle roots, everything downstream is math
- A wrong settlement happened for real on devnet and the mechanism corrected it permissionlessly
- ~117k CU to verify a World Cup result on-chain
