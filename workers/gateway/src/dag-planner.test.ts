import { test } from "node:test";
import assert from "node:assert/strict";
import { SimpleDAGPlanner, hasCycle, topologicalOrder } from "./dag-planner.ts";

test("Single-intent returns 1-node DAG", () => {
  const p = new SimpleDAGPlanner();
  const d = p.plan({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] });
  assert.equal(d.nodes.length, 1);
  assert.equal(d.root, "n0");
  assert.deepEqual(d.nodes[0].depends_on, []);
});

test("Multi-intent with 'and' produces 2 nodes", () => {
  const p = new SimpleDAGPlanner();
  const d = p.plan({ model: "gpt-4", messages: [{ role: "user", content: "summarize email and draft reply" }] });
  assert.equal(d.nodes.length, 2);
  assert.equal(d.nodes[0].id, "n0");
  assert.equal(d.nodes[1].id, "n1");
  assert.deepEqual(d.nodes[1].depends_on, ["n0"]);
});

test("Multi-intent with 'then' produces 2 nodes", () => {
  const p = new SimpleDAGPlanner();
  const d = p.plan({ model: "gpt-4", messages: [{ role: "user", content: "fetch data then summarize" }] });
  assert.equal(d.nodes.length, 2);
});

test("Multiple user messages produce multi-node DAG", () => {
  const p = new SimpleDAGPlanner();
  const d = p.plan({
    model: "gpt-4",
    messages: [
      { role: "user", content: "first task" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second task" },
    ],
  });
  assert.equal(d.nodes.length, 2);
});

test("hasCycle detects cycles", () => {
  const cycle = {
    nodes: [
      { id: "a", function_id: "f", payload: {}, depends_on: ["b"] },
      { id: "b", function_id: "f", payload: {}, depends_on: ["a"] },
    ],
    root: "a",
  };
  assert.equal(hasCycle(cycle), true);
});

test("hasCycle returns false for valid DAG", () => {
  const valid = {
    nodes: [
      { id: "n0", function_id: "f", payload: {}, depends_on: [] },
      { id: "n1", function_id: "f", payload: {}, depends_on: ["n0"] },
    ],
    root: "n0",
  };
  assert.equal(hasCycle(valid), false);
});

test("topologicalOrder returns deps first", () => {
  const valid = {
    nodes: [
      { id: "n0", function_id: "f", payload: {}, depends_on: [] },
      { id: "n1", function_id: "f", payload: {}, depends_on: ["n0"] },
      { id: "n2", function_id: "f", payload: {}, depends_on: ["n0"] },
    ],
    root: "n0",
  };
  const order = topologicalOrder(valid);
  assert.equal(order[0], "n0");
  assert.ok(order.includes("n1"));
  assert.ok(order.includes("n2"));
});

test("topologicalOrder throws on cycle", () => {
  const cycle = {
    nodes: [
      { id: "a", function_id: "f", payload: {}, depends_on: ["b"] },
      { id: "b", function_id: "f", payload: {}, depends_on: ["a"] },
    ],
    root: "a",
  };
  assert.throws(() => topologicalOrder(cycle), /cycle/);
});
