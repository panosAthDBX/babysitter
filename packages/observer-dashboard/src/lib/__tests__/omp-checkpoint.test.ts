import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBabysitterCheckpoint } from "../parser";
import type { TaskEffect } from "@/types";

const tempDirs: string[] = [];
const schemaVersion = "2026.07.omp-driver-v1";

async function createRun(): Promise<string> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "observer-omp-checkpoint-"));
  tempDirs.push(runDir);
  return runDir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value));
}

function task(status: TaskEffect["status"] = "requested", kind: TaskEffect["kind"] = "agent") {
  return { effectId: "effect-1", invocationKey: "invocation-1", kind, status };
}

async function writeCompletedAgentExecution(runDir: string, outputBytes: Buffer): Promise<void> {
  const outputSha256 = createHash("sha256").update(outputBytes).digest("hex");
  await writeJson(path.join(runDir, "tasks/effect-1/execution.json"), {
    schemaVersion,
    effectId: "effect-1",
    invocationKey: "invocation-1",
    kind: "agent",
    state: "completed",
    attempt: 1,
    outputRef: "tasks/effect-1/output.json",
    outputSha256,
    authenticatedOutputSha256: outputSha256,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("OMP execution checkpoint parsing", () => {
  it("reports requested and shell-running states", async () => {
    const runDir = await createRun();
    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toEqual({ state: "requested" });

    await writeJson(path.join(runDir, "tasks/effect-1/execution.json"), {
      schemaVersion,
      effectId: "effect-1",
      invocationKey: "invocation-1",
      kind: "shell",
      state: "in_progress",
    });
    await expect(parseBabysitterCheckpoint(runDir, task("requested", "shell"))).resolves.toEqual({
      state: "shell-running",
    });
  });

  it("links an allocator-suffixed checkpointed owner reference", async () => {
    const runDir = await createRun();
    await writeJson(path.join(runDir, "tasks/effect-1/execution.json"), {
      schemaVersion,
      effectId: "effect-1",
      invocationKey: "invocation-1",
      kind: "agent",
      state: "in_progress",
      attempt: 2,
      attemptState: "claimed",
      ownerName: "Babysitter-effect-1",
      dispatchToken: "dispatch-1",
    });
    await writeJson(path.join(runDir, "tasks/effect-1/agent-owner.json"), {
      schemaVersion,
      effectId: "effect-1",
      invocationKey: "invocation-1",
      ownerName: "Babysitter-effect-1",
      dispatchToken: "dispatch-1",
      attempt: 2,
      toolCallId: "tool-call-1",
      claimedAt: "2026-07-24T00:00:00.000Z",
      agentRef: "agent://Babysitter-effect-1-2",
      transcript: "must never be copied",
    });

    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toEqual({
      state: "agent-owned",
      attempt: 2,
      agentRef: "agent://Babysitter-effect-1-2",
    });
  });

  it("rejects forged handles and identifies a retained late owner", async () => {
    const runDir = await createRun();
    const execution = {
      schemaVersion,
      effectId: "effect-1",
      invocationKey: "invocation-1",
      kind: "agent",
      state: "in_progress",
      attempt: 1,
      attemptState: "awaiting_late_owner",
      ownerName: "Babysitter-effect-1",
      dispatchToken: "dispatch-1",
    };
    await writeJson(path.join(runDir, "tasks/effect-1/execution.json"), execution);
    const ownerPath = path.join(runDir, "tasks/effect-1/agent-owner.json");
    await writeJson(ownerPath, {
      schemaVersion,
      effectId: "effect-1",
      invocationKey: "invocation-1",
      ownerName: "Babysitter-effect-1",
      dispatchToken: "dispatch-1",
      attempt: 1,
      toolCallId: "tool-call-1",
      agentRef: "agent://forged-owner",
    });
    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toMatchObject({
      state: "failed/attention",
      attention: "Forged or non-owner agent reference",
    });

    for (const forgedLookalike of [
      "agent://Babysitter-effect-1-1",
      "agent://Babysitter-effect-1-02",
      "agent://Babysitter-effect-1-2evil",
      "agent://Babysitter-effect-1-copy",
    ]) {
      await writeJson(ownerPath, {
        schemaVersion,
        effectId: "effect-1",
        invocationKey: "invocation-1",
        ownerName: "Babysitter-effect-1",
        dispatchToken: "dispatch-1",
        attempt: 1,
        toolCallId: "tool-call-1",
        agentRef: forgedLookalike,
      });
      await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toMatchObject({
        state: "failed/attention",
        attention: "Forged or non-owner agent reference",
      });
    }

    await writeJson(ownerPath, {
      schemaVersion,
      effectId: "effect-1",
      invocationKey: "invocation-1",
      ownerName: "Babysitter-effect-1",
      dispatchToken: "dispatch-1",
      attempt: 1,
      toolCallId: "tool-call-1",
    });
    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toEqual({
      state: "awaiting-late-owner",
      attempt: 1,
    });
  });

  it("distinguishes durable uncommitted output while canonical journal resolution wins", async () => {
    const runDir = await createRun();
    const output = { approved: true };
    await writeJson(path.join(runDir, "tasks/effect-1/execution.json"), {
      schemaVersion,
      effectId: "effect-1",
      invocationKey: "invocation-1",
      kind: "agent",
      state: "completed",
      attempt: 1,
      outputRef: "tasks/effect-1/output.json",
      outputSha256: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
      authenticatedOutputSha256: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
    });
    await writeJson(path.join(runDir, "tasks/effect-1/output.json"), output);

    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toEqual({
      state: "durable-output-uncommitted",
      attempt: 1,
    });
    await writeJson(path.join(runDir, "tasks/effect-1/output.json"), { approved: false });
    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toEqual({
      state: "failed/attention",
      attention: "Durable output checksum mismatch",
    });
    await fs.writeFile(path.join(runDir, "tasks/effect-1/execution.json"), "not-json");
    await expect(parseBabysitterCheckpoint(runDir, task("resolved"))).resolves.toEqual({ state: "committed" });
    await expect(parseBabysitterCheckpoint(runDir, task("error"))).resolves.toEqual({ state: "committed" });
  });

  it("fails closed when a completed checkpoint omits required output integrity", async () => {
    const runDir = await createRun();
    const output = { approved: true };
    const executionPath = path.join(runDir, "tasks/effect-1/execution.json");
    await writeJson(path.join(runDir, "tasks/effect-1/output.json"), output);
    const completed = {
      schemaVersion,
      effectId: "effect-1",
      invocationKey: "invocation-1",
      kind: "agent",
      state: "completed",
      attempt: 1,
      outputRef: "tasks/effect-1/output.json",
    };

    await writeJson(executionPath, completed);
    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toEqual({
      state: "failed/attention",
      attention: "Durable output checksum is missing",
    });

    const outputSha256 = createHash("sha256").update(JSON.stringify(output)).digest("hex");
    await writeJson(executionPath, { ...completed, outputSha256 });
    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toEqual({
      state: "failed/attention",
      attention: "Authenticated agent output checksum is missing",
    });

    await writeJson(executionPath, {
      ...completed,
      outputSha256,
      authenticatedOutputSha256: "0".repeat(64),
    });
    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toEqual({
      state: "failed/attention",
      attention: "Authenticated agent output checksum mismatch",
    });
  });

  it("rejects unsafe effect identities before constructing artifact paths", async () => {
    const runDir = await createRun();

    await expect(parseBabysitterCheckpoint(runDir, {
      ...task(),
      effectId: "../escaped",
    })).resolves.toEqual({
      state: "failed/attention",
      attention: "Unsafe effect checkpoint identity",
    });
  });

  it("surfaces malformed or version-mismatched artifacts as attention", async () => {
    const runDir = await createRun();
    const executionPath = path.join(runDir, "tasks/effect-1/execution.json");
    await fs.mkdir(path.dirname(executionPath), { recursive: true });
    await fs.writeFile(executionPath, "{");
    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toMatchObject({ state: "failed/attention" });

    await writeJson(executionPath, {
      schemaVersion: "2025.01.incompatible",
      effectId: "effect-1",
      invocationKey: "invocation-1",
      kind: "agent",
      state: "in_progress",
    });
    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toMatchObject({
      state: "failed/attention",
      attention: expect.stringContaining("version mismatch"),
    });
  });

  it("rejects task-directory and durable-output filesystem aliases", async () => {
    const runDir = await createRun();
    const externalDir = await createRun();
    await writeJson(path.join(externalDir, "execution.json"), {
      schemaVersion,
      effectId: "effect-1",
      invocationKey: "invocation-1",
      kind: "agent",
      state: "in_progress",
    });
    await fs.mkdir(path.join(runDir, "tasks"), { recursive: true });
    await fs.symlink(externalDir, path.join(runDir, "tasks/effect-1"), "dir");
    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toEqual({
      state: "failed/attention",
      attention: "Unsafe effect checkpoint path",
    });

    await fs.rm(path.join(runDir, "tasks/effect-1"));
    const outputBytes = Buffer.from('{"approved":true}');
    await writeCompletedAgentExecution(runDir, outputBytes);
    const externalOutput = path.join(externalDir, "external-output.json");
    await fs.writeFile(externalOutput, outputBytes);
    const outputPath = path.join(runDir, "tasks/effect-1/output.json");
    await fs.symlink(externalOutput, outputPath);
    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toEqual({
      state: "failed/attention",
      attention: "Durable output checkpoint is unsafe or unstable",
    });

    await fs.rm(outputPath);
    await fs.link(externalOutput, outputPath);
    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toEqual({
      state: "failed/attention",
      attention: "Durable output checkpoint is unsafe or unstable",
    });
  });

  it("bounds durable-output reads before hashing", async () => {
    const runDir = await createRun();
    const outputBytes = Buffer.alloc(1024 * 1024 + 1, 0x61);
    await writeCompletedAgentExecution(runDir, outputBytes);
    await fs.writeFile(path.join(runDir, "tasks/effect-1/output.json"), outputBytes);

    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toEqual({
      state: "failed/attention",
      attention: "Durable output exceeds 1048576 bytes",
    });
  });

  it("rejects a durable output replaced during the authenticated read", async () => {
    const runDir = await createRun();
    const outputBytes = Buffer.from('{"approved":true}');
    await writeCompletedAgentExecution(runDir, outputBytes);
    const outputPath = path.join(runDir, "tasks/effect-1/output.json");
    const replacementPath = path.join(runDir, "tasks/effect-1/replacement.json");
    await fs.writeFile(outputPath, outputBytes);
    await fs.writeFile(replacementPath, outputBytes);

    const realLstat = fs.lstat.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
      if (!replaced && path.resolve(String(candidate)) === outputPath) {
        replaced = true;
        await fs.rename(replacementPath, outputPath);
      }
      return realLstat(candidate, options as never);
    });

    await expect(parseBabysitterCheckpoint(runDir, task())).resolves.toEqual({
      state: "failed/attention",
      attention: "Durable output checkpoint is unsafe or unstable",
    });
    expect(replaced).toBe(true);
  });
});
