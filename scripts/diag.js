// Diagnose stat-validation payloads for a fixture.
// Usage: node diag.js <fixtureId>
const { makeHttp, STAT_GOALS_P1, STAT_GOALS_P2 } = require("./common");

async function main() {
  const fixtureId = Number(process.argv[2]);
  if (!fixtureId) throw new Error("usage: node diag.js <fixtureId>");
  const http = await makeHttp();

  const { data: snap } = await http.get(`/api/scores/snapshot/${fixtureId}?asOf=${Date.now()}`);
  const events = (Array.isArray(snap) ? snap : [snap])
    .filter((r) => Number.isInteger(r.Seq) && r.Ts)
    .sort((a, b) => b.Ts - a.Ts);

  console.log(`events: ${events.length}`);
  for (const r of events.slice(0, 12)) {
    const g1 = r?.Score?.Participant1?.Total?.Goals, g2 = r?.Score?.Participant2?.Total?.Goals;
    console.log(`event Seq=${r.Seq} Ts=${new Date(r.Ts).toISOString()} StatusId=${r.StatusId} Type=${r.Type ?? "-"} goals=${g1 ?? "?"}-${g2 ?? "?"}`);
  }

  const seqs = [...new Set(events.slice(0, 15).map((r) => r.Seq))];
  console.log(`\nprobing ${seqs.length} seqs:`);
  for (const seq of seqs) {
    try {
      const { data: v } = await http.get("/api/scores/stat-validation", {
        params: { fixtureId, seq, statKey: STAT_GOALS_P1, statKey2: STAT_GOALS_P2 },
      });
      const u = v.summary.updateStats;
      console.log(`seq=${seq} proves ${v.statToProve.value}-${v.statToProve2.value} (period ${v.statToProve.period})` +
        ` batch min=${new Date(u.minTimestamp).toISOString()} max=${new Date(u.maxTimestamp).toISOString()} count=${u.updateCount}`);
    } catch (e) {
      console.log(`seq=${seq} FAILED ${e.response?.status} ${JSON.stringify(e.response?.data)?.slice(0, 120)}`);
    }
  }
}

main().catch((e) => { console.error("FAILED:", e.response?.data || e.message); process.exit(1); });
