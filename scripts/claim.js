// Claim winnings. Usage: node claim.js <fixtureId> <home|draw|away>
const { makeProgram, marketPda, positionPda, OUTCOME_NAMES } = require("./common");

async function main() {
  const [fixtureId, outcomeName] = process.argv.slice(2);
  const outcome = ["home", "draw", "away"].indexOf((outcomeName || "").toLowerCase());
  if (!fixtureId || outcome < 0) throw new Error("usage: node claim.js <fixtureId> <home|draw|away>");

  const { program, wallet, connection } = makeProgram();
  const market = marketPda(program.programId, Number(fixtureId));
  const position = positionPda(program.programId, market, wallet.publicKey, outcome);
  const before = await connection.getBalance(wallet.publicKey);
  const sig = await program.methods
    .claim()
    .accounts({ market, position, owner: wallet.publicKey })
    .rpc();
  const after = await connection.getBalance(wallet.publicKey);
  console.log(`claimed ${OUTCOME_NAMES[outcome]} on ${fixtureId}: +${((after - before) / 1e9).toFixed(4)} SOL tx=${sig}`);
}

main().catch((e) => { console.error("FAILED:", e.error?.errorMessage || e.message || e); process.exit(1); });
