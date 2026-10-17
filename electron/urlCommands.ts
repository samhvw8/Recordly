/**
 * Recording commands by URL, so scripts and tools can drive Recordly through its existing
 * URL scheme (e.g. `open recordly://record/stop` on macOS, a Stream Deck or Shortcuts
 * action, `start recordly://record/pause` on Windows):
 *
 *   recordly://record/start | stop | pause | resume | toggle
 *
 * Any web page can open a `recordly://` link, so a command that would start a recording
 * (`start`, or `toggle` while idle) is sent with `confirm: true`, and the recording controls
 * ask the user inside the HUD first. (A system dialog doesn't work here: since macOS 14 an
 * app can't bring itself to the front, so the dialog opened hidden behind the current app
 * and, being app-modal, also blocked the HUD.) Stopping, pausing and resuming run directly.
 */
export const RECORDING_COMMANDS = ["start", "stop", "pause", "resume", "toggle"] as const;
export type RecordingCommand = (typeof RECORDING_COMMANDS)[number];

const MAX_COMMAND_URL_LENGTH = 256;

export function parseRecordingCommandUrl(
	rawUrl: string,
	protocol: string,
): RecordingCommand | null {
	if (rawUrl.length > MAX_COMMAND_URL_LENGTH) return null;
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}
	if (url.protocol !== `${protocol}:` || url.hostname !== "record") return null;
	if (url.username || url.password || url.search || url.hash) return null;
	const command = url.pathname.replace(/^\/|\/$/g, "");
	return (RECORDING_COMMANDS as readonly string[]).includes(command)
		? (command as RecordingCommand)
		: null;
}

/** True when the command would start a recording, which needs the user's consent. */
export function startsRecording(command: RecordingCommand, recording: boolean) {
	return command === "start" || (command === "toggle" && !recording);
}

export type RecordingCommandMessage = { command: RecordingCommand; confirm: boolean };

type RecordingCommandOptions = {
	protocol: string;
	isRecording: () => boolean;
	/** Delivers the command to the recording controls (the HUD), opening them if needed. */
	send: (message: RecordingCommandMessage) => void;
};

export function createRecordingCommandController({
	protocol,
	isRecording,
	send,
}: RecordingCommandOptions) {
	function find(args: readonly string[]) {
		return args.find((arg) => parseRecordingCommandUrl(arg, protocol) !== null) ?? null;
	}

	/** Returns false when the URL isn't a recording command (so other handlers can take it). */
	function dispatch(rawUrl: string): boolean {
		const command = parseRecordingCommandUrl(rawUrl, protocol);
		if (!command) return false;
		send({ command, confirm: startsRecording(command, isRecording()) });
		return true;
	}

	return { find, dispatch };
}

/**
 * Holds commands until the HUD page has subscribed to them. A link can arrive while the HUD is
 * still loading (at launch, or when the link itself opened the HUD) or reloading, and a message
 * sent then is lost. The page reports `ready` when it subscribes; `gone` when it unloads.
 */
export function createCommandMailbox<T>(limit = 8) {
	let readyId: number | null = null;
	let kept: T[] = [];
	return {
		/** True when `message` can be sent to page `targetId` now; otherwise it is kept. */
		post(targetId: number, message: T): boolean {
			if (targetId === readyId) return true;
			kept = [...kept, message].slice(-limit);
			return false;
		},
		/** Page `id` has subscribed: returns the kept commands, oldest first, for it to receive. */
		ready(id: number): T[] {
			readyId = id;
			const delivered = kept;
			kept = [];
			return delivered;
		},
		/** Page `id` unloaded (reload, crash, close): keep commands until a page subscribes again. */
		gone(id: number) {
			if (readyId === id) readyId = null;
		},
	};
}
