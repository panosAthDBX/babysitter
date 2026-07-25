import { beforeAll, describe, expect, it } from "bun:test";
import { type TodoProjectionPhase, TodoProjectionStore } from "../src/extensibility/extensions/todo-projection";
import { renderTodoProjectionLines } from "../src/modes/interactive-mode";
import { initTheme } from "../src/modes/theme/theme";
import { assistantMsg, createTestSession, userMsg } from "./utilities";

const phase = (status: TodoProjectionPhase["tasks"][number]["status"]): TodoProjectionPhase => ({
	id: "effect-phase",
	name: "Effects",
	tasks: [
		{ id: "one", content: "First effect", status },
		{ id: "two", content: "Second effect", status: "in_progress" },
	],
});

describe("TodoProjectionStore", () => {
	it("keeps concurrent namespaces separate and replaces only the addressed namespace", () => {
		const store = new TodoProjectionStore();
		store.set("zeta", [phase("pending")]);
		store.set("alpha", [
			{ id: "other", name: "Other", tasks: [{ id: "three", content: "Third", status: "failed" }] },
		]);

		expect(store.snapshot().map(item => item.namespace)).toEqual(["alpha", "zeta"]);
		expect(store.snapshot()[1]?.phases[0]?.tasks.filter(task => task.status === "in_progress")).toHaveLength(1);

		store.set("zeta", [phase("completed")]);
		expect(store.snapshot()[0]?.phases[0]?.tasks[0]?.status).toBe("failed");
		expect(store.snapshot()[1]?.phases[0]?.tasks[0]?.status).toBe("completed");
		expect(store.set("alpha", undefined)).toBe(true);
		expect(store.snapshot().map(item => item.namespace)).toEqual(["zeta"]);
	});

	it("supports every terminal state and clones away caller metadata", () => {
		const store = new TodoProjectionStore();
		const source = [
			{
				id: "phase",
				name: "Lifecycle",
				tasks: ["pending", "in_progress", "completed", "failed", "cancelled", "abandoned"].map(status => ({
					id: status,
					content: status,
					status,
					secret: "must-not-render",
				})),
			},
		];
		store.set("owner", source as unknown as TodoProjectionPhase[]);
		source[0]!.tasks[0] = { id: "mutated", content: "mutated", status: "failed", secret: "changed" };

		const snapshot = store.snapshot();
		expect(snapshot[0]?.phases[0]?.tasks.map(task => task.status)).toEqual([
			"pending",
			"in_progress",
			"completed",
			"failed",
			"cancelled",
			"abandoned",
		]);
		expect(snapshot[0]?.phases[0]?.tasks[0]).toEqual({ id: "pending", content: "pending", status: "pending" });
	});

	it("treats identical replacement and repeated removal as no-ops", () => {
		const store = new TodoProjectionStore();
		expect(store.set("owner", [phase("pending")])).toBe(true);
		expect(store.set(" owner ", [phase("pending")])).toBe(false);
		expect(store.snapshot()).toHaveLength(1);
		expect(store.set("owner", undefined)).toBe(true);
		expect(store.set("owner", undefined)).toBe(false);
		expect(store.clear()).toBe(false);
	});

	it("rejects unstable identifiers and duplicate task IDs", () => {
		const store = new TodoProjectionStore();
		expect(() => store.set(" ", [])).toThrow("namespace");
		expect(() => store.set("owner", [{ id: "", name: "Phase", tasks: [] }])).toThrow("phase id");
		expect(() =>
			store.set("owner", [
				{
					id: "phase",
					name: "Phase",
					tasks: [
						{ id: "same", content: "One", status: "pending" },
						{ id: "same", content: "Two", status: "in_progress" },
					],
				},
			]),
		).toThrow("Duplicate todo projection task id");
	});
});

