# PariLine

Parimutuel World Cup prediction markets on Solana, settled trustlessly against TxLINE's on-chain verified scores. No oracle keys, no admin, no multisig: the only party anyone trusts is TxODDS publishing score Merkle roots on-chain, and every payout is gated by a cryptographic proof against those roots.

Built for the TxODDS x Superteam World Cup Hackathon, Prediction Markets and Settlement track. Companion project to [SharpLine](https://github.com/fnmaniacOG/sharpline) (Trading Tools track).

**Devnet program:** `3LQjPerfx6ezVbe7dV4WEwUyySrA5S55arje3ParJGMi`

## How it works

1. **create_market** (permissionless): open a 1X2 market for any TxLINE World Cup fixture.
2. **bet**: stake SOL on home, draw, or away. Stakes pool per outcome. Betting locks automatically at kickoff via the Clock sysvar.
3. **propose_settlement** (permissionless): after full time, anyone submits TxLINE Merkle proofs of both teams' goal totals. The program CPIs into the TxODDS txoracle program's `validate_stat`, which verifies the proofs against the daily score roots stored on-chain and evaluates the claimed outcome as a predicate: goals(home) minus goals(away) compared to zero. If the oracle program returns false, the transaction fails. Measured cost: about 117k CU, well within limits.
4. **Challenge window** (2 hours): a proposal built from a mid-match score, or from a wrong or malicious proposer, can always be replaced by anyone holding a proof with a later score timestamp. Latest timestamp wins. This makes settling early strictly unprofitable, and it means nobody has to trust whoever ran the settlement bot.
5. **finalize**, then **claim**: winners split the entire pot pro rata. Parimutuel, no fees. The result is the final score including extra time; level after 120 minutes is a draw (shootouts decide who advances, not the score). If nobody backed the winning outcome, all stakes are refundable in full.

## Why this is trustless

- Settlement is permissionless: any wallet can run the crank; the program only accepts proofs the oracle program verifies.
- There is no authority key anywhere in the program. Nobody can override an outcome, pause a market, or touch the vault.
- Wrong-fixture, wrong-stat, stale, and mid-match proofs are all rejected on-chain (fixture id check, stat key check, timestamp ordering, challenge window).
- The daily roots account is checked to be owned by the txoracle program, and the CPI target is pinned to the txoracle program id.

## Repo layout

- `program/` - Anchor 1.x program (market, bet, settle, finalize, claim)
- `scripts/` - `seed.js` (create markets from the TxLINE fixture feed), `bet.js`, `crank.js` (watches for finished fixtures, fetches proofs, settles), `claim.js`
- `demo/` - dashboard showing pools, crowd probabilities vs TxLINE's demargined book, and payouts
- `feasibility/` - the compute-unit measurement that validated the CPI settlement design

## Running it

Prereqs: Anchor 1.x, Solana CLI 3.x, Node 18+, an activated TxLINE devnet API token (see SharpLine's `auth/activate.ts`).

```bash
cd program && anchor build && anchor program deploy
cd ../scripts
node seed.js                       # create markets for upcoming WC fixtures
node bet.js <fixtureId> home 0.1   # stake
node crank.js                      # settle finished fixtures with Merkle proofs
node claim.js <fixtureId> home     # collect winnings
cd ../demo && node server.js       # dashboard at http://localhost:8787
```

## License

MIT
