import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkTtft, percentile } from "../src/bench/ttft.js";

test("percentile handles empty and sorted inputs", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 5);
});

test("lazy provisioning improves simulated TTFT", async () => {
  const report = await benchmarkTtft({
    iterations: 5,
    provisionBaseMs: 15,
    provisionTailMeanMs: 3,
    provisionStallProbability: 0.1,
    provisionStallMs: 40,
    modelBaseMs: 5,
    modelJitterMs: 3,
  });
  assert.ok(report.lazy.p50 < report.eager.p50);
  assert.ok(report.p50ReductionPct > 0);
  assert.ok(report.p95ReductionPct > 0);
});
