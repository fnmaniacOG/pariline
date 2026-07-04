// Create markets for upcoming World Cup fixtures.
// Usage: node seed.js [--fixture <id>]   (default: all upcoming WC fixtures)
const { makeHttp, makeProgram, marketPda, BN, WORLD_CUP_COMPETITION_ID } = require("./common");

async function main() {
  const onlyFixture = process.argv.includes("--fixture")
    ? Number(process.argv[process.argv.indexOf("--fixture") + 1]) : null;
  const http = await makeHttp();
  const { program } = makeProgram();

  const { data } = await http.get("/api/fixtures/snapshot");
  const list = Array.isArray(data) ? data : data.fixtures || data.Fixtures || [];
  const upcoming = list.filter((f) =>
    f.CompetitionId === WORLD_CUP_COMPETITION_ID &&
    new Date(f.StartTime).getTime() > Date.now() &&
    (!onlyFixture || f.FixtureId === onlyFixture));
  console.log(`upcoming WC fixtures: ${upcoming.length}`);

  for (const f of upcoming) {
    const pda = marketPda(program.programId, f.FixtureId);
    if (await program.provider.connection.getAccountInfo(pda)) {
      console.log(`exists: ${f.FixtureId} ${f.Participant1} v ${f.Participant2}`);
      continue;
    }
    const kickoff = Math.floor(new Date(f.StartTime).getTime() / 1000);
    const sig = await program.methods
      .createMarket(new BN(f.FixtureId), new BN(kickoff))
      .accounts({ market: pda })
      .rpc();
    console.log(`created: ${f.FixtureId} ${f.Participant1} v ${f.Participant2} kickoff=${f.StartTime} tx=${sig}`);
  }
}

main().catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
