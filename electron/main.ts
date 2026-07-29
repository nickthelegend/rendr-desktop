import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	app,
	BrowserWindow,
	desktopCapturer,
	dialog,
	webContents as electronWebContents,
	ipcMain,
	Menu,
	Notification,
	nativeImage,
	session,
	shell,
	systemPreferences,
	Tray,
} from "electron";
import { RECORDINGS_DIR } from "./appPaths";
import { registerClaudeCli, stopClaudeCli } from "./claudeCli";
import { showCursor } from "./cursorHider";
import { registerExtensionIpcHandlers } from "./extensions/extensionIpc";
import { getGpuSwitches } from "./gpuSwitches";
import {
	cleanupAllExportStreams,
	cleanupNativeVideoExportSessions,
	getSelectedSourceId,
	killWindowsCaptureProcess,
	registerIpcHandlers,
} from "./ipc/handlers";
import { startMcpServer, stopMcpServer } from "./mcp";
import { ensureMediaServer } from "./mediaServer";
import { hardenWebContentsNavigation, shouldHardenWebContentsType } from "./navigationPolicy";
import { shouldGrantDisplayCapture, shouldGrantMediaPermission } from "./permissionPolicy";
import { ensurePackagedRendererServer, getPackagedRendererBaseUrl } from "./rendererServer";
import { registerTranscribe } from "./transcribe";
import type { UpdateToastPayload } from "./updater";
import {
	checkForAppUpdates,
	deferUpdateReminder,
	dismissUpdateToast,
	downloadAvailableUpdate,
	getCurrentUpdateToastPayload,
	getUpdaterLogPath,
	getUpdateStatusSummary,
	installDownloadedUpdateNow,
	previewUpdateToast,
	setupAutoUpdates,
	skipAvailableUpdateVersion,
} from "./updater";
import {
	closeRendrBarWindow,
	createEditorWindow,
	createHudOverlayWindow,
	createRendrBarWindow,
	createSourceSelectorWindow,
	getHudOverlayWindow,
	getRendrBarWindow,
	getUpdateToastWindow,
	hideUpdateToastWindow,
	isHudOverlayMousePassthroughSupported,
	reassertHudOverlayMousePassthrough as reassertHudOverlayMouseState,
	setHudOverlayRecordingActive,
	showUpdateToastWindow,
} from "./windows";

const electronMainDir = path.dirname(fileURLToPath(import.meta.url));
const IS_SMOKE_EXPORT = process.env.RECORDLY_SMOKE_EXPORT === "1";

function ignoreBrokenConsolePipe(stream: NodeJS.WritableStream | undefined) {
	stream?.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") {
			return;
		}
		throw error;
	});
}

ignoreBrokenConsolePipe(process.stdout);
ignoreBrokenConsolePipe(process.stderr);

app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-unsafe-webgpu");
app.commandLine.appendSwitch("enable-gpu-rasterization");

app.on("web-contents-created", (_event, contents) => {
	if (!shouldHardenWebContentsType(contents.getType())) {
		return;
	}

	hardenWebContentsNavigation(contents, (url) => shell.openExternal(url));
});

function configureGpuAccelerationSwitches() {
	const { useAngle, useGl, disableFeatures } = getGpuSwitches(process.platform, process.env);
	if (useAngle) {
		app.commandLine.appendSwitch("use-angle", useAngle);
	}
	if (useGl) {
		app.commandLine.appendSwitch("use-gl", useGl);
	}
	if (disableFeatures && disableFeatures.length > 0) {
		app.commandLine.appendSwitch("disable-features", disableFeatures.join(","));
	}
}

async function logSmokeExportGpuDiagnostics() {
	if (!IS_SMOKE_EXPORT) {
		return;
	}

	try {
		console.log("[smoke-export] GPU feature status", JSON.stringify(app.getGPUFeatureStatus()));
		console.log("[smoke-export] GPU info", JSON.stringify(await app.getGPUInfo("basic")));
	} catch (error) {
		console.warn("[smoke-export] Failed to read GPU diagnostics:", error);
	}
}

configureGpuAccelerationSwitches();

async function ensureRecordingsDir() {
	try {
		await fs.mkdir(RECORDINGS_DIR, { recursive: true });
		console.log("RECORDINGS_DIR:", RECORDINGS_DIR);
		console.log("User Data Path:", app.getPath("userData"));
	} catch (error) {
		console.error("Failed to create recordings directory:", error);
	}
}

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(electronMainDir, "..");

// Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");
const IS_DEV = Boolean(VITE_DEV_SERVER_URL);

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
	? path.join(process.env.APP_ROOT, "public")
	: RENDERER_DIST;

