# Demo video script (target 3 minutes, dApp-first)

## Prep

- `node demo/server.js` running, dApp open at http://localhost:8787, Phantom on devnet with a little SOL
- `node scripts/crank.js` running in a background terminal (only shown for 5 seconds late in the video)
- Solana Explorer (devnet) tabs: the DRAW settlement tx, the AWAY correction tx, and the claim tx
- At least one market still open for a live bet

## Beats

1. (0:00) Hook, on the dApp.
"This is PariLine, a World Cup betting market where nobody, including me, controls the outcomes. No oracle wallet, no admin key, no company you have to trust. Every result is proven with cryptography before a single lamport moves."

2. (0:15) Bet, live.
Connect Phantom, click bet on an open match, approve. Show the pool bar and payout multiplier move.
"You stake SOL on home, draw, or away. Everyone's stakes pool together, and the payout multiplier is just the pot divided by your side, parimutuel, like a racetrack. Betting locks at kickoff, and not just in the UI: the contract itself checks Solana's clock and rejects late bets."

3. (0:45) How settlement works, over a settled card plus one Explorer tab.
"Here's the part that wins the track. TxODDS publishes fingerprints of every score update on-chain as matches happen, Merkle roots. The full data is too big to store on-chain, so the chain holds the fingerprint and anyone can fetch the matching proof from the TxLINE API. When a match ends, anyone, permissionlessly, hands our contract the final score plus its proof, and the contract redoes the hashing and checks it lands exactly on TxODDS's fingerprint. A wrong or forged score physically cannot pass. Costs about 117k compute units."

4. (1:30) The killer real example: the challenge window.
Show the two Explorer txs side by side.
"A proof has one subtlety: proving the score was 0-0 at some moment is true even if the match ended 0-1. It happened for real on this market: Paraguay against France briefly settled as a DRAW off an early data point. The fix is built in: every settlement sits in a 6 hour challenge window, and anyone holding a proof with a later timestamp can overwrite it. Here's the correction to 0-1 AWAY, on-chain, submitted the same way. The clock starts when a proposal appears, and the full-time score always carries the latest timestamp, so the truth always wins the race."

5. (2:15) Claim, live on the dApp.
Click the green claim button on the settled market, approve in Phantom, show the SOL arrive.
"Window closed, market finalized, winners take the whole pot pro rata. No fees, no human approval step."

6. (2:35) Close, brief cut to the crank terminal.
"This little watcher settles everything automatically, but it has zero power: kill it and any bettor can settle with the same public proofs. The program is live on devnet, built on the same TxLINE integration as SharpLine, our Trading Tools entry. Repo's in the submission."

## One-liners for the submission form

- Outcomes are proven, not reported.
- The only trusted party is TxODDS publishing Merkle roots; everything downstream is math.
- A wrong settlement happened on devnet for real and the challenge mechanism corrected it, permissionlessly.
- 117k CU to verify a World Cup result on-chain.
