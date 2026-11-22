// Preloaded into every test process: cost-4 bcrypt (~1 ms) instead of 12 (~225 ms).
// Production never reads this file, and passwordCost() refuses a lowered cost there.
process.env.ARBOR_PASSWORD_COST ??= '4';
