import { test } from "node:test";
import assert from "node:assert/strict";
import { healMalformedJson, type HealIntegrationDeps } from "./heal-integration.ts";

test("healMalformedJson returns parsed object on success", async () => {
  const deps: HealIntegrationDeps = {
    callHeal: async () => ({ repaired: JSON.stringify({ a: 1, fixed: true }), source: "jsonrepair" }),
  };
  const result = await healMalformedJson('{"a":1,}', deps);
  assert.deepEqual(result, { a: 1, fixed: true });
});

test("healMalformedJson returns null when callHeal returns null", async () => {
  const deps: HealIntegrationDeps = {
    callHeal: async () => null,
  };
  const result = await healMalformedJson('{"a":1}', deps);
  assert.equal(result, null);
});

test("healMalformedJson returns null when healed output is not valid JSON", async () => {
  const deps: HealIntegrationDeps = {
    callHeal: async () => ({ repaired: "not-valid-json{{{" }),
  };
  const result = await healMalformedJson('{"a":1}', deps);
  assert.equal(result, null);
});

test("healMalformedJson returns null on timeout", async () => {
  const deps: HealIntegrationDeps = {
    callHeal: async () => new Promise(() => {}), // never resolves
  };
  const result = await healMalformedJson('{"a":1}', deps, 50);
  assert.equal(result, null);
});

test("healMalformedJson catches thrown errors and returns null", async () => {
  const deps: HealIntegrationDeps = {
    callHeal: async () => {
      throw new Error("engram unreachable");
    },
  };
  const result = await healMalformedJson('{"a":1}', deps);
  assert.equal(result, null);
});

test("healMalformedJson returns null when repaired field is missing", async () => {
  const deps: HealIntegrationDeps = {
    callHeal: async () => ({ source: "jsonrepair" }),
  };
  const result = await healMalformedJson('{"a":1}', deps);
  assert.equal(result, null);
});
