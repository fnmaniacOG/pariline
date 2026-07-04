// Step A: find a finished World Cup fixture and fetch a stat-validation payload.
// Run: SHARPLINE_DIR=/path/to/sharpline NODE_PATH=$SHARPLINE_DIR/node_modules node explore.js
// Reads TXLINE_API_TOKEN from sharpline/.env (never printed).
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const SHARP = process.env.SHARPLINE_DIR;
const OUT = __dirname;

function loadEnv() {
  const txt = fs.readFileSync(path.join(SHARP, ".env"), "utf8");
  const env = {};
  for (const line of txt.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

// recursively collect keys matching a pattern, with values (small ones only)
function findKeys(obj, re, out = [], prefix = "") {
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (re.test(k) && (typeof v !== "object" || v === null)) out.push([p, v]);
      findKeys(v, re, out, p);
    }
  }
  return out;
}

async function main() {
  const env = loadEnv();
  const API_BASE = env.TXLINE_BASE || "https://txline-dev.txodds.com";
  const { data: auth } = await axios.post(`${API_BASE}/auth/guest/start`);
  const http = axios.create({
    baseURL: API_BASE,
    timeout: 30000,
    headers: { Authorization: `Bearer ${auth.token}`, "X-Api-Token": env.TXLINE_API_TOKEN },
  });
  console.log("auth ok");

  // 1. fixtures: find recent World Cup fixtures that should be finished
  const { data: fixtures } = await http.get("/api/fixtures/snapshot");
  const list = Array.isArray(fixtures) ? fixtures : fixtures.fixtures || fixtures.Fixtures || [];
  console.log("fixtures total:", list.length);
  const now = Date.now();
  const wc = list.filter((f) => f.CompetitionId === 72);
  console.log("WC fixtures:", wc.length);
  const done = wc
    .filter((f) => now - new Date(f.StartTime).getTime() > 3 * 3600 * 1000)
    .sort((a, b) => new Date(b.StartTime) - new Date(a.StartTime))
    .slice(0, 5);
  for (const f of done)
    console.log("candidate:", f.FixtureId, f.Participant1, "v", f.Participant2, f.StartTime);
  if (!done.length) throw new Error("no finished WC fixtures found");

  // 2. scores snapshot for the most recent finished one; hunt for seq + status
  let picked = null, snap = null;
  for (const f of done) {
    try {
      const { data } = await http.get(`/api/scores/snapshot/${f.FixtureId}?asOf=${Date.now()}`);
      const status = findKeys(data, /status/i).slice(0, 5);
      const seqs = findKeys(data, /seq/i).slice(0, 8);
      console.log(`fixture ${f.FixtureId}: status=${JSON.stringify(status)} seqs=${JSON.stringify(seqs)}`);
      const ended = status.some(([, v]) => [5, 10, 13].includes(v));
      if (ended && !picked) { picked = f; snap = data; }
    } catch (e) {
      console.log(`fixture ${f.FixtureId}: scores snapshot failed: ${e.response?.status || e.message}`);
    }
  }
  if (!picked) { picked = done[0]; try { const { data } = await http.get(`/api/scores/snapshot/${picked.FixtureId}?asOf=${Date.now()}`); snap = data; } catch {} }
  fs.writeFileSync(path.join(OUT, "scores-snapshot.json"), JSON.stringify(snap, null, 2));
  console.log("picked fixture:", picked.FixtureId, picked.Participant1, "v", picked.Participant2);

  // 3. stat-validation payload (try with best seq guess, then without)
  const seqCandidates = findKeys(snap, /^seq/i).map(([, v]) => v).filter((v) => Number.isInteger(v));
  const seq = seqCandidates.length ? Math.max(...seqCandidates) : undefined;
  console.log("seq candidates:", seqCandidates.slice(0, 10), "-> using", seq);
  for (const params of [
    { fixtureId: picked.FixtureId, seq, statKey: 1002, statKey2: 1003 },
    { fixtureId: picked.FixtureId, statKey: 1002, statKey2: 1003 },
  ]) {
    try {
      const { data } = await http.get("/api/scores/stat-validation", { params });
      fs.writeFileSync(path.join(OUT, "validation.json"), JSON.stringify(data, null, 2));
      console.log("stat-validation OK with params", JSON.stringify(params));
      console.log("top-level keys:", Object.keys(data));
      console.log("statToProve:", JSON.stringify(data.statToProve));
      console.log("statToProve2:", JSON.stringify(data.statToProve2));
      console.log("summary:", JSON.stringify(data.summary));
      return;
    } catch (e) {
      console.log("stat-validation failed", JSON.stringify(params), e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 300));
    }
  }
  throw new Error("stat-validation failed for all param sets");
}

main().catch((e) => { console.error("FAILED:", e.response?.data || e.message); process.exit(1); });