function getTrustedCaptureDocumentBaseUrls(): string[] {
	const trustedUrls = [pathToFileURL(path.join(RENDERER_DIST, "index.html")).href];

	if (VITE_DEV_SERVER_URL) {
		trustedUrls.push(VITE_DEV_SERVER_URL);
	}

	const packagedRendererBaseUrl = getPackagedRendererBaseUrl();
	if (packagedRendererBaseUrl) {
		trustedUrls.push(new URL("/", packagedRendererBaseUrl).href);
	}

	return trustedUrls;
}

function isHudWebContents(webContents: Electron.WebContents | null): boolean {
	if (!webContents || webContents.isDestroyed()) {
		return false;
	}

	const hudWindow = getHudOverlayWindow();
	return Boolean(hudWindow && hudWindow.webContents === webContents);
}

/**
 * Which of Rendr's windows may capture the screen.
 *
 * Recordly only ever recorded from its HUD, so the HUD was the whole list.
 * Rendr also records from the editor — the Record button, the Record panel, and
 * the agent's start_recording all live there — so the editor has to be on it or
 * capture is refused with a bare "Permission denied".
 *
 * The boundary is unchanged in substance: the caller must still be one of
 * Rendr's own top-level windows, the request must still come from the main
 * frame, and the document URL and security origin are still checked against the
 * trusted renderer base URLs. Widening it to a second window Rendr itself owns
 * doesn't let anything new in — it names a window that was already ours.
 */
function isTrustedCaptureWebContents(webContents: Electron.WebContents | null): boolean {
	if (!webContents || webContents.isDestroyed()) {
		return false;
	}
	if (isHudWebContents(webContents)) return true;

	for (const candidate of [editorWindowRef, mainWindow]) {
		if (candidate && !candidate.isDestroyed() && candidate.webContents === webContents) {
			return true;
		}
	}
	return false;
}

// Window references
let mainWindow: BrowserWindow | null = null;
/**
 * The editor window specifically. `mainWindow` follows whichever window is
 * current — the HUD at launch, the editor later — so agent edits have to target
 * this instead, or they land on the recording HUD and get refused.
 */
let editorWindowRef: BrowserWindow | null = null;
let sourceSelectorWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayContextMenu: Menu | null = null;
let selectedSourceName = "";
let editorHasUnsavedChanges = false;
let isForceClosing = false;
let isCreatingMainWindow = false;
let isCreatingEditorWindow = false;
let activeUpdateNotification: Notification | null = null;
let activeUpdateNotificationKey: string | null = null;
const shouldEnforceSingleInstanceLock = !IS_DEV;
const hasSingleInstanceLock = shouldEnforceSingleInstanceLock
	? app.requestSingleInstanceLock()
	: true;

if (!hasSingleInstanceLock) {
	app.quit();
}

function closeEditorWindowBypassingUnsavedPrompt(window: BrowserWindow | null) {
	if (!window || window.isDestroyed()) {
		return;
	}

	if (isEditorWindow(window)) {
		isForceClosing = true;
		editorHasUnsavedChanges = false;
	}
	window.close();
}

function restoreWindowSafely(window: BrowserWindow | null) {
	if (!window || window.isDestroyed()) {
		return;
	}

	if (!isEditorWindow(window) && process.platform === "win32") {
		showHudOverlayFromTray();
		return;
	}

	if (window.isMinimized()) {
		window.restore();
	}

	if (!window.isVisible()) {
		window.show();
	}

	window.moveTop();
	window.focus();
}

function getExistingEditorWindow(): BrowserWindow | null {
	return (
		BrowserWindow.getAllWindows().find(
			(window) => !window.isDestroyed() && isEditorWindow(window),
		) ?? null
	);
}

// Tray Icons (lazily created after app is ready to avoid accessing Electron APIs too early)
let defaultTrayIcon: ReturnType<typeof getTrayIcon> | null = null;
let recordingTrayIcon: ReturnType<typeof getTrayIcon> | null = null;

function getPlatformAppIconFilename(size: 32 | 128 | 512) {
	const baseName = process.platform === "darwin" ? "recordlymac" : "recordly";
	return `app-icons/${baseName}-${size}.png`;
}

function getDefaultTrayIcon() {
	if (!defaultTrayIcon) {
		defaultTrayIcon = getTrayIcon(getPlatformAppIconFilename(32));
	}
	return defaultTrayIcon;
}

function getRecordingTrayIcon() {
	if (!recordingTrayIcon) {
		recordingTrayIcon = getTrayIcon("rec-button.png");
	}
	return recordingTrayIcon;
}

function showHudOverlayFromTray() {
	const hud = getHudOverlayWindow();
	if (!hud) {
		return false;
	}

	if (hud.isMinimized()) {
		hud.restore();
	}

	if (process.platform === "win32" && isHudOverlayMousePassthroughSupported()) {
		hud.showInactive();
		hud.moveTop();
		reassertHudOverlayMouseState();
		return true;
	}

	hud.show();
	hud.moveTop();
	hud.focus();
	return true;
}

ipcMain.on("set-has-unsaved-changes", (_event, hasChanges: boolean) => {
	editorHasUnsavedChanges = hasChanges;
});

