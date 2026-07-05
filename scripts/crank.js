// Settlement crank: permissionless. Finds open markets whose fixtures have
// ended, fetches Merkle stat-validation payloads from TxLINE, and submits
// propose_settlement; finalizes markets whose challenge window has passed.
// Usage: node crank.js [--once] [--interval <secs>]
const {
  makeHttp, makeProgram, BN, TXORACLE_ID, FINAL_STATUS_IDS,
  STAT_GOALS_P1, STAT_GOALS_P2, OUTCOME_NAMES,
  buildSettlementProof, outcomeFromGoals, findKeys,
} = require("./common");

const MIN_SETTLE_DELAY_SECS = 110 * 60;

async function tick(http, program, wallet) {
  const markets = await program.account.market.all();
  const now = Math.floor(Date.now() / 1000);

  for (const { publicKey: marketPk, account: m } of markets) {
    const state = Object.keys(m.state)[0]; // open | proposed | settled
    const fixtureId = Number(m.fixtureId);

    if (state === "proposed" && now > Number(m.challengeDeadline)) {
      const sig = await program.methods.finalize().accounts({ market: marketPk }).rpc();
      console.log(`finalized ${fixtureId} -> ${OUTCOME_NAMES[m.proposedOutcome]} tx=${sig}`);
      continue;
    }
    if (state === "settled") continue;
    if (now < Number(m.kickoffTs) + MIN_SETTLE_DELAY_SECS) continue;

    // has the fixture ended?
    let snap;
    try {
      ({ data: snap } = await http.get(`/api/scores/snapshot/${fixtureId}?asOf=${Date.now()}`));
    } catch (e) {
      console.log(`${fixtureId}: snapshot failed (${e.response?.status || e.message})`); continue;
    }
    const ended = findKeys(snap, /^StatusId$/).some(([, v]) => FINAL_STATUS_IDS.includes(v));
    if (!ended) { console.log(`${fixtureId}: not ended yet`); continue; }

    // Seq is per-connection, so "max Seq" can point at a stale event. Take the
    // seqs of the newest events by Ts and keep the payload whose proven batch
    // carries the latest score timestamp.
    const events = (Array.isArray(snap) ? snap : [snap])
      .filter((r) => Number.isInteger(r.Seq) && r.Ts)
      .sort((a, b) => b.Ts - a.Ts);
    const candidateSeqs = [...new Set(events.slice(0, 6).map((r) => r.Seq))];
    let v = null;
    for (const seq of candidateSeqs) {
      try {
        const { data } = await http.get("/api/scores/stat-validation", {
          params: { fixtureId, seq, statKey: STAT_GOALS_P1, statKey2: STAT_GOALS_P2 },
        });
        if (!v || data.summary.updateStats.maxTimestamp > v.summary.updateStats.maxTimestamp) v = data;
      } catch (e) {
        console.log(`${fixtureId}: stat-validation seq=${seq} failed (${e.response?.status})`);
      }
    }
    if (!v) { console.log(`${fixtureId}: no validation payload obtainable`); continue; }

    const { proof, dailyScoresRoots, goalsP1, goalsP2 } = buildSettlementProof(v);
    const claimed = outcomeFromGoals(goalsP1, goalsP2);
    if (state === "proposed" &&
        !new BN(proof.summary.updateStats.maxTimestamp).gte(new BN(m.proposedScoreTs))) {
      console.log(`${fixtureId}: proposal already at latest score ts`); continue;
    }
    try {
      const sig = await program.methods
        .proposeSettlement(claimed, proof)
        .accounts({
          market: marketPk,
          dailyScoresRoots,
          txoracle: TXORACLE_ID,
          cranker: wallet.publicKey,
        })
        .rpc();
      console.log(`${fixtureId}: proposed ${goalsP1}-${goalsP2} -> ${OUTCOME_NAMES[claimed]} tx=${sig}`);
    } catch (e) {
      console.log(`${fixtureId}: propose failed:`, e.error?.errorMessage || e.message);
      if (e.logs) console.log(e.logs.slice(-8).join("\n"));
    }
  }
}

async function main() {
  const once = process.argv.includes("--once");
  const iv = process.argv.includes("--interval")
    ? Number(process.argv[process.argv.indexOf("--interval") + 1]) : 60;
  const http = await makeHttp();
  const { program, wallet } = makeProgram();
  console.log(`crank running as ${wallet.publicKey.toBase58()} (${once ? "once" : `every ${iv}s`})`);
  do {
    try { await tick(http, program, wallet); }
    catch (e) { console.error("tick error:", e.message || e); }
    if (!once) await new Promise((r) => setTimeout(r, iv * 1000));
  } while (!once);
}

main().catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
