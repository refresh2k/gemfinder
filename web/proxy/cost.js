// Proxy-side rate table for $0 spend projections. The PWA carries no rates
// and computes no cost; all cost math happens here.
//
// Evidence: SAM $2.50/1K images observed on run-1 arithmetic (3,913 calls =
// $9.78). Spark per-crop all-in is estimated: recent 300-crop runs land the
// standing ~$1-2/scan after the exact SAM part, implying roughly $2-6/1K
// crops; token billing is still unclear (dashboard is truth). Override via env.
function num(value, dflt) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function rates() {
  return {
    samPer1k: num(process.env.SAM_USD_PER_1K, 2.50),
    sparkPer1kMin: num(process.env.SPARK_USD_PER_1K_MIN, 2.00),
    sparkPer1kMax: num(process.env.SPARK_USD_PER_1K_MAX, 6.00),
  };
}

function costRange(samCalls, sparkCrops, r = rates()) {
  const cents = (calls, per1k) => (calls * per1k) / 10;
  const sam = cents(samCalls, r.samPer1k);
  const tot = (sparkPer1k) => Math.round(sam + cents(sparkCrops, sparkPer1k)) / 100;
  return { min: tot(r.sparkPer1kMin), max: tot(r.sparkPer1kMax) };
}

module.exports = { rates, costRange };
