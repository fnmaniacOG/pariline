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

3. (0:45) Settlement, on a settled card's history timeline.
"When the match ends, the app settles it within a minute, and here's the entire point of PariLine: it doesn't report the score, it proves it. TxODDS publishes cryptographic fingerprints of every score update on-chain as matches happen. Whoever settles hands the contract the final score plus a Merkle proof, and the contract redoes the math against the on-chain fingerprint. A wrong or forged score physically cannot pass."
Click one history line, flash the Explorer log with `Evaluate predicate to: true`, come back.

4. (1:30) The trust story, same card, point at two history lines.
"But why trust the bot that submitted it? You don't. Look at this market's history: it briefly settled as a DRAW off an early data point. Every settlement sits in a 2 hour objection window where anyone holding a later proof can overwrite it, and that's exactly what happened, corrected to AWAY on-chain, no admin, no support ticket. The app settles for you as a convenience; the window means you never have to trust it."

5. (2:15) Claim, live on the dApp.
Click the green claim button on the settled market, approve in Phantom, show the SOL arrive.
"Two hours after full time the market is final and winners take the pot pro rata. No fees, no human approval step."

6. (2:35) Close, on the dApp grid.
"Markets create themselves from the fixture feed, settle themselves with proofs, and correct themselves when someone's wrong. Live on devnet, built on the same TxLINE integration as SharpLine, our Trading Tools entry. Repo's in the submission."

## One-liners for the submission form

- Outcomes are proven, not reported.
- The only trusted party is TxODDS publishing Merkle roots; everything downstream is math.
- A wrong settlement happened on devnet for real and the challenge mechanism corrected it, permissionlessly.
- 117k CU to verify a World Cup result on-chain.
