// Step B: simulate txoracle validateStat with the payload from explore.js and report compute units.
// Run after explore.js:
//   SHARPLINE_DIR=/Users/ian/Bots/sharpline NODE_PATH=$SHARPLINE_DIR/node_modules node measure.js
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const SHARP = process.env.SHARPLINE_DIR;
// Force resolution to sharpline's node_modules (anchor 0.30.1); a stray
// /Users/ian/Bots/node_modules with anchor 0.29 otherwise wins the walk-up.
const req = createRequire(path.join(SHARP, "package.json"));
const anchor = req("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, ComputeBudgetProgram } = req("@solana/web3.js");
const { BN } = anchor;
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

function toBytes32(value) {
  const bytes = Array.isArray(value)
    ? Uint8Array.from(value)
    : value instanceof Uint8Array
      ? value
      : typeof value === "string" && value.startsWith("0x")
        ? Buffer.from(value.slice(2), "hex")
        : Buffer.from(value, "base64");
  if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length}`);
  return Array.from(bytes);
}
const toProofNodes = (nodes) =>
  nodes.map((n) => ({ hash: toBytes32(n.hash), isRightSibling: n.isRightSibling }));

async function main() {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, "validation.json"), "utf8"));
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(SHARP, "wallet.json"), "utf8"))));
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.join(SHARP, "idl.json"), "utf8"));
  const program = new anchor.Program(idl, provider);

  const fixtureSummary = {
    fixtureId: new BN(v.summary.fixtureId),
    updateStats: {
      updateCount: v.summary.updateStats.updateCount,
      minTimestamp: new BN(v.summary.updateStats.minTimestamp),
      maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: toBytes32(v.summary.eventStatsSubTreeRoot),
  };
  const stat1 = {
    statToProve: v.statToProve,
    eventStatRoot: toBytes32(v.eventStatRoot),
    statProof: toProofNodes(v.statProof),
  };
  const stat2 = v.statToProve2
    ? { statToProve: v.statToProve2, eventStatRoot: toBytes32(v.eventStatRoot), statProof: toProofNodes(v.statProof2) }
    : null;

  const targetTs = v.summary.updateStats.minTimestamp;
  const epochDay = Math.floor(targetTs / 86400000);
  const [dailyScoresPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)],
    program.programId);
  console.log("dailyScoresPda:", dailyScoresPda.toBase58(), "epochDay:", epochDay);

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  // two-stat: home goals - away goals > 0 (predicate itself doesn't matter for CU measurement)
  // TraderPredicate.threshold is i32 in the IDL: plain number, not BN
  const predicate = { threshold: 0, comparison: { greaterThan: {} } };
  const op = stat2 ? { subtract: {} } : null;

  const builder = program.methods
    .validateStat(
      new BN(targetTs),
      fixtureSummary,
      toProofNodes(v.subTreeProof),
      toProofNodes(v.mainTreeProof),
      predicate,
      stat1,
      stat2,
      op)
    .accounts({ dailyScoresMerkleRoots: dailyScoresPda })
    .preInstructions([cuIx]);

  if (process.env.DRY_RUN) {
    const ix = await builder.instruction();
    console.log("DRY_RUN: instruction encoded OK, data bytes:", ix.data.length);
    return;
  }

  try {
    const sim = await builder.simulate();
    report(sim.raw);
  } catch (err) {
    const logs = err?.simulationResponse?.logs || err?.logs || [];
    if (logs.length) report(logs, true);
    console.error("simulate failed:", err.message || err);
    process.exit(1);
  }

  function report(logs, failed = false) {
    for (const l of logs) console.log(l);
    const m = logs.join("\n").match(/consumed (\d+) of (\d+) compute units/g) || [];
    console.log("\n=== RESULT ===");
    m.forEach((x) => console.log(x));
    const consumed = m
      .map((x) => parseInt(x.match(/consumed (\d+)/)[1], 10))
      .reduce((a, b) => Math.max(a, b), 0);
    console.log(`max consumed: ${consumed} CU (tx cap 1,400,000)`);
    console.log(consumed && consumed < 1_150_000 && !failed
      ? "VERDICT: CPI from our settle instruction looks feasible"
      : "VERDICT: tight or failed; plan for own-verifier fallback");
  }
}

main().catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
