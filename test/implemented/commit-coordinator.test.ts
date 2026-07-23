import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectCommitCoordinator } from "../../src/write/commit-coordinator.js";

test("same-project commits execute in submission order without overlap", async () => {
  const coordinator = new ProjectCommitCoordinator();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = coordinator.run("project-a", async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
    return 1;
  });
  const second = coordinator.run("project-a", async () => {
    events.push("second:start");
    events.push("second:end");
    return 2;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end"
  ]);
});

test("different projects can prepare and commit concurrently", async () => {
  const coordinator = new ProjectCommitCoordinator();
  const started = new Set<string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const action = (projectId: string) => coordinator.run(
    projectId,
    async () => {
      started.add(projectId);
      await gate;
      return projectId;
    }
  );

  const first = action("project-a");
  const second = action("project-b");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...started].sort(), ["project-a", "project-b"]);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    "project-a",
    "project-b"
  ]);
});

test("a failed commit does not poison the following project queue", async () => {
  const coordinator = new ProjectCommitCoordinator();
  const failed = coordinator.run("project-a", async () => {
    throw new Error("expected");
  });
  const recovered = coordinator.run("project-a", async () => "recovered");

  await assert.rejects(failed, /expected/);
  assert.equal(await recovered, "recovered");
  assert.equal(coordinator.pendingProjectCount, 0);
});