function createWindow() {
	if (!app.isReady()) {
		void app.whenReady().then(() => {
			if (!mainWindow || mainWindow.isDestroyed()) {
				createWindow();
			}
		});
		return;
	}

	if (isCreatingMainWindow) {
		return;
	}

	if (mainWindow && !mainWindow.isDestroyed()) {
		restoreWindowSafely(mainWindow);
		return;
	}

	const existingHudWindow = getHudOverlayWindow();
	if (existingHudWindow) {
		mainWindow = existingHudWindow;
		restoreWindowSafely(existingHudWindow);
		return;
	}

	isCreatingMainWindow = true;
	const createdHudWindow = createHudOverlayWindow();
	mainWindow = createdHudWindow;
	createdHudWindow.once("closed", () => {
		if (mainWindow === createdHudWindow) {
			mainWindow = null;
		}
	});
	isCreatingMainWindow = false;
}

function focusOrCreateMainWindow() {
	if (!app.isReady()) {
		void app.whenReady().then(() => {
			focusOrCreateMainWindow();
		});
		return;
	}

	if (!mainWindow || mainWindow.isDestroyed()) {
		const existingHud = getHudOverlayWindow();
		if (existingHud && !existingHud.isDestroyed()) {
			mainWindow = existingHud;
		} else {
			createWindow();
			return;
		}
	}

	if (mainWindow && !mainWindow.isDestroyed()) {
		// On Linux/Wayland, focus() often doesn't take effect (compositor ignores it). Apps like Telegram
		// work because they receive an XDG activation token via StatusNotifierItem.ProvideXdgActivationToken;
		// Electron's tray doesn't handle that yet. Workaround: destroy and recreate the HUD so the new
		// window gets focus (creation path works). Only for HUD, not editor.
		if (
			process.platform === "linux" &&
			!mainWindow.isFocused() &&
			!isEditorWindow(mainWindow)
		) {
			const win = mainWindow;
			mainWindow = null;
			win.once("closed", () => createWindow());
			win.destroy();
			return;
		}

		// On Win32 with mouse passthrough enabled (Win11+), calling
		// show/moveTop/focus on the transparent HUD overlay permanently corrupts
		// setIgnoreMouseEvents forwarding, making it click-through.  Only focus
		// the editor window; the HUD is alwaysOnTop so it doesn't need explicit
		// focus.  On Win10 (passthrough disabled), the HUD is always interactive
		// and can be safely shown/restored.
		if (
			process.platform === "win32" &&
			!isEditorWindow(mainWindow) &&
			isHudOverlayMousePassthroughSupported()
		) {
			showHudOverlayFromTray();
			return;
		}

		mainWindow.show();
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.moveTop();
		mainWindow.focus();
	}
}

function isEditorWindow(window: BrowserWindow) {
	return window.webContents.getURL().includes("windowType=editor");
}

function sendEditorMenuAction(
	channel: "menu-load-project" | "menu-save-project" | "menu-save-project-as",
) {
	let targetWindow = BrowserWindow.getFocusedWindow() ?? mainWindow;

	if (!targetWindow || targetWindow.isDestroyed() || !isEditorWindow(targetWindow)) {
		createEditorWindowWrapper();
		targetWindow = mainWindow;
		if (!targetWindow || targetWindow.isDestroyed()) return;

		targetWindow.webContents.once("did-finish-load", () => {
			if (!targetWindow || targetWindow.isDestroyed()) return;
			targetWindow.webContents.send(channel);
		});
		return;
	}

	targetWindow.webContents.send(channel);
}

