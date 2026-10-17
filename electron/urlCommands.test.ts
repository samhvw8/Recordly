import { describe, expect, it, vi } from "vitest";
import {
	createCommandMailbox,
	createRecordingCommandController,
	parseRecordingCommandUrl,
	startsRecording,
} from "./urlCommands";

describe("parseRecordingCommandUrl", () => {
	it.each([
		"start",
		"stop",
		"pause",
		"resume",
		"toggle",
	])("reads recordly://record/%s", (command) => {
		expect(parseRecordingCommandUrl(`recordly://record/${command}`, "recordly")).toBe(command);
	});

	it("accepts a trailing slash", () => {
		expect(parseRecordingCommandUrl("recordly://record/stop/", "recordly")).toBe("stop");
	});

	it.each([
		["another scheme", "recordly-dev://record/stop"],
		["another host", "recordly://auth/stop"],
		["an unknown command", "recordly://record/delete"],
		["credentials", "recordly://user:pass@record/stop"],
		["a query", "recordly://record/start?source=screen:1"],
		["a fragment", "recordly://record/stop#now"],
		["a deeper path", "recordly://record/stop/now"],
		["not a URL", "stop"],
		["a long URL", `recordly://record/stop${"/".repeat(300)}`],
	])("rejects %s", (_label, url) => {
		expect(parseRecordingCommandUrl(url, "recordly")).toBeNull();
	});
});

describe("startsRecording", () => {
	it("treats start, and toggle while idle, as starting a recording", () => {
		expect(startsRecording("start", false)).toBe(true);
		expect(startsRecording("toggle", false)).toBe(true);
		expect(startsRecording("toggle", true)).toBe(false);
		expect(startsRecording("stop", false)).toBe(false);
		expect(startsRecording("pause", true)).toBe(false);
	});
});

describe("createRecordingCommandController", () => {
	function setup(recording: boolean) {
		const send = vi.fn();
		const controller = createRecordingCommandController({
			protocol: "recordly",
			isRecording: () => recording,
			send,
		});
		return { controller, send };
	}

	it("sends stop, pause and resume without asking", () => {
		const { controller, send } = setup(true);
		for (const command of ["stop", "pause", "resume"]) {
			expect(controller.dispatch(`recordly://record/${command}`)).toBe(true);
		}
		expect(send.mock.calls.map(([message]) => message)).toEqual([
			{ command: "stop", confirm: false },
			{ command: "pause", confirm: false },
			{ command: "resume", confirm: false },
		]);
	});

	it("marks commands that would start a recording for confirmation", () => {
		const idle = setup(false);
		idle.controller.dispatch("recordly://record/start");
		idle.controller.dispatch("recordly://record/toggle");
		expect(idle.send.mock.calls.map(([message]) => message)).toEqual([
			{ command: "start", confirm: true },
			{ command: "toggle", confirm: true },
		]);
	});

	it("toggles a running recording off without asking", () => {
		const { controller, send } = setup(true);
		controller.dispatch("recordly://record/toggle");
		expect(send).toHaveBeenCalledWith({ command: "toggle", confirm: false });
	});

	it("leaves other URLs to other handlers", () => {
		const { controller, send } = setup(false);
		expect(controller.dispatch("recordly://auth/callback?code=1")).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it("finds the command among command-line arguments", () => {
		const { controller } = setup(false);
		expect(
			controller.find(["/Applications/Recordly.app", "--flag", "recordly://record/pause"]),
		).toBe("recordly://record/pause");
		expect(controller.find(["/Applications/Recordly.app"])).toBeNull();
	});
});

describe("createCommandMailbox", () => {
	it("keeps commands until the page subscribes, then hands them over in order", () => {
		const mailbox = createCommandMailbox<string>();
		expect(mailbox.post(7, "start")).toBe(false);
		expect(mailbox.post(7, "pause")).toBe(false);
		expect(mailbox.ready(7)).toEqual(["start", "pause"]);
		expect(mailbox.ready(7)).toEqual([]);
	});

	it("sends at once to the page that has subscribed", () => {
		const mailbox = createCommandMailbox<string>();
		mailbox.ready(7);
		expect(mailbox.post(7, "stop")).toBe(true);
		expect(mailbox.ready(7)).toEqual([]);
	});

	it("keeps commands for a new or reloading page until it subscribes again", () => {
		const mailbox = createCommandMailbox<string>();
		mailbox.ready(7);
		expect(mailbox.post(8, "start")).toBe(false);
		mailbox.gone(7);
		expect(mailbox.post(7, "stop")).toBe(false);
		expect(mailbox.ready(7)).toEqual(["start", "stop"]);
	});

	it("keeps only the most recent commands", () => {
		const mailbox = createCommandMailbox<number>(3);
		for (let i = 1; i <= 5; i++) mailbox.post(1, i);
		expect(mailbox.ready(1)).toEqual([3, 4, 5]);
	});
});