describe("todo projection integration", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders every status, multiple active items, and only allowlisted fields", () => {
		const store = new TodoProjectionStore();
		store.set("zeta", [phase("in_progress")]);
		store.set("alpha", [
			{
				id: "lifecycle",
				name: "Lifecycle",
				tasks: ["pending", "in_progress", "completed", "failed", "cancelled", "abandoned"].map(status => ({
					id: status,
					content: `task-${status}`,
					status,
					secret: "must-not-render",
				})),
			},
		] as unknown as TodoProjectionPhase[]);

		const rendered = Bun.stripANSI(renderTodoProjectionLines(store.snapshot(), 120).join("\n"));
		expect(rendered.indexOf("alpha")).toBeLessThan(rendered.indexOf("zeta"));
		for (const status of ["pending", "in_progress", "completed", "failed", "cancelled", "abandoned"]) {
			expect(rendered).toContain(`task-${status}`);
		}
		expect(rendered).toContain("First effect");
		expect(rendered).toContain("Second effect");
		expect(rendered).not.toContain("must-not-render");
	});

	it("sanitizes ANSI, control bytes, tabs, and newlines in extension-owned labels", () => {
		const store = new TodoProjectionStore();
		store.set("owner\x1b[2J\tname\nnamespace-injected\u0007", [
			{
				id: "phase",
				name: "phase\x1b]0;owned\u0007\tname\nphase-injected\u009b",
				tasks: [
					{
						id: "task",
						content: "task\x1b[31m\tcontent\x1b[0m\ntask-injected\u0000",
						status: "in_progress",
					},
				],
			},
		]);

		const renderedLines = renderTodoProjectionLines(store.snapshot(), 120);
		const rendered = renderedLines.join("\n");
		const lines = renderedLines.map(line => Bun.stripANSI(line));

		expect(lines).toHaveLength(4);
		expect(lines.every(line => !/[\t\r\n\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(line))).toBe(true);
		expect(rendered).not.toContain("\x1b[2J");
		expect(rendered).not.toContain("\x1b]0;owned");
		expect(rendered).not.toContain("\x1b[31m");
		expect(lines[1]).toContain("namespace-injected");
		expect(lines[2]).toContain("phase-injected");
		expect(lines[3]).toContain("task-injected");
	});

	it("truncates every extension-owned projected label to the available HUD width", () => {
		const long = "x".repeat(200);
		const store = new TodoProjectionStore();
		store.set(`namespace-${long}`, [
			{
				id: "phase",
				name: `phase-${long}`,
				tasks: [{ id: "task", content: `task-${long}`, status: "completed" }],
			},
		]);

		const lines = renderTodoProjectionLines(store.snapshot(), 24).map(line => Bun.stripANSI(line));

		expect(lines).toHaveLength(4);
		for (const line of lines.filter(Boolean)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(24);
		expect(lines.join("\n")).not.toContain(long);
	});

	it("keeps canonical todos and transcript entries isolated and clears on a new session", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const other = await createTestSession({ inMemory: true });
		try {
			const nativePhases = [
				{
					name: "User plan",
					tasks: [{ content: "Authored by user", status: "in_progress" as const }],
				},
			];
			ctx.session.setTodoPhases(nativePhases);
			const entriesBefore = ctx.sessionManager.getEntries();
			let projectionEvents = 0;
			const unsubscribe = ctx.session.subscribe(event => {
				if (event.type === "todo_projection_changed") projectionEvents++;
			});

			ctx.session.setTodoProjection("babysitter", [phase("in_progress")]);
			ctx.session.setTodoProjection("babysitter", [phase("in_progress")]);

			expect(ctx.session.getTodoPhases()).toEqual(nativePhases);
			expect(ctx.sessionManager.getEntries()).toEqual(entriesBefore);
			expect(
				ctx.session.getTodoProjections()[0]?.phases[0]?.tasks.filter(task => task.status === "in_progress"),
			).toHaveLength(2);
			expect(ctx.session.getTodoProjections()).toHaveLength(1);
			expect(other.session.getTodoProjections()).toEqual([]);
			expect(projectionEvents).toBe(1);

			await ctx.session.newSession();
			expect(ctx.session.getTodoProjections()).toEqual([]);
			expect(projectionEvents).toBe(2);
			unsubscribe();
		} finally {
			await Promise.all([ctx.cleanup(), other.cleanup()]);
		}
	});

	it("clears stale projections across switch, branch, and tree navigation", async () => {
		const ctx = await createTestSession();
		try {
			ctx.sessionManager.appendMessage(userMsg("first session"));
			await ctx.sessionManager.ensureOnDisk();
			const firstSessionFile = ctx.session.sessionFile;
			expect(firstSessionFile).toBeDefined();

			await ctx.session.newSession();
			ctx.session.setTodoProjection("babysitter", [phase("pending")]);
			expect(await ctx.session.switchSession(firstSessionFile!)).toBe(true);
			expect(ctx.session.getTodoProjections()).toEqual([]);

			const branchId = ctx.sessionManager.appendMessage(userMsg("branch target"));
			ctx.session.setTodoProjection("babysitter", [phase("in_progress")]);
			expect((await ctx.session.branch(branchId)).cancelled).toBe(false);
			expect(ctx.session.getTodoProjections()).toEqual([]);

			await ctx.session.newSession();
			const firstId = ctx.sessionManager.appendMessage(userMsg("tree root"));
			ctx.sessionManager.appendMessage(assistantMsg("reply"));
			ctx.sessionManager.appendMessage(userMsg("tree leaf"));
			ctx.session.setTodoProjection("babysitter", [phase("completed")]);
			expect((await ctx.session.navigateTree(firstId)).cancelled).toBe(false);
			expect(ctx.session.getTodoProjections()).toEqual([]);
		} finally {
			await ctx.cleanup();
		}
	});
});
