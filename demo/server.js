// PariLine demo server: serves the market dashboard and a JSON API that joins
// on-chain market state (devnet) with TxLINE fixture names and demargined odds.
// Run: node server.js   then open http://localhost:8787
const http = require("http");
const fs = require("fs");
const path = require("path");
const { makeHttp, makeProgram, PublicKey, BN, bs58, marketPda, WORLD_CUP_COMPETITION_ID, findKeys } = require("../scripts/common");

const PORT = process.env.PORT || 8787;
let httpApi, prog, DISCS;
const OUTCOMES = ["HOME", "DRAW", "AWAY"];
const HIST_PATH = path.join(__dirname, "history-cache.json");
let HIST_CACHE = {};
try { HIST_CACHE = JSON.parse(fs.readFileSync(HIST_PATH, "utf8")); } catch {}
const saveHist = () => { try { fs.writeFileSync(HIST_PATH, JSON.stringify(HIST_CACHE)); } catch {} };
const WARMING = new Set();

function loadDiscs() {
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../idl/pariline.json"), "utf8"));
  DISCS = Object.fromEntries(idl.instructions.map((i) => [i.discriminator.join(","), i.name]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Decode this market's on-chain life story from its transaction history.
/// Disk-cached by state fingerprint (finalized markets never change), and
/// never blocks the page: misses are fetched in the background.
function history(m, fp) {
  const cached = HIST_CACHE[m.address];
  if (cached && cached.fp === fp) return cached.v;
  if (!WARMING.has(m.address)) {
    WARMING.add(m.address);
    fetchHistory(m, fp).finally(() => WARMING.delete(m.address));
  }
  return cached ? cached.v : [];
}

async function fetchHistory(m, fp) {
  const conn = prog.provider.connection;
  const out = [];
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(m.address), { limit: 12 });
    for (const s of sigs.reverse()) {
      if (s.err) continue;
      await sleep(250); // pace requests for public devnet RPC
      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      for (const ix of tx.transaction.message.instructions) {
        if (ix.programId.toBase58() !== prog.programId.toBase58() || !ix.data) continue;
        const d = bs58.decode(ix.data);
        const name = DISCS[Array.from(d.slice(0, 8)).join(",")];
        if (!name) continue;
        const when = new Date((tx.blockTime || 0) * 1000).toISOString().slice(5, 16).replace("T", " ");
        let label = null;
        if (name === "create_market") label = "market created";
        else if (name === "bet") label = `bet ${(Number(new DataView(d.buffer, d.byteOffset + 9, 8).getBigUint64(0, true)) / 1e9)} SOL on ${OUTCOMES[d[8]]}`;
        else if (name === "propose_settlement") label = `settlement proposed: ${OUTCOMES[d[8]]} (Merkle proof verified)`;
        else if (name === "finalize") label = "finalized after challenge window";
        else if (name === "claim") label = "winnings claimed";
        // skip consecutive repeats (e.g. redundant re-proposals of the same outcome)
        if (label && (!out.length || out[out.length - 1].label !== label)) out.push({ when, label, sig: s.signature });
      }
    }
  } catch (e) {
    console.error("history:", e.message);
    return; // keep whatever cache exists rather than overwriting with partial data
  }
  HIST_CACHE[m.address] = { t: Date.now(), v: out, fp };
  saveHist();
}

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
    const state = Object.keys(m.state)[0].toLowerCase();
    out.push({
      fixtureId,
      address: publicKey.toBase58(),
      home: f.Participant1 || "?",
      away: f.Participant2 || "?",
      kickoff: Number(m.kickoffTs) * 1000,
      state,
      history: state === "open" ? [] : history(
        { address: publicKey.toBase58() },
        `${state}:${m.proposedScoreTs}:${pools.join(",")}`),
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
  loadDiscs();
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

  // Integrated seeder: open markets for newly announced WC fixtures.
  const seeder = async () => {
    try {
      const { data } = await httpApi.get("/api/fixtures/snapshot");
      const list = Array.isArray(data) ? data : data.fixtures || data.Fixtures || [];
      const upcoming = list.filter((f) =>
        f.CompetitionId === WORLD_CUP_COMPETITION_ID &&
        new Date(f.StartTime).getTime() > Date.now());
      for (const f of upcoming) {
        const pda = marketPda(prog.programId, f.FixtureId);
        if (await prog.provider.connection.getAccountInfo(pda)) continue;
        const kickoff = Math.floor(new Date(f.StartTime).getTime() / 1000);
        const sig = await prog.methods
          .createMarket(new BN(f.FixtureId), new BN(kickoff))
          .accounts({ market: pda })
          .rpc();
        console.log(`market created: ${f.FixtureId} ${f.Participant1} v ${f.Participant2} tx=${sig}`);
      }
    } catch (e) {
      console.error("seeder:", e.message || e);
    }
  };
  seeder();
  setInterval(seeder, 600000);

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
        res.end(JSON.stringify({
          programId: idl.address,
          betDisc: disc("bet"),
          claimDisc: disc("claim"),
          rpcUrl: process.env.RPC_URL || "https://api.devnet.solana.com",
        }));
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
