/**
 * Recording commands by URL, so scripts and tools can drive Recordly through its existing
 * URL scheme (e.g. `open recordly://record/stop` on macOS, a Stream Deck or Shortcuts
 * action, `start recordly://record/pause` on Windows):
 *
 *   recordly://record/start | stop | pause | resume | toggle
 *
 * Any web page can open a `recordly://` link, so starting a recording (`start`, or `toggle`
 * while idle) asks the user first. Stopping, pausing and resuming run directly.
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

type RecordingCommandOptions = {
	protocol: string;
	isRecording: () => boolean;
	/** Asks the user; resolves true to go ahead. */
	confirmStart: () => Promise<boolean>;
	/** Delivers the command to the recording controls (the HUD), opening them if needed. */
	send: (command: RecordingCommand) => void;
};

export function createRecordingCommandController({
	protocol,
	isRecording,
	confirmStart,
	send,
}: RecordingCommandOptions) {
	function find(args: readonly string[]) {
		return args.find((arg) => parseRecordingCommandUrl(arg, protocol) !== null) ?? null;
	}

	/** Returns false when the URL isn't a recording command (so other handlers can take it). */
	async function dispatch(rawUrl: string): Promise<boolean> {
		const command = parseRecordingCommandUrl(rawUrl, protocol);
		if (!command) return false;
		if (startsRecording(command, isRecording()) && !(await confirmStart())) {
			return true;
		}
		send(command);
		return true;
	}

	return { find, dispatch };
}
