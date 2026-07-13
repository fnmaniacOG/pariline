# PariLine: technical notes

## Settlement design

The core problem for any prediction market is settlement: who decides the outcome, and why should bettors trust them. PariLine's answer is that nobody decides. TxODDS publishes Merkle roots of all score updates to its txoracle program on Solana (devnet `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`), batched into daily PDAs seeded `["daily_scores_roots", epoch_day_le_u16]`. TxLINE's API serves proof paths for any individual stat via `/api/scores/stat-validation`.

Our `propose_settlement` instruction takes a claimed outcome plus the proof payload and CPIs into txoracle's `validate_stat` (discriminator `[107,197,232,90,191,136,105,185]`, single readonly account, returns bool via return data). The call proves both goal stats against the on-chain roots and evaluates the predicate implied by the claim. Stat keys follow TxLINE's `(period * 1000) + base_key` encoding; base keys 1 and 2 with no period offset are the full-game total goals for participants 1 and 2. (Note for other integrators: the docs example's keys 1002 and 1003 are first-half participant 2 goals and first-half participant 1 yellow cards, not the match score.)

- home: goals1 - goals2 > 0
- draw: goals1 - goals2 == 0
- away: goals1 - goals2 < 0

If verification or the predicate fails, txoracle returns false and we revert. Measured cost of the CPI: about 117,000 CU on a small proof batch, rising past 200,000 CU on days with bigger batches (deeper trees), so the settle transaction requests an 800,000 CU budget, still well under the 1.4M ceiling.

## The mid-match proof problem

A Merkle proof of "the score was 1-0" is valid even if the match later ended 1-2. Any proof-based settlement scheme has to handle this. PariLine uses two mechanisms:

1. A minimum settle delay of 110 minutes after kickoff (regulation plus stoppage), so there are no proposals during the bulk of play.
2. A 2 hour challenge window with latest-timestamp-wins: a proposal records the proof batch's `max_timestamp`, and anyone may replace it with a proof carrying a later score timestamp. The full-time score always has the latest timestamp, so an early or stale proposal can always be beaten, by any party, permissionlessly. Honest crankers have no race to lose: they just submit the final proof. Two hours matches the practice of major prediction markets (Polymarket's dispute window is comparable) while keeping payouts same-evening; score corrections in practice land within minutes of full time.

Extra time and penalties are covered by the same mechanism, since later updates carry later timestamps and the window is long enough to span any football match.

## Account model

- `Market` PDA, seeds `["market", fixture_id_le_i64]`: pools per outcome, kickoff, state (Open, Proposed, Settled), proposed outcome, proposed score timestamp, challenge deadline. The market account itself holds the staked lamports.
- `Position` PDA, seeds `["position", market, owner, outcome]`: amount and claimed flag. One position per wallet per outcome, additive on repeat bets.

Claims pay `stake * total / winning_pool`, computed in u128 to avoid overflow.

## Security checks in propose_settlement

- proof fixture id must equal the market's fixture id
- stat keys must be exactly 1 and 2 (full-game goal totals), from the same proven event root
- daily roots account must be owned by txoracle; CPI target pinned by address
- replacement proposals must carry a strictly later score timestamp and land inside the challenge window
- return data is checked for program id and value

## Compute feasibility

`feasibility/measure.js` simulates txoracle `validate_stat` with a production payload (fixture 18185036, Canada v Morocco). Result: 116,629 CU consumed of 1,400,000. This measurement is what selected the CPI design over reimplementing Merkle verification in-program.

## Reuse from SharpLine

The TxLINE auth flow (guest JWT plus on-chain subscribe token), the fixture and score feed handling, the devnet wallet, and the data-shape knowledge (stat keys, status ids, demargined odds book) all come from the SharpLine trading agent built for the Trading Tools track.

## Known limitations

- Devnet only; mainnet needs a funded TxLINE subscription and a program redeploy.
- 1X2 only; the same proof machinery extends to totals and handicaps via other stat keys and thresholds (txoracle's predicate already supports arbitrary thresholds and two-stat expressions).
- Stakes are native SOL; an SPL (e.g. USDC) variant is a token-account swap away.
- If TxODDS stopped publishing roots entirely, markets would simply never settle; funds would be stuck rather than stolen. A refund-after-deadline instruction is the natural extension.
- The market settles on final score including extra time (verified: per-period leaves exist, e.g. fixture 18213979 proves H1 1-1 via keys 1001/1002 vs 1-2 full via keys 1/2). A regulation-only 1X2 variant needs four leaf proofs (H1+H2 per team), which exceeds one transaction, so it requires a two-step settlement; designed but not shipped.
- If nobody backed the winning outcome, claim refunds every position its full stake, so no pot can ever be stranded.
