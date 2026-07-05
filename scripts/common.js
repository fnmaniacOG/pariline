// Shared helpers: TxLINE auth, anchor program handles, PDAs, proof shaping.
// Requires are pinned to sharpline's node_modules (anchor 0.30.1); the stray
// anchor 0.29 in /Users/ian/Bots/node_modules must not win resolution.
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const SHARP = process.env.SHARPLINE_DIR || path.resolve(__dirname, "../../sharpline");
const req = createRequire(path.join(SHARP, "package.json"));
const anchor = req("@coral-xyz/anchor");
const axios = req("axios");
const { Connection, Keypair, PublicKey } = req("@solana/web3.js");
const { BN } = anchor;

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const TXORACLE_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const WORLD_CUP_COMPETITION_ID = 72;
const FINAL_STATUS_IDS = [5, 10, 13];
// (period * 1000) + base_key; base 1/2 with no offset = full-game total goals
const STAT_GOALS_P1 = 1;
const STAT_GOALS_P2 = 2;
const OUTCOME_NAMES = ["HOME", "DRAW", "AWAY"];

function loadEnv() {
  const txt = fs.readFileSync(path.join(SHARP, ".env"), "utf8");
  const env = {};
  for (const line of txt.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

async function makeHttp() {
  const env = loadEnv();
  const base = env.TXLINE_BASE || "https://txline-dev.txodds.com";
  const { data: auth } = await axios.post(`${base}/auth/guest/start`);
  return axios.create({
    baseURL: base,
    timeout: 30000,
    headers: { Authorization: `Bearer ${auth.token}`, "X-Api-Token": env.TXLINE_API_TOKEN },
  });
}

function makeProgram() {
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(SHARP, "wallet.json"), "utf8"))));
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "../program/target/idl/pariline.json"), "utf8"));
  return { program: new anchor.Program(idl, provider), wallet, connection, provider };
}

const marketPda = (programId, fixtureId) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("market"), new BN(fixtureId).toArrayLike(Buffer, "le", 8)], programId)[0];

const positionPda = (programId, market, owner, outcome) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), owner.toBuffer(), Buffer.from([outcome])], programId)[0];

const dailyScoresPda = (tsMs) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(Math.floor(tsMs / 86400000)).toArrayLike(Buffer, "le", 2)],
    TXORACLE_ID)[0];

function toBytes32(value) {
  const bytes = Array.isArray(value) ? Uint8Array.from(value)
    : value instanceof Uint8Array ? value
    : typeof value === "string" && value.startsWith("0x") ? Buffer.from(value.slice(2), "hex")
    : Buffer.from(value, "base64");
  if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length}`);
  return Array.from(bytes);
}
const toProofNodes = (nodes) =>
  nodes.map((n) => ({ hash: toBytes32(n.hash), isRightSibling: n.isRightSibling }));

/// Shape a /api/scores/stat-validation response into our SettlementProof arg.
function buildSettlementProof(v) {
  const targetTs = v.summary.updateStats.minTimestamp;
  return {
    proof: {
      ts: new BN(targetTs),
      summary: {
        fixtureId: new BN(v.summary.fixtureId),
        updateStats: {
          updateCount: v.summary.updateStats.updateCount,
          minTimestamp: new BN(v.summary.updateStats.minTimestamp),
          maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
        },
        eventsSubTreeRoot: toBytes32(v.summary.eventStatsSubTreeRoot),
      },
      fixtureProof: toProofNodes(v.subTreeProof),
      mainTreeProof: toProofNodes(v.mainTreeProof),
      statP1: { statToProve: v.statToProve, eventStatRoot: toBytes32(v.eventStatRoot), statProof: toProofNodes(v.statProof) },
      statP2: { statToProve: v.statToProve2, eventStatRoot: toBytes32(v.eventStatRoot), statProof: toProofNodes(v.statProof2) },
    },
    dailyScoresRoots: dailyScoresPda(targetTs),
    // goals for participant1 / participant2 (already proven server-side; the
    // program re-proves them on-chain)
    goalsP1: v.statToProve.value,
    goalsP2: v.statToProve2.value,
  };
}

const outcomeFromGoals = (g1, g2) => (g1 > g2 ? 0 : g1 === g2 ? 1 : 2);

// recursively collect [path, value] pairs for keys matching re
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

module.exports = {
  anchor, BN, PublicKey, TXORACLE_ID, WORLD_CUP_COMPETITION_ID, FINAL_STATUS_IDS,
  STAT_GOALS_P1, STAT_GOALS_P2, OUTCOME_NAMES,
  makeHttp, makeProgram, marketPda, positionPda, dailyScoresPda,
  buildSettlementProof, outcomeFromGoals, findKeys,
};