function setupApplicationMenu() {
	const isMac = process.platform === "darwin";
	if (!isMac) {
		Menu.setApplicationMenu(null);
		return;
	}

	const template: Electron.MenuItemConstructorOptions[] = [];
	template.push({
		label: app.name,
		submenu: [
			{ role: "about" },
			{ type: "separator" },
			{ role: "services" },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "unhide" },
			{ type: "separator" },
			{ role: "quit" },
		],
	});

	template.push(
		{
			label: "File",
			submenu: [
				{
					label: "Open Projects…",
					accelerator: "CmdOrCtrl+O",
					click: () => sendEditorMenuAction("menu-load-project"),
				},
				{
					label: "Save Project…",
					accelerator: "CmdOrCtrl+S",
					click: () => sendEditorMenuAction("menu-save-project"),
				},
				{
					label: "Save Project As…",
					accelerator: "CmdOrCtrl+Shift+S",
					click: () => sendEditorMenuAction("menu-save-project-as"),
				},
				...(isMac ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "Window",
			submenu: isMac
				? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
				: [{ role: "minimize" }, { role: "close" }],
		},
		{
			label: "Help",
			submenu: [
				{
					label: "Check for Updates…",
					click: () => {
						void checkForAppUpdates(getUpdateDialogWindow, { manual: true });
					},
				},
			],
		},
	);

	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

function isPrimaryTrayClick(event: unknown) {
	const button =
		event && typeof event === "object" && "button" in event
			? (event as { button?: number | string }).button
			: undefined;
	return button === undefined || button === 0 || button === "left";
}

function createTray() {
	tray = new Tray(getDefaultTrayIcon());
	tray.on("click", (event) => {
		if (process.platform === "win32" && !isPrimaryTrayClick(event)) {
			return;
		}

		focusOrCreateMainWindow();
	});

	if (process.platform === "win32") {
		tray.on("right-click", () => {
			if (!tray || !trayContextMenu) {
				return;
			}

			tray.popUpContextMenu(trayContextMenu);
		});
		return;
	}

	tray.on("double-click", () => focusOrCreateMainWindow());
}

function getPublicAssetPath(filename: string) {
	return path.join(process.env.VITE_PUBLIC || RENDERER_DIST, filename);
}

function getAppImage(filename: string) {
	return nativeImage.createFromPath(getPublicAssetPath(filename));
}

function getTrayIcon(filename: string) {
	return getAppImage(filename).resize({
		width: 24,
		height: 24,
		quality: "best",
	});
}

function syncDockIcon() {
	if (process.platform !== "darwin" || !app.dock) {
		return;
	}

	// Rendr's own mark first. A packaged build takes its icon from
	// electron-builder, but an unpackaged one shows whatever this sets — and
	// this used to set Recordly's, so the app never looked like itself in
	// development.
	const rendrIcon = getRendrAppIcon();
	if (rendrIcon && !rendrIcon.isEmpty()) {
		app.dock.setIcon(rendrIcon);
		return;
	}

	const dockIcon = getAppImage(getPlatformAppIconFilename(512));
	if (!dockIcon.isEmpty()) {
		app.dock.setIcon(dockIcon);
	}
}

/** Rendr's icon, rasterised from public/branding/rendr-mark.svg into build/. */
function getRendrAppIcon(): Electron.NativeImage | null {
	if (cachedRendrIcon !== undefined) return cachedRendrIcon;
	try {
		const iconPath = path.join(process.env.APP_ROOT ?? "", "build", "icon.png");
		cachedRendrIcon = fsSync.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;
	} catch {
		cachedRendrIcon = null;
	}
	return cachedRendrIcon;
}

let cachedRendrIcon: Electron.NativeImage | null | undefined;

function getUpdateNotificationTitle(payload: UpdateToastPayload) {
	switch (payload.phase) {
		case "available":
			return `Recordly ${payload.version} is available`;
		case "downloading":
			return `Downloading Recordly ${payload.version}`;
		case "ready":
			return `Recordly ${payload.version} is ready`;
		case "error":
			return `Recordly ${payload.version} needs attention`;
	}
}

function getUpdateNotificationBody(payload: UpdateToastPayload) {
	switch (payload.phase) {
		case "available":
			return "Click to install the update and restart Recordly.";
		case "downloading":
			return "Recordly is downloading the update and will restart when it is ready.";
		case "ready":
			return "Click to install the downloaded update and restart.";
		case "error":
			return payload.primaryAction === "install-and-restart"
				? "Click to try the install again."
				: "Click to retry checking for updates.";
	}
}

function clearActiveUpdateNotification() {
	if (activeUpdateNotification) {
		activeUpdateNotification.close();
		activeUpdateNotification = null;
	}
	activeUpdateNotificationKey = null;
}

function sendUpdateToastToWindows(channel: "update-toast-state", payload: unknown) {
	if (process.platform !== "darwin") {
		if (!payload) {
			clearActiveUpdateNotification();
			return true;
		}

		const updatePayload = payload as UpdateToastPayload;
		if (updatePayload.phase === "downloading") {
			return true;
		}

		if (!Notification.isSupported()) {
			return false;
		}

		const notificationKey = [
			updatePayload.phase,
			updatePayload.version,
			updatePayload.detail,
		].join(":");
		if (activeUpdateNotificationKey === notificationKey) {
			return true;
		}

		clearActiveUpdateNotification();
		const notification = new Notification({
			title: getUpdateNotificationTitle(updatePayload),
			body: getUpdateNotificationBody(updatePayload),
			icon: getAppImage(getPlatformAppIconFilename(128)),
			silent: false,
		});

		notification.on("click", () => {
			focusOrCreateMainWindow();
			switch (updatePayload.phase) {
				case "available":
					void downloadAvailableUpdate(sendUpdateToastToWindows, {
						installAfterDownload: true,
					});
					break;
				case "ready":
					installDownloadedUpdateNow(sendUpdateToastToWindows);
					break;
				case "error":
					if (updatePayload.primaryAction === "install-and-restart") {
						void downloadAvailableUpdate(sendUpdateToastToWindows, {
							installAfterDownload: true,
						});
					} else {
						void checkForAppUpdates(getUpdateDialogWindow, { manual: true });
					}
					break;
				default:
					break;
			}
		});

		notification.on("close", () => {
			if (activeUpdateNotification === notification) {
				activeUpdateNotification = null;
				activeUpdateNotificationKey = null;
			}
		});

		notification.show();
		// On Win10, showing a native notification can break setIgnoreMouseEvents
		// forwarding on the transparent HUD overlay.  Re-assert it after a short
		// delay so the renderer's hover detection keeps working.
		reassertHudOverlayMouseState();
		activeUpdateNotification = notification;
		activeUpdateNotificationKey = notificationKey;
		return true;
	}

	if (!payload) {
		const existingWindow = getUpdateToastWindow();
		if (!existingWindow) {
			return false;
		}

		existingWindow.webContents.send(channel, null);
		hideUpdateToastWindow();
		return true;
	}

	const toastWindow = showUpdateToastWindow();
	const sendPayload = () => {
		toastWindow.webContents.send(channel, payload);
		showUpdateToastWindow();
	};

	if (toastWindow.webContents.isLoadingMainFrame()) {
		toastWindow.webContents.once("did-finish-load", sendPayload);
	} else {
		sendPayload();
	}

	return true;
}

function getUpdateDialogWindow() {
	const focusedWindow = BrowserWindow.getFocusedWindow();
	if (focusedWindow && !focusedWindow.isDestroyed()) {
		return focusedWindow;
	}

	if (mainWindow && !mainWindow.isDestroyed()) {
		return mainWindow;
	}

	return getHudOverlayWindow();
}

ipcMain.handle("install-downloaded-update", () => {
	installDownloadedUpdateNow(sendUpdateToastToWindows);
	return { success: true };
});

ipcMain.handle("download-available-update", (_event, installAfterDownload?: boolean) => {
	return downloadAvailableUpdate(sendUpdateToastToWindows, {
		installAfterDownload: Boolean(installAfterDownload),
	});
});

ipcMain.handle("defer-downloaded-update", (_event, delayMs?: number) => {
	return deferUpdateReminder(getUpdateDialogWindow, sendUpdateToastToWindows, delayMs);
});

ipcMain.handle("dismiss-update-toast", () => {
	return dismissUpdateToast(getUpdateDialogWindow, sendUpdateToastToWindows);
});

ipcMain.handle("skip-update-version", () => {
	return skipAvailableUpdateVersion(sendUpdateToastToWindows);
});

ipcMain.handle("get-current-update-toast-payload", () => {
	return getCurrentUpdateToastPayload();
});

ipcMain.handle("get-update-status-summary", () => {
	return getUpdateStatusSummary();
});

ipcMain.handle("preview-update-toast", () => {
	return { success: previewUpdateToast(sendUpdateToastToWindows) };
});

ipcMain.handle("check-for-app-updates", async () => {
	await checkForAppUpdates(getUpdateDialogWindow, { manual: true });
	return { success: true, logPath: getUpdaterLogPath() };
});

function updateTrayMenu(recording: boolean = false) {
	if (!tray) return;
	const trayIcon = recording ? getRecordingTrayIcon() : getDefaultTrayIcon();
	const trayToolTip = recording ? `Recording: ${selectedSourceName}` : "Recordly";
	const menuTemplate = recording
		? [
				{
					label: "Show Controls",
					click: () => {
						if (!showHudOverlayFromTray()) {
							focusOrCreateMainWindow();
						}
					},
				},
				{
					label: "Stop Recording",
					click: () => {
						if (mainWindow && !mainWindow.isDestroyed()) {
							mainWindow.webContents.send("stop-recording-from-tray");
						}
					},
				},
			]
		: [
				{
					label: "Open",
					click: () => {
						if (!showHudOverlayFromTray()) {
							focusOrCreateMainWindow();
						}
					},
				},
				{
					label: "Quit",
					click: () => {
						app.quit();
					},
				},
			];
	const menu = Menu.buildFromTemplate(menuTemplate);
	trayContextMenu = menu;
	tray.setImage(trayIcon);
	tray.setToolTip(trayToolTip);
	if (process.platform !== "win32") {
		tray.setContextMenu(menu);
	}
}

function createEditorWindowWrapper() {
	const existingEditorWindow = getExistingEditorWindow();
	if (existingEditorWindow) {
		mainWindow = existingEditorWindow;
		editorWindowRef = existingEditorWindow;
		restoreWindowSafely(existingEditorWindow);
		return existingEditorWindow;
	}

	if (isCreatingEditorWindow) {
		const currentWindow = mainWindow;
		if (currentWindow && !currentWindow.isDestroyed()) {
			return currentWindow;
		}

		const currentEditorWindow = getExistingEditorWindow();
		if (currentEditorWindow) {
			mainWindow = currentEditorWindow;
			editorWindowRef = currentEditorWindow;
			return currentEditorWindow;
		}
	}

	isCreatingEditorWindow = true;
	const previousWindow = mainWindow;
	if (previousWindow && !previousWindow.isDestroyed()) {
		const closingEditorWindow = isEditorWindow(previousWindow);

		if (closingEditorWindow) {
			closeEditorWindowBypassingUnsavedPrompt(previousWindow);
		} else {
			// It's the HUD or another window. Hide it instead of closing so background
			// tasks (like webcam finalizing) can finish in its renderer process.
			previousWindow.hide();
		}

		if (!closingEditorWindow) {
			isForceClosing = false;
		}
		if (mainWindow === previousWindow) {
			mainWindow = null;
		}
	}
	const editorWindow = createEditorWindow();
	mainWindow = editorWindow;
	editorWindowRef = editorWindow;
	editorHasUnsavedChanges = false;

	editorWindow.on("closed", () => {
		if (mainWindow === editorWindow) {
			mainWindow = null;
		}
		if (editorWindowRef === editorWindow) {
			editorWindowRef = null;
		}
		isCreatingEditorWindow = false;
		isForceClosing = false;
		editorHasUnsavedChanges = false;
	});

	editorWindow.on("close", (event) => {
		if (isForceClosing || !editorHasUnsavedChanges) {
			return;
		}

		event.preventDefault();

		const choice = dialog.showMessageBoxSync(editorWindow, {
			type: "warning",
			buttons: ["Save & Close", "Discard & Close", "Cancel"],
			defaultId: 0,
			cancelId: 2,
			title: "Unsaved Changes",
			message: "You have unsaved changes.",
			detail: "Do you want to save your project before closing?",
		});

		if (choice === 0) {
			editorWindow.webContents.send("request-save-before-close");
			ipcMain.once("save-before-close-done", (_event, saved: boolean) => {
				if (saved) {
					closeEditorWindowBypassingUnsavedPrompt(editorWindow);
				}
			});
		} else if (choice === 1) {
			closeEditorWindowBypassingUnsavedPrompt(editorWindow);
		}
	});

	return editorWindow;
}

function createSourceSelectorWindowWrapper() {
	sourceSelectorWindow = createSourceSelectorWindow();
	sourceSelectorWindow.on("closed", () => {
		sourceSelectorWindow = null;
	});
	return sourceSelectorWindow;
}

// On macOS, applications and their menu bar stay active until the user quits
// explicitly with Cmd + Q.
app.on("before-quit", () => {
	void stopMcpServer();
	stopClaudeCli();
	killWindowsCaptureProcess();
	showCursor();
	cleanupNativeVideoExportSessions();
	void cleanupAllExportStreams();
});

// The name the OS shows: the dock label, the ⌘-Tab switcher, and the first
// menu-bar item. An unpackaged build inherits "Electron" from the binary's
// own Info.plist, so the running app is unrecognisable among a row of other
// Electron apps — setting it here makes development look like the product.
// Must run before `whenReady`, because the menu is built from it.
app.setName("Rendr");

app.on("window-all-closed", () => {
	if (IS_SMOKE_EXPORT || process.platform !== "darwin") {
		app.quit();
	}
});

app.on("activate", () => {
	// On OS X it's common to re-create a window in the app when the
	// dock icon is clicked and there are no other windows open.
	focusOrCreateMainWindow();
});

app.on("second-instance", () => {
	focusOrCreateMainWindow();
});

// Register all IPC handlers when app is ready
app.whenReady().then(async () => {
	syncDockIcon();
	// The dock only shows an app that has been asked to be visible. A build
	// that starts with its window hidden would otherwise run with no icon at
	// all, which is indistinguishable from not running.
	if (process.platform === "darwin" && app.dock) void app.dock.show();
	if (process.platform === "win32") {
		app.setAppUserModelId("dev.recordly.app");
	}

	session.defaultSession.setPermissionCheckHandler(
		(webContents, permission, requestingOrigin, details) => {
			return shouldGrantMediaPermission(
				{
					permission,
					isTrustedCaptureWindow: isTrustedCaptureWebContents(webContents),
					isMainFrame: details.isMainFrame,
					currentDocumentUrl: webContents?.getURL() ?? "",
					// Electron 39 may supply the last committed document URL, including its
					// query, in the requestingOrigin argument for media checks.
					requestingUrl: details.requestingUrl ?? requestingOrigin,
					securityOrigins:
						details.securityOrigin === undefined ? [] : [details.securityOrigin],
				},
				getTrustedCaptureDocumentBaseUrls(),
			);
		},
	);

	session.defaultSession.setPermissionRequestHandler(
		(webContents, permission, callback, details) => {
			const securityOrigin = "securityOrigin" in details ? details.securityOrigin : undefined;

			callback(
				shouldGrantMediaPermission(
					{
						permission,
						isTrustedCaptureWindow: isTrustedCaptureWebContents(webContents),
						isMainFrame: details.isMainFrame,
						currentDocumentUrl: webContents.getURL(),
						requestingUrl: details.requestingUrl,
						securityOrigins: securityOrigin === undefined ? [] : [securityOrigin],
					},
					getTrustedCaptureDocumentBaseUrls(),
				),
			);
		},
	);

	// Recordly does not use WebHID, Web Serial, or WebUSB. Do not grant devices by default.
	session.defaultSession.setDevicePermissionHandler(() => false);

	/**
	 * Exports and project files leave the renderer as a download.
	 *
	 * Without a save path Electron opens a Save As dialog, which is fine for a
	 * human but leaves an agent-started export reporting "finished" with no file
	 * anywhere — the dialog is simply waiting. Choosing the path here makes
	 * export_project's promise true: a uniquely-named file in ~/Downloads.
	 */
	/**
	 * The floating record bar lives in its own content-protected window, so the
	 * editor asks for it and talks to it through here.
	 */
	ipcMain.on("rendr-bar:visible", (_event, visible: boolean) => {
		if (visible) createRendrBarWindow();
		else closeRendrBarWindow();
	});

	ipcMain.on("rendr-bar:push-state", (_event, state: unknown) => {
		const bar = getRendrBarWindow();
		if (bar && !bar.isDestroyed()) bar.webContents.send("rendr-bar:state", state);
	});

	ipcMain.on("rendr-bar:command", (_event, command: string) => {
		// Commands go to the editor, which owns the recorder.
		const editor = editorWindowRef ?? mainWindow;
		if (editor && !editor.isDestroyed()) {
			editor.webContents.send("rendr-bar:command-forwarded", command);
		}
	});

	session.defaultSession.on("will-download", (_event, item) => {
		try {
			const directory = app.getPath("downloads");
			const original = item.getFilename() || "rendr-export";
			const extension = path.extname(original);
			const base = extension ? original.slice(0, -extension.length) : original;

			let target = path.join(directory, original);
			// Never overwrite: a second export of the same project is a second
			// file, not a silent replacement of the first.
			for (let attempt = 1; fsSync.existsSync(target); attempt++) {
				target = path.join(directory, `${base} ${attempt}${extension}`);
			}
			item.setSavePath(target);

			item.once("done", (__, state) => {
				for (const window of BrowserWindow.getAllWindows()) {
					if (window.isDestroyed()) continue;
					window.webContents.send("rendr-download:done", {
						filename: path.basename(target),
						path: target,
						state,
					});
				}
			});
		} catch (error) {
			console.error("will-download: could not choose a save path", error);
		}
	});

	if (process.platform === "darwin") {
		const cameraStatus = systemPreferences.getMediaAccessStatus("camera");
		if (cameraStatus !== "granted") {
			await systemPreferences.askForMediaAccess("camera");
		}

		const micStatus = systemPreferences.getMediaAccessStatus("microphone");
		if (micStatus !== "granted") {
			await systemPreferences.askForMediaAccess("microphone");
		}
	} else if (process.platform === "win32") {
		const cameraStatus = systemPreferences.getMediaAccessStatus("camera");
		const micStatus = systemPreferences.getMediaAccessStatus("microphone");
		if (cameraStatus !== "granted") {
			console.warn(
				`[permissions] Camera access is "${cameraStatus}" — webcam may not work. Check Windows Settings > Privacy > Camera.`,
			);
		}
		if (micStatus !== "granted") {
			console.warn(
				`[permissions] Microphone access is "${micStatus}" — mic recording may not work. Check Windows Settings > Privacy > Microphone.`,
			);
		}
	}

	ipcMain.on("hud-overlay-close", () => {
		const hud = getHudOverlayWindow();
		if (hud) {
			console.log("[main] Closing HUD window via hud-overlay-close");
			hud.close();
		}

		// If this was the last window (or we are in a state where we should quit), do it.
		// We use a small delay to allow window.close() to propagate.
		setTimeout(() => {
			const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
			if (windows.length === 0) {
				console.log("[main] No windows left, quitting app");
				app.quit();
			}
		}, 100);
	});
	syncDockIcon();
	createTray();
	updateTrayMenu();
	setupApplicationMenu();
	// Ensure recordings directory exists
	await ensureRecordingsDir();

	if (!VITE_DEV_SERVER_URL) {
		try {
			await ensurePackagedRendererServer(RENDERER_DIST);
		} catch (error) {
			console.warn("[renderer-server] Failed to start packaged renderer server:", error);
		}
	}

	try {
		await ensureMediaServer();
	} catch (error) {
		console.warn("[media-server] Failed to start media server:", error);
	}

	// Rendr is an editor as much as a recorder, so its editor window opens at
	// launch. Recordly opened only the HUD because it was recorder-first.
	if (!IS_SMOKE_EXPORT) {
		createEditorWindowWrapper();
	}

	// Claude Code answers in the agent panel, pointed back at our own MCP server.
	registerClaudeCli(() => editorWindowRef ?? mainWindow);
	registerTranscribe();

	// Agent surface: local MCP server. Failure to bind never blocks the app.
	void startMcpServer({
		// Editing goes to the editor; recording goes to the HUD that owns capture.
		editor: () => editorWindowRef,
		recorder: () => getHudOverlayWindow() ?? mainWindow,
	});

	registerIpcHandlers(
		createEditorWindowWrapper,
		createSourceSelectorWindowWrapper,
		() => mainWindow,
		() => sourceSelectorWindow,
		(recording: boolean, sourceName: string) => {
			selectedSourceName = sourceName;
			setHudOverlayRecordingActive(recording);
			if (!tray) createTray();
			updateTrayMenu(recording);
			if (recording) {
				reassertHudOverlayMouseState();
			}
			if (!recording) {
				restoreWindowSafely(mainWindow);
			}
		},
	);

	registerExtensionIpcHandlers();

	if (IS_SMOKE_EXPORT || process.env.RECORDLY_DEV_OPEN_RECORDING_INPUT) {
		await logSmokeExportGpuDiagnostics();
		if (IS_SMOKE_EXPORT) {
			const smokeSource =
				process.env.RECORDLY_SMOKE_EXPORT_PROJECT ??
				process.env.RECORDLY_SMOKE_EXPORT_INPUT ??
				"<missing input>";
			console.log(`[smoke-export] Starting editor smoke export for ${smokeSource}`);
		} else {
			console.log(
				`[dev-open-recording] Starting editor for ${process.env.RECORDLY_DEV_OPEN_RECORDING_INPUT}`,
			);
		}
		createEditorWindowWrapper();
		return;
	}

	createWindow();
	setupAutoUpdates(getUpdateDialogWindow, sendUpdateToastToWindows);

	// Register the display media handler so that renderer's getDisplayMedia()
	// calls land on the pre-selected source without showing a system picker.
	//
	// IMPORTANT: The callback must receive a plain { id, name } Video object.
	// Passing the full DesktopCapturerSource (with thumbnail, appIcon, etc.)
	// via an unsafe cast breaks Electron's internal cursor-constraint
	// propagation and causes cursor: 'never' from the renderer to be silently
	// ignored by the native capture pipeline.
	session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
		try {
			const frame = request.frame;
			const isLiveFrame = Boolean(frame && !frame.isDestroyed());
			const requestingWebContents =
				isLiveFrame && frame ? electronWebContents.fromFrame(frame) : undefined;
			// The editor records too, not only the HUD — see
			// isTrustedCaptureWebContents.
			const isTrustedMainFrame = Boolean(
				isLiveFrame &&
					requestingWebContents &&
					isTrustedCaptureWebContents(requestingWebContents) &&
					frame === requestingWebContents.mainFrame,
			);

			if (
				!shouldGrantDisplayCapture(
					{
						isTrustedCaptureWindow: isTrustedMainFrame,
						isMainFrame: Boolean(isLiveFrame && frame?.parent === null),
						currentDocumentUrl: isLiveFrame ? (frame?.url ?? "") : "",
						securityOrigin: request.securityOrigin,
						videoRequested: request.videoRequested,
					},
					getTrustedCaptureDocumentBaseUrls(),
				)
			) {
				callback({});
				return;
			}

			const sourceId = getSelectedSourceId();
			// On Linux/Wayland, calling desktopCapturer.getSources() itself
			// invokes the xdg-desktop-portal picker. If we then return one of
			// those sources, Chromium triggers a SECOND portal because the
			// pre-enumerated source IDs are stale on Wayland. To collapse this
			// into a single portal invocation, when the Linux portal sentinel
			// is set we skip getSources entirely and hand back a synthetic
			// source id; Chromium then opens the portal once to actually
			// resolve the capture.
			// Default to the sentinel on Linux when no source has been
			// pre-selected (e.g. fresh session where the renderer skipped the
			// source picker entirely). This avoids calling getSources() which
			// would itself trigger an extra portal dialog.
			const isLinuxPortalSentinel =
				process.platform === "linux" && (sourceId === "screen:linux-portal" || !sourceId);
			if (isLinuxPortalSentinel) {
				callback({ video: { id: "screen:0:0", name: "Entire screen" } });
				return;
			}
			const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
			const source = sourceId
				? (sources.find((s) => s.id === sourceId) ?? sources[0])
				: sources[0];
			if (source) {
				callback({
					video: { id: source.id, name: source.name },
				});
			} else {
				callback({});
			}
		} catch (error) {
			console.error("setDisplayMediaRequestHandler error:", error);
			callback({});
		}
	});

	const currentToastPayload = getCurrentUpdateToastPayload();
	if (currentToastPayload) {
		sendUpdateToastToWindows("update-toast-state", currentToastPayload);
	}
});
