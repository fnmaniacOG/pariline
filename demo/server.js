// PariLine demo server: serves the market dashboard and a JSON API that joins
// on-chain market state (devnet) with TxLINE fixture names and demargined odds.
// Run: node server.js   then open http://localhost:8787
const http = require("http");
const fs = require("fs");
const path = require("path");
const { makeHttp, makeProgram, findKeys } = require("../scripts/common");

const PORT = process.env.PORT || 8787;
let httpApi, prog;

async function getOddsProbs(fixtureId) {
  // Returns demargined [pH, pD, pA] from TxLINE 1X2, or null.
  try {
    const { data } = await httpApi.get(`/api/odds/snapshot/${fixtureId}?asOf=${Date.now()}`);
    const records = JSON.stringify(data);
    // walk any structure; find 1X2 records, prefer the demargined book
    const found = [];
    (function walk(o) {
      if (o && typeof o === "object") {
        if (o.SuperOddsType === "1X2_PARTICIPANT_RESULT" && Array.isArray(o.Prices)) found.push(o);
        for (const v of Object.values(o)) walk(v);
      }
    })(data);
    const pick =
      found.find((r) => JSON.stringify(r).includes("Demargined")) || found[found.length - 1];
    if (!pick) return null;
    const odds = pick.Prices.map((p) => p / 1000); // decimal odds x1000
    const probs = odds.map((o) => (o > 0 ? 1 / o : 0));
    const s = probs.reduce((a, b) => a + b, 0) || 1;
    return probs.map((p) => p / s);
  } catch {
    return null;
  }
}

async function marketsJson() {
  const [markets, fixturesRes] = await Promise.all([
    prog.account.market.all(),
    httpApi.get("/api/fixtures/snapshot"),
  ]);
  // fixtures drop out of the snapshot once finished; cache names permanently
  const cachePath = path.join(__dirname, "fixtures-cache.json");
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch {}
  const list = Array.isArray(fixturesRes.data)
    ? fixturesRes.data : fixturesRes.data.fixtures || fixturesRes.data.Fixtures || [];
  for (const f of list) cache[f.FixtureId] = { home: f.Participant1, away: f.Participant2 };
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  const fx = {};
  for (const [id, v] of Object.entries(cache)) fx[id] = { Participant1: v.home, Participant2: v.away };

  const out = [];
  for (const { publicKey, account: m } of markets) {
    const fixtureId = Number(m.fixtureId);
    const f = fx[fixtureId] || {};
    const pools = m.pools.map((p) => Number(p) / 1e9);
    const total = pools.reduce((a, b) => a + b, 0);
    out.push({
      fixtureId,
      address: publicKey.toBase58(),
      home: f.Participant1 || "?",
      away: f.Participant2 || "?",
      kickoff: Number(m.kickoffTs) * 1000,
      state: Object.keys(m.state)[0].toLowerCase(),
      proposedOutcome: m.proposedOutcome,
      challengeDeadline: Number(m.challengeDeadline) * 1000,
      pools,
      total,
      poolProbs: total > 0 ? pools.map((p) => p / total) : [0, 0, 0],
      payouts: pools.map((p) => (p > 0 ? total / p : null)),
      marketProbs: await getOddsProbs(fixtureId),
    });
  }
  out.sort((a, b) => a.kickoff - b.kickoff);
  return out;
}

async function main() {
  httpApi = await makeHttp();
  const { program, wallet } = makeProgram();
  prog = program;
  const html = fs.readFileSync(path.join(__dirname, "index.html"));

  // Integrated settlement keeper: while the dApp is up, finished matches are
  // settled and finalized automatically. Permissionless chore, not a privilege:
  // anyone running this (or scripts/crank.js) does the same job.
  const { tick } = require("../scripts/crank");
  const keeper = () => tick(httpApi, prog, wallet).catch((e) => console.error("keeper:", e.message || e));
  keeper();
  setInterval(keeper, 60000);

  http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/api/markets")) {
        const body = JSON.stringify(await marketsJson());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } else if (req.url.startsWith("/api/meta")) {
        const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../idl/pariline.json"), "utf8"));
        const disc = (n) => idl.instructions.find((i) => i.name === n).discriminator;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ programId: idl.address, betDisc: disc("bet"), claimDisc: disc("claim") }));
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }).listen(PORT, () => console.log(`PariLine demo: http://localhost:${PORT}`));
}

main().catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
