import assert from "node:assert/strict";
import { test } from "vitest";
import { RPC_POOL_KV_TTL_MS, readRpcPoolKv } from "../workers/api.mjs";

// readRpcPoolKv wraps readHealthKv(env, KV_HEALTH_RPC_POOL) with a 60-second
// in-isolate memo — same pattern as readHealthMetaKv and readEconomicsCurrentKv.
// RPC proxy routes read the pool on every request; the memo collapses repeated
// KV reads on warm isolates.

function mkKvEnv(poolValue = { endpoints: ["https://rpc.example.com"] }) {
  let gets = 0;
  return {
    get gets() {
      return gets;
    },
    METAGRAPH_CONTROL: {
      async get() {
        gets += 1;
        return poolValue;
      },
    },
  };
}

test("readRpcPoolKv memoizes within the TTL — one KV read for repeated calls", async () => {
  const env = mkKvEnv();
  const t0 = 1_000_000;
  const a = await readRpcPoolKv(env, t0);
  const b = await readRpcPoolKv(env, t0 + 1000);
  assert.deepEqual(a, { endpoints: ["https://rpc.example.com"] });
  assert.deepEqual(a, b);
  assert.equal(
    env.gets,
    1,
    "the second call within the TTL must be served from the in-isolate memo",
  );

  // Past the TTL it re-reads.
  await readRpcPoolKv(env, t0 + RPC_POOL_KV_TTL_MS + 1);
  assert.equal(env.gets, 2, "an expired memo triggers a fresh KV read");
});

test("readRpcPoolKv never cross-reads a different env (isolation safety)", async () => {
  const envA = mkKvEnv({ endpoints: ["a"] });
  const envB = mkKvEnv({ endpoints: ["b"] });
  const t0 = 2_000_000;
  const a = await readRpcPoolKv(envA, t0);
  const b = await readRpcPoolKv(envB, t0);
  assert.deepEqual(a.endpoints, ["a"]);
  assert.deepEqual(b.endpoints, ["b"], "a different env object must miss the memo");
  assert.equal(envA.gets, 1);
  assert.equal(envB.gets, 1);
});

test("readRpcPoolKv returns null when KV binding is absent", async () => {
  const result = await readRpcPoolKv({}, 3_000_000);
  assert.equal(result, null);
});

test("readRpcPoolKv does not cache a null result (no sticky cold miss)", async () => {
  let gets = 0;
  const env = {
    METAGRAPH_CONTROL: {
      async get() {
        gets += 1;
        return null;
      },
    },
  };
  const t0 = 4_000_000;
  await readRpcPoolKv(env, t0);
  await readRpcPoolKv(env, t0 + 1000);
  assert.equal(gets, 2, "a null result must not be memoized");
});
