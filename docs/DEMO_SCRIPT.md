# Demo video script (target 3 minutes)

## Prep before recording

- `node demo/server.js` running, dashboard open at http://localhost:8787
- Solana Explorer (devnet) tabs open: the program address and the Paraguay v France market settle tx (after it lands)
- Terminal with scripts/ as cwd
- Paraguay v France (18188721) already settled and claimed, or record live if timing works

## Beats

1. (0:00) Hook. "This is PariLine, a World Cup prediction market that nobody controls. No oracle wallet, no admin key. Every settlement is a cryptographic proof checked on-chain against TxODDS's verified score roots."
2. (0:20) Dashboard. Show the market cards: pools, crowd percentages vs TxLINE's demargined book, payout multipliers. Point out a market that locked at kickoff.
3. (0:50) Bet. `node bet.js <fixtureId> away 0.1` on an open market, show the pool and payout update on the dashboard.
4. (1:10) The core: settlement. Show `node crank.js --once` output for the finished match: it fetched Merkle proofs from TxLINE and submitted propose_settlement. Open the tx in Explorer, show the inner instruction: our program CPIs into the TxODDS txoracle program, which verifies the proof of both goal totals. "If this proof is wrong, forged, or from the 60th minute, the transaction reverts."
5. (1:50) Challenge window. One sentence on latest-timestamp-wins: "a mid-match score can always be beaten by the full-time proof, by anyone, so settling early is pointless."
6. (2:10) Finalize and claim. `node claim.js ...`, show the SOL arriving, show the market card flip to settled with WON marked.
7. (2:30) Close. "Program, crank, and dashboard are all in the repo. The crank is permissionless: kill ours and any bettor can settle with the same proofs. Built on the same TxLINE integration as SharpLine, our Trading Tools entry."

## One-liners to reuse in the submission form

- Trustless settlement: outcomes are proven, not reported.
- The only trusted party is TxODDS publishing Merkle roots; everything downstream is math.
- 117k CU to verify a World Cup result on-chain.
