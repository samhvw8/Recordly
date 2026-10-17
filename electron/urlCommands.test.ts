import { describe, expect, it, vi } from "vitest";
import {
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
	function setup(recording: boolean, confirmed: boolean) {
		const send = vi.fn();
		const confirmStart = vi.fn(async () => confirmed);
		const controller = createRecordingCommandController({
			protocol: "recordly",
			isRecording: () => recording,
			confirmStart,
			send,
		});
		return { controller, send, confirmStart };
	}

	it("stops without asking", async () => {
		const { controller, send, confirmStart } = setup(true, false);
		await expect(controller.dispatch("recordly://record/stop")).resolves.toBe(true);
		expect(confirmStart).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledWith("stop");
	});

	it("asks before starting, and starts only when the user agrees", async () => {
		const agreed = setup(false, true);
		await agreed.controller.dispatch("recordly://record/start");
		expect(agreed.confirmStart).toHaveBeenCalledTimes(1);
		expect(agreed.send).toHaveBeenCalledWith("start");

		const declined = setup(false, false);
		await declined.controller.dispatch("recordly://record/toggle");
		expect(declined.confirmStart).toHaveBeenCalledTimes(1);
		expect(declined.send).not.toHaveBeenCalled();
	});

	it("toggles a running recording off without asking", async () => {
		const { controller, send, confirmStart } = setup(true, false);
		await controller.dispatch("recordly://record/toggle");
		expect(confirmStart).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledWith("toggle");
	});

	it("leaves other URLs to other handlers", async () => {
		const { controller, send } = setup(false, true);
		await expect(controller.dispatch("recordly://auth/callback?code=1")).resolves.toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it("finds the command among command-line arguments", () => {
		const { controller } = setup(false, true);
		expect(
			controller.find(["/Applications/Recordly.app", "--flag", "recordly://record/pause"]),
		).toBe("recordly://record/pause");
		expect(controller.find(["/Applications/Recordly.app"])).toBeNull();
	});
});
