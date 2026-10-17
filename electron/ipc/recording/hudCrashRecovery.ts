export type StopResult = {
	success: boolean;
	path?: string;
	message?: string;
	error?: string;
};

type CrashableWebContents = {
	once(
		event: "render-process-gone",
		listener: (event: unknown, details: { reason: string }) => void,
	): unknown;
};

export type HudCrashRecoveryDeps = {
	/** Resolves when no start-native-screen-recording call is still running. */
	startSettled: () => Promise<void>;
	/** True while a native screen recording runs and nobody asked it to stop. */
	isRecordingWithoutStopRequest: () => boolean;
	/** True after set-recording-state(true): the user sees a recording, not a countdown. */
	isUserRecording: () => boolean;
	stopRecording: () => Promise<StopResult>;
	/** Work the renderer normally does after a stop (the Windows mux). */
	finishRecording: (stopped: StopResult) => Promise<StopResult>;
	/** Deletes a capture the user never started (warm start, countdown). */
	discardRecording: (path: string) => Promise<void>;
	/**
	 * Windows only: a stopped capture whose file still waits for the renderer's mux.
	 * Resolves to null when there is none or its file is already gone.
	 */
	takePendingStoppedVideo: () => Promise<string | null>;
	/** Runs the Windows mux for the pending stopped video. */
	muxPendingStoppedVideo: () => Promise<StopResult>;
	setRecordingState: (recording: boolean) => void;
	reportRecovered: (result: StopResult, reason: string) => Promise<void>;
};

const watched = new WeakSet<object>();

/**
 * Stops a native recording when the renderer that controls it dies (issue #1139).
 *
 * The HUD renderer owns the Stop button. If it crashes mid-recording, the capture helper
 * keeps writing, the tray Stop item talks to the dead renderer, and quitting kills the helper
 * before the MP4 gets its moov atom. This finishes the recording the same way Stop does,
 * so the file stays playable and the app leaves the recording state.
 *
 * A capture that was only warm-started for the countdown is stopped and deleted instead,
 * as the renderer does when a countdown is cancelled.
 *
 * Each webContents is watched once, however many recordings it starts.
 */
export function stopRecordingWhenHudGoes(hud: CrashableWebContents, deps: HudCrashRecoveryDeps) {
	if (watched.has(hud)) {
		return;
	}
	watched.add(hud);
	hud.once("render-process-gone", (_event, details) => {
		watched.delete(hud);
		if (details.reason === "clean-exit") {
			return;
		}
		void recover(deps, details.reason).catch((error) => {
			console.error("[hud-crash-recovery] Recovery failed:", error);
		});
	});
}

async function recover(deps: HudCrashRecoveryDeps, reason: string) {
	// A start still waiting for the helper would otherwise finish with no HUD to stop it.
	await deps.startSettled();
	if (!deps.isRecordingWithoutStopRequest()) {
		// On Windows the renderer muxes the audio after its Stop went through. If it died in
		// between, the stopped file is still waiting. The renderer has already left the
		// recording state by then, so this can't tell a recording from a countdown; it keeps
		// whatever file is there rather than risk deleting a real recording.
		if (await deps.takePendingStoppedVideo()) {
			console.error(
				`[hud-crash-recovery] HUD renderer gone (${reason}) before its mux; muxing the stopped recording`,
			);
			let muxed: StopResult;
			try {
				muxed = await deps.muxPendingStoppedVideo();
			} catch (error) {
				muxed = { success: false, error: String(error) };
			}
			deps.setRecordingState(false);
			await deps.reportRecovered(muxed, reason);
		}
		return;
	}
	const userRecording = deps.isUserRecording();
	console.error(
		`[hud-crash-recovery] HUD renderer gone (${reason}) during a ${
			userRecording ? "recording" : "countdown"
		}; stopping it`,
	);

	let result: StopResult;
	try {
		result = await deps.stopRecording();
		if (result.success && userRecording) {
			result = await deps.finishRecording(result);
		}
	} catch (error) {
		result = { success: false, error: String(error) };
	}

	if (!userRecording) {
		if (result.success && result.path) {
			await deps.discardRecording(result.path);
		} else if (!result.success) {
			console.error("[hud-crash-recovery] Could not stop the countdown capture:", result);
		}
		return;
	}
	deps.setRecordingState(false);
	await deps.reportRecovered(result, reason);
}

/** What main knows about the native capture, read at the moment recovery needs it. */
export type NativeCaptureState = {
	macActive: boolean;
	macStopRequested: boolean;
	windowsActive: boolean;
	windowsStopRequested: boolean;
	userRecording: boolean;
};

/**
 * Builds the recovery steps from main's capture state and handlers, so the platform rules
 * (Windows needs the mux the renderer would have run) are testable without Electron.
 */
export function createHudCrashRecoveryDeps(io: {
	captureState: () => NativeCaptureState;
	startSettled: () => Promise<void>;
	stopNativeScreenRecording: () => Promise<StopResult>;
	muxNativeWindowsRecording: () => Promise<StopResult>;
	clearWindowsPendingVideo: () => void;
	windowsPendingVideoPath: () => string | null;
	fileExists: (filePath: string) => Promise<boolean>;
	deleteFile: (filePath: string) => Promise<void>;
	telemetryPathFor: (videoPath: string) => string;
	setRecordingState: (recording: boolean) => void;
	reportRecovered: (result: StopResult, reason: string) => Promise<void>;
}): HudCrashRecoveryDeps {
	// Read before stopping: the stop clears the active flags.
	let stoppedWindowsCapture = false;
	return {
		startSettled: io.startSettled,
		isRecordingWithoutStopRequest: () => {
			const state = io.captureState();
			return (
				(state.macActive && !state.macStopRequested) ||
				(state.windowsActive && !state.windowsStopRequested)
			);
		},
		isUserRecording: () => io.captureState().userRecording,
		stopRecording: () => {
			stoppedWindowsCapture = io.captureState().windowsActive;
			return io.stopNativeScreenRecording();
		},
		// On Windows the renderer muxes the audio after a stop; do it here instead.
		finishRecording: async (stopped) =>
			stoppedWindowsCapture ? await io.muxNativeWindowsRecording() : stopped,
		discardRecording: async (videoPath) => {
			io.clearWindowsPendingVideo();
			await io.deleteFile(videoPath);
			await io.deleteFile(io.telemetryPathFor(videoPath));
		},
		takePendingStoppedVideo: async () => {
			const pending = io.windowsPendingVideoPath();
			if (!pending) {
				return null;
			}
			if (await io.fileExists(pending)) {
				return pending;
			}
			// The renderer already deleted it (a cancelled countdown): forget the stale path.
			io.clearWindowsPendingVideo();
			return null;
		},
		muxPendingStoppedVideo: () => io.muxNativeWindowsRecording(),
		setRecordingState: io.setRecordingState,
		reportRecovered: io.reportRecovered,
	};
}

/**
 * Tracks start calls that are still running. `settled` waits for every one of them,
 * including starts that overlap, not only the latest.
 */
export function createStartTracker() {
	let inFlight: Promise<unknown> = Promise.resolve();
	return {
		track:
			<A extends unknown[], R>(start: (...args: A) => Promise<R>) =>
			(...args: A): Promise<R> => {
				const started = start(...args);
				inFlight = Promise.allSettled([inFlight, started]);
				return started;
			},
		settled: () => inFlight.then(() => undefined),
	};
}
