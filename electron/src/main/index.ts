import { app, BrowserWindow, ipcMain, powerSaveBlocker, session, shell, WebContentsView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeEvent, BridgeRequest } from '../common/types.js';
import { AuthManager } from './auth.js';
import { BridgeHandler } from './bridge.js';
import { DiscordRpcManager } from './discord.js';
import { setupHeaderInterception } from './headers.js';
import { MediaControlsManager } from './media.js';
import { TrayManager } from './tray.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_WEB_URL = 'https://bitchord-8bw.pages.dev/home';

const TITLEBAR_HEIGHT = 32;

let mainWindow: BrowserWindow | null = null;
// The BitChord page lives in its own view under the titlebar view, so it is never modified.
let pageView: WebContentsView | null = null;
let titlebarView: WebContentsView | null = null;
let authManager: AuthManager | null = null;
let discordManager: DiscordRpcManager | null = null;
let bridgeHandler: BridgeHandler | null = null;
let mediaManager: MediaControlsManager | null = null;
let trayManager: TrayManager | null = null;
let isQuitting = false;
let powerBlockerId: number | null = null;

// Set app name and user model ID for OS media integration (SMTC on Windows, MPRIS on Linux)
app.setName('BitChord');
app.setAppUserModelId('com.music.bitchord');

// Command-line flags to guarantee Chromium MediaSession and hardware media key services
// stay fully active and unthrottled in background or hidden window states
app.commandLine.appendSwitch('enable-features', 'MediaSessionService,HardwareMediaKeyHandling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// Ensure single instance and proper taskbar icon registration on Windows
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function broadcastBridgeEvent(event: BridgeEvent): void {
  if (pageView && !pageView.webContents.isDestroyed()) {
    pageView.webContents.send('bridge:event', event);
  }
}

function sendToTitlebar(channel: string, payload: unknown): void {
  if (titlebarView && !titlebarView.webContents.isDestroyed()) {
    titlebarView.webContents.send(channel, payload);
  }
}

/** Titlebar on top, page below it; full-screen (e.g. fullscreen video) hands the page the whole window. */
function layoutViews(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !pageView || !titlebarView) return;
  const { width, height } = mainWindow.getContentBounds();
  const hideBar = mainWindow.isFullScreen();
  const barHeight = hideBar ? 0 : TITLEBAR_HEIGHT;
  titlebarView.setVisible(!hideBar);
  titlebarView.setBounds({ x: 0, y: 0, width, height: barHeight });
  pageView.setBounds({ x: 0, y: barHeight, width, height: Math.max(0, height - barHeight) });
}

async function createWindow(): Promise<BrowserWindow> {
  const currentSession = session.defaultSession;

  // Setup CORS and header interception natively
  setupHeaderInterception(currentSession);

  // Initialize managers
  authManager = new AuthManager(currentSession);
  discordManager = new DiscordRpcManager();
  bridgeHandler = new BridgeHandler(authManager, discordManager, () => mainWindow);
  mediaManager = new MediaControlsManager(() => mainWindow, () => pageView?.webContents ?? null);
  trayManager?.destroy();
  trayManager = new TrayManager({
    iconPath: path.resolve(__dirname, '../../assets/icon.png'),
    getMainWindow: () => mainWindow,
    sendAction: (action) => mediaManager?.sendAction(action),
  });
  mediaManager.onPlaybackChange = (playing) => trayManager?.setPlaying(playing);

  // Subscribe to state updates to broadcast to web page
  authManager.subscribeYt((data) => broadcastBridgeEvent({ event: 'yt.authState', data }));
  authManager.subscribeSpotify((data) => broadcastBridgeEvent({ event: 'spotify.authState', data }));
  discordManager.subscribeState((data) => broadcastBridgeEvent({ event: 'discord.state', data }));

  const preloadPath = path.join(__dirname, '../preload/index.cjs');
  const titlebarPreloadPath = path.join(__dirname, '../preload/titlebar.cjs');

  const iconPath = process.platform === 'win32'
    ? path.resolve(__dirname, '../../assets/icon.ico')
    : path.resolve(__dirname, '../../assets/icon.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'BitChord',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#1f1f1f',
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 10 } } : {}),
  });

  mainWindow.setMenuBarVisibility(false);

  pageView = new WebContentsView({
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  titlebarView = new WebContentsView({
    webPreferences: {
      preload: titlebarPreloadPath,
      contextIsolation: false,
      sandbox: false,
    },
  });
  mainWindow.contentView.addChildView(pageView);
  mainWindow.contentView.addChildView(titlebarView);
  layoutViews();
  mainWindow.on('resize', layoutViews);
  mainWindow.on('enter-full-screen', layoutViews);
  mainWindow.on('leave-full-screen', layoutViews);
  void titlebarView.webContents.loadURL('data:text/html;charset=utf-8,<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');

  // Handle external links and auth popups
  pageView.webContents.setWindowOpenHandler(({ url }) => {
    if (
      url.includes('spotify.com') ||
      url.includes('accounts.google.com') ||
      url.includes('google.com') ||
      url.includes('music.youtube.com')
    ) {
      if (mainWindow) {
        if (url.includes('spotify.com')) {
          authManager?.openSpotifyLogin(mainWindow, url);
        } else {
          authManager?.openYouTubeLogin(mainWindow, url);
        }
      }
      return { action: 'deny' };
    }
    // Open external docs, github, etc. in user's default browser
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mediaManager?.updateThumbarButtons();
  });

  mainWindow.on('maximize', () => sendToTitlebar('window:state', { isMaximized: true }));
  mainWindow.on('unmaximize', () => sendToTitlebar('window:state', { isMaximized: false }));
  mainWindow.on('focus', () => sendToTitlebar('window:focus', { isFocused: true }));
  mainWindow.on('blur', () => sendToTitlebar('window:focus', { isFocused: false }));

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    pageView = null;
    titlebarView = null;
  });

  // Determine URL to load: check for cached local build first
  const cachedIndexPath = path.resolve(__dirname, '../../cached-web/index.html');
  const targetUrl = process.env.BITCHORD_URL || DEFAULT_WEB_URL;

  if (process.env.BITCHORD_OFFLINE && fs.existsSync(cachedIndexPath)) {
    console.log('Loading local cached BitChord build:', cachedIndexPath);
    await pageView.webContents.loadFile(cachedIndexPath);
  } else {
    console.log('Loading BitChord web URL:', targetUrl);
    await pageView.webContents.loadURL(targetUrl);
  }

  return mainWindow;
}

// Setup IPC handlers
ipcMain.handle('bridge:call', async (_event, request: BridgeRequest) => {
  if (!bridgeHandler) throw new Error('BridgeHandler not initialized');
  return bridgeHandler.handle(request);
});

ipcMain.on('playback:state', (_event, { playing }: { playing: boolean }) => {
  mediaManager?.setPlaybackState(playing);
});

ipcMain.on('playback:title', (_event, { title }: { title: string }) => {
  trayManager?.setTitle(title);
});

ipcMain.on('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on('window:close', () => {
  mainWindow?.close();
});

ipcMain.handle('window:isMaximized', () => {
  return mainWindow?.isMaximized() ?? false;
});

app.whenReady().then(async () => {
  // Prevent OS from sleeping or suspending the application while audio/media plays
  try {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } catch (err) {
    console.warn('Failed to start powerSaveBlocker:', err);
  }

  await createWindow();

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
  mediaManager?.unregisterAll();
  trayManager?.destroy();
  void discordManager?.disconnect();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
