// Place a bet. Usage: node bet.js <fixtureId> <home|draw|away> <sol>
const { makeProgram, marketPda, positionPda, BN, OUTCOME_NAMES } = require("./common");

async function main() {
  const [fixtureId, outcomeName, sol] = process.argv.slice(2);
  const outcome = ["home", "draw", "away"].indexOf((outcomeName || "").toLowerCase());
  if (!fixtureId || outcome < 0 || !(Number(sol) > 0))
    throw new Error("usage: node bet.js <fixtureId> <home|draw|away> <sol>");
  const lamports = Math.round(Number(sol) * 1e9);

  const { program, wallet } = makeProgram();
  const market = marketPda(program.programId, Number(fixtureId));
  const position = positionPda(program.programId, market, wallet.publicKey, outcome);
  const sig = await program.methods
    .bet(outcome, new BN(lamports))
    .accounts({ market, position, bettor: wallet.publicKey })
    .rpc();
  console.log(`bet ${sol} SOL on ${OUTCOME_NAMES[outcome]} for fixture ${fixtureId}: ${sig}`);

  const m = await program.account.market.fetch(market);
  const pools = m.pools.map((p) => Number(p) / 1e9);
  const total = pools.reduce((a, b) => a + b, 0);
  console.log(`pools [H/D/A]: ${pools.join(" / ")} SOL; implied:`,
    pools.map((p) => (p ? ((total / p)).toFixed(2) + "x" : "-")).join(" / "));
}

main().catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
