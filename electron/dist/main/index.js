// src/main/index.ts
import { app as app2, BrowserWindow as BrowserWindow4, ipcMain, session, shell, WebContentsView } from "electron";
import fs3 from "fs";
import path from "path";
import { fileURLToPath } from "url";

// src/main/auth.ts
import { BrowserWindow } from "electron";
import crypto from "crypto";
var SIGNING_COOKIES = ["SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID"];
var SESSION_COOKIES = /* @__PURE__ */ new Set([...SIGNING_COOKIES, "SID", "__Secure-1PSID", "__Secure-3PSID"]);
var MUSIC_ORIGIN = "https://music.youtube.com";
var WEB_REMIX_VERSION = "1.20251006.03.00";
var MAX_LOGINS = 10;
function renderers(root, key, out = []) {
  if (Array.isArray(root)) {
    for (const item of root) renderers(item, key, out);
  } else if (root && typeof root === "object") {
    for (const [k, v] of Object.entries(root)) {
      if (k === key && v && typeof v === "object" && !Array.isArray(v)) out.push(v);
      else renderers(v, key, out);
    }
  }
  return out;
}
function findString(root, key) {
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findString(item, key);
      if (found) return found;
    }
  } else if (root && typeof root === "object") {
    for (const [k, v] of Object.entries(root)) {
      if (k === key && typeof v === "string" && v) return v;
      const found = findString(v, key);
      if (found) return found;
    }
  }
  return null;
}
function text(node) {
  const n = node;
  if (n?.runs) return n.runs.map((r) => r.text ?? "").join("");
  return n?.simpleText ?? "";
}
function photo(item) {
  const thumbnails = item.accountPhoto?.thumbnails;
  return thumbnails?.at(-1)?.url ?? null;
}
var AuthManager = class {
  session;
  ytConnected = true;
  spotifyConnected = true;
  activePopup = null;
  ytListeners = /* @__PURE__ */ new Set();
  spotifyListeners = /* @__PURE__ */ new Set();
  cachedYtAccounts = null;
  cachedActiveChannel = null;
  selectedChannelId = null;
  isClearingCookies = false;
  cookieDebounceTimer = null;
  constructor(session2) {
    this.session = session2;
    this.setupCookieListener();
  }
  subscribeYt(listener) {
    this.ytListeners.add(listener);
    void this.getYtAuthState().then(listener);
    return () => this.ytListeners.delete(listener);
  }
  subscribeSpotify(listener) {
    this.spotifyListeners.add(listener);
    void this.getSpotifyAuthState().then(listener);
    return () => this.spotifyListeners.delete(listener);
  }
  broadcastYt(state) {
    for (const listener of this.ytListeners) {
      listener(state);
    }
  }
  broadcastSpotify(state) {
    for (const listener of this.spotifyListeners) {
      listener(state);
    }
  }
  setupCookieListener() {
    this.session.cookies.on("changed", (_event, cookie) => {
      if (this.isClearingCookies) return;
      const domain = cookie.domain || "";
      if (domain.includes("youtube.com") || domain.includes("google.com")) {
        if (SESSION_COOKIES.has(cookie.name)) {
          if (this.cookieDebounceTimer) clearTimeout(this.cookieDebounceTimer);
          this.cookieDebounceTimer = setTimeout(() => {
            this.cachedYtAccounts = null;
            this.cachedActiveChannel = null;
            void this.getYtAuthState(true).then((state) => this.broadcastYt(state));
          }, 300);
        }
      } else if (domain.includes("spotify.com")) {
        if (cookie.name === "sp_dc") {
          void this.getSpotifyAuthState().then((state) => this.broadcastSpotify(state));
        }
      }
    });
  }
  // ---- YouTube Auth ----
  async getSigningSecret() {
    for (const name of SIGNING_COOKIES) {
      const cookies = await this.session.cookies.get({ url: MUSIC_ORIGIN, name });
      if (cookies.length > 0 && cookies[0]?.value) {
        return cookies[0].value;
      }
    }
    return null;
  }
  async getSapisidHash(origin = MUSIC_ORIGIN) {
    const secret = await this.getSigningSecret();
    if (!secret) return null;
    const timestamp = Math.floor(Date.now() / 1e3);
    const hash = crypto.createHash("sha1").update(`${timestamp} ${secret} ${origin}`).digest("hex");
    return `SAPISIDHASH ${timestamp}_${hash}`;
  }
  async getCookieHeader(url) {
    const cookies = await this.session.cookies.get({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
  getActiveIdentity() {
    if (!this.cachedActiveChannel) return null;
    const parts = this.cachedActiveChannel.id.split(":");
    const authUser = this.cachedActiveChannel.authUser || parts[0] || "0";
    const pageId = parts[1] && parts[1] !== "own" ? parts[1] : null;
    return { authUser, pageId };
  }
  async webSessionIndex(cookieHeader, sapisidHash) {
    try {
      const response = await fetch(`${MUSIC_ORIGIN}/`, {
        headers: {
          Accept: "text/html",
          Authorization: sapisidHash,
          Cookie: cookieHeader,
          Origin: MUSIC_ORIGIN,
          Referer: `${MUSIC_ORIGIN}/`,
          "X-Origin": MUSIC_ORIGIN
        }
      });
      const html = await response.text();
      return /"SESSION_INDEX":"?(\d+)/.exec(html)?.[1] ?? null;
    } catch {
      return null;
    }
  }
  async readLogin(authUser, cookieHeader, sapisidHash) {
    try {
      const response = await fetch(`${MUSIC_ORIGIN}/youtubei/v1/account/account_menu?prettyPrint=false`, {
        method: "POST",
        headers: {
          Authorization: sapisidHash,
          "X-Goog-AuthUser": authUser,
          "X-Origin": MUSIC_ORIGIN,
          Origin: MUSIC_ORIGIN,
          Referer: `${MUSIC_ORIGIN}/`,
          Cookie: cookieHeader,
          "Content-Type": "application/json",
          "X-Youtube-Client-Name": "67",
          "X-Youtube-Client-Version": WEB_REMIX_VERSION
        },
        body: JSON.stringify({
          context: {
            client: { clientName: "WEB_REMIX", clientVersion: WEB_REMIX_VERSION, hl: "en", gl: "US" },
            user: {}
          }
        })
      });
      if (!response.ok) return { account: null, why: `HTTP ${response.status}` };
      const menu = await response.json();
      const header = renderers(menu, "activeAccountHeaderRenderer")[0];
      if (!header) return { account: null, why: "No activeAccountHeaderRenderer" };
      const name = text(header.accountName) || `Google Account ${authUser}`;
      const email = text(header.email) || null;
      const handle = text(header.channelHandle) || null;
      const avatarUrl = photo(header);
      let channels = [];
      try {
        const listRes = await fetch(`${MUSIC_ORIGIN}/youtubei/v1/account/accounts_list?prettyPrint=false`, {
          method: "POST",
          headers: {
            Authorization: sapisidHash,
            "X-Goog-AuthUser": authUser,
            "X-Origin": MUSIC_ORIGIN,
            Origin: MUSIC_ORIGIN,
            Referer: `${MUSIC_ORIGIN}/`,
            Cookie: cookieHeader,
            "Content-Type": "application/json",
            "X-Youtube-Client-Name": "67",
            "X-Youtube-Client-Version": WEB_REMIX_VERSION
          },
          body: JSON.stringify({
            context: {
              client: { clientName: "WEB_REMIX", clientVersion: WEB_REMIX_VERSION, hl: "en", gl: "US" },
              user: {}
            }
          })
        });
        if (listRes.ok) {
          const listJson = await listRes.json();
          for (const item of renderers(listJson, "accountItem")) {
            const chName = text(item.accountName);
            if (!chName) continue;
            const pageId = findString(item, "pageId");
            const chHandle = text(item.channelHandle) || text(item.accountByline) || null;
            const id = `${authUser}:${pageId ?? "own"}`;
            if (channels.some((c) => c.id === id)) continue;
            channels.push({
              id,
              name: chName,
              handle: chHandle,
              avatarUrl: photo(item),
              brand: pageId !== null,
              authUser,
              pageId,
              selectedOnWeb: item.isSelected === true
            });
          }
        }
      } catch {
      }
      if (!channels.length) {
        channels = [
          {
            id: `${authUser}:own`,
            name,
            handle: handle ?? email,
            avatarUrl,
            brand: false,
            authUser,
            pageId: null,
            selectedOnWeb: true
          }
        ];
      }
      return {
        account: {
          authUser,
          name,
          email,
          avatarUrl,
          channels
        },
        why: null
      };
    } catch (err) {
      return { account: null, why: err instanceof Error ? err.message : String(err) };
    }
  }
  async fetchYtAccounts() {
    const sapisidHash = await this.getSapisidHash();
    if (!sapisidHash) return { accounts: [], active: null };
    const cookieHeader = await this.getCookieHeader(MUSIC_ORIGIN);
    const [results, webIndex] = await Promise.all([
      Promise.all(Array.from({ length: MAX_LOGINS }, (_, i) => this.readLogin(String(i), cookieHeader, sapisidHash))),
      this.webSessionIndex(cookieHeader, sapisidHash)
    ]);
    const accounts = [];
    const seen = /* @__PURE__ */ new Set();
    for (const { account } of results) {
      if (!account) continue;
      const channelSuffixes = account.channels.map((c) => c.id.split(":")[1]).join(",");
      const key = account.email ?? `${account.name}|${channelSuffixes}`;
      if (seen.has(key)) continue;
      seen.add(key);
      accounts.push(account);
    }
    if (accounts.length === 0) {
      const fallback = {
        id: "0:own",
        name: "Google Account",
        handle: null,
        avatarUrl: null,
        brand: false
      };
      return {
        accounts: [
          {
            authUser: "0",
            name: "Google Account",
            email: null,
            avatarUrl: null,
            channels: [fallback]
          }
        ],
        active: { ...fallback, authUser: "0" }
      };
    }
    const allChannels = accounts.flatMap((a) => a.channels);
    const webAccount = accounts.find((a) => a.authUser === webIndex) ?? accounts[0];
    const webChannels = webAccount?.channels ?? [];
    let activeChannel = null;
    if (this.selectedChannelId) {
      const found = allChannels.find((c) => c.id === this.selectedChannelId);
      if (found) {
        activeChannel = { ...found, authUser: found.authUser };
      }
    }
    if (!activeChannel) {
      const webChoice = webChannels.find((c) => c.selectedOnWeb) ?? webChannels[0];
      if (webChoice) {
        activeChannel = { ...webChoice, authUser: webChoice.authUser };
      } else if (allChannels[0]) {
        activeChannel = { ...allChannels[0], authUser: allChannels[0].authUser };
      }
    }
    return { accounts, active: activeChannel };
  }
  async getYtAuthState(refresh = false) {
    const secret = await this.getSigningSecret();
    const browserSignedIn = !!secret;
    if (!browserSignedIn || !this.ytConnected) {
      return {
        browserSignedIn,
        connected: this.ytConnected,
        signedIn: false,
        accounts: [],
        active: null,
        problem: null
      };
    }
    if (refresh || !this.cachedYtAccounts || !this.cachedActiveChannel) {
      const { accounts, active } = await this.fetchYtAccounts();
      this.cachedYtAccounts = accounts;
      this.cachedActiveChannel = active;
    }
    return {
      browserSignedIn: true,
      connected: true,
      signedIn: this.cachedActiveChannel !== null,
      accounts: this.cachedYtAccounts || [],
      active: this.cachedActiveChannel,
      problem: null
    };
  }
  async selectChannel(channelId) {
    this.selectedChannelId = channelId;
    if (this.cachedYtAccounts) {
      for (const acc of this.cachedYtAccounts) {
        const found = acc.channels.find((c) => c.id === channelId);
        if (found) {
          this.cachedActiveChannel = { ...found, authUser: acc.authUser };
          break;
        }
      }
    }
    const state = await this.getYtAuthState(false);
    this.broadcastYt(state);
    return state;
  }
  async clearGoogleCookies() {
    this.isClearingCookies = true;
    try {
      const cookies = await this.session.cookies.get({});
      for (const cookie of cookies) {
        const domain = (cookie.domain || "").replace(/^\./, "");
        if (domain.includes("youtube.com") || domain.includes("google.com")) {
          const scheme = cookie.secure ? "https" : "http";
          const urls = [
            `${scheme}://${domain}${cookie.path || "/"}`,
            `${scheme}://www.${domain}${cookie.path || "/"}`,
            `${scheme}://music.${domain}${cookie.path || "/"}`,
            `${scheme}://accounts.${domain}${cookie.path || "/"}`
          ];
          for (const url of urls) {
            try {
              await this.session.cookies.remove(url, cookie.name);
            } catch {
            }
          }
        }
      }
      if (await this.getSigningSecret()) {
        await this.session.clearStorageData({ storages: ["cookies"] });
      }
    } finally {
      this.isClearingCookies = false;
    }
  }
  async setYtConnected(connected) {
    if (!connected) {
      this.ytConnected = false;
      await this.clearGoogleCookies();
      this.cachedYtAccounts = null;
      this.cachedActiveChannel = null;
      this.selectedChannelId = null;
      const state2 = {
        browserSignedIn: false,
        connected: false,
        signedIn: false,
        accounts: [],
        active: null,
        problem: null
      };
      this.broadcastYt(state2);
      return state2;
    }
    this.ytConnected = true;
    const state = await this.getYtAuthState(true);
    this.broadcastYt(state);
    return state;
  }
  // ---- Spotify Auth ----
  async getSpotifyDc() {
    const cookies = await this.session.cookies.get({ domain: ".spotify.com", name: "sp_dc" });
    return cookies[0]?.value ?? null;
  }
  async getSpotifyAuthState() {
    const spDc = await this.getSpotifyDc();
    const browserSignedIn = !!spDc;
    return {
      browserSignedIn,
      connected: this.spotifyConnected,
      signedIn: browserSignedIn && this.spotifyConnected,
      user: null,
      problem: null
    };
  }
  async setSpotifyConnected(connected) {
    if (!connected) {
      const cookies = await this.session.cookies.get({ domain: ".spotify.com" });
      for (const cookie of cookies) {
        const url = `https://open.spotify.com${cookie.path || "/"}`;
        try {
          await this.session.cookies.remove(url, cookie.name);
        } catch {
        }
      }
      this.spotifyConnected = false;
      const state2 = {
        browserSignedIn: false,
        connected: false,
        signedIn: false,
        user: null,
        problem: null
      };
      this.broadcastSpotify(state2);
      return state2;
    }
    this.spotifyConnected = true;
    const state = await this.getSpotifyAuthState();
    this.broadcastSpotify(state);
    return state;
  }
  openSpotifyLogin(parentWindow, targetUrl) {
    if (this.activePopup && !this.activePopup.isDestroyed()) {
      this.activePopup.focus();
      return;
    }
    const chromeUa = parentWindow.webContents.getUserAgent().replace(/Electron\/\S+\s?/, "");
    this.activePopup = new BrowserWindow({
      width: 500,
      height: 700,
      parent: parentWindow,
      modal: true,
      title: "Sign in to Spotify",
      autoHideMenuBar: true,
      webPreferences: {
        session: this.session,
        sandbox: true
      }
    });
    this.activePopup.webContents.setUserAgent(chromeUa);
    const checkSuccess = (navUrl) => {
      if (navUrl.startsWith("https://open.spotify.com")) {
        setTimeout(() => {
          if (this.activePopup && !this.activePopup.isDestroyed()) {
            this.activePopup.close();
            this.activePopup = null;
          }
        }, 1e3);
      }
    };
    this.activePopup.webContents.on("did-navigate", (_e, url) => checkSuccess(url));
    this.activePopup.webContents.on("did-redirect-navigation", (_e, url) => checkSuccess(url));
    this.activePopup.on("closed", () => {
      this.activePopup = null;
      void this.getSpotifyAuthState().then((state) => this.broadcastSpotify(state));
    });
    void this.activePopup.loadURL(
      targetUrl || "https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F"
    );
  }
  openYouTubeLogin(parentWindow, targetUrl) {
    if (this.activePopup && !this.activePopup.isDestroyed()) {
      this.activePopup.focus();
      return;
    }
    const chromeUa = parentWindow.webContents.getUserAgent().replace(/Electron\/\S+\s?/, "");
    const popupOpenedAt = Date.now();
    this.activePopup = new BrowserWindow({
      width: 500,
      height: 700,
      parent: parentWindow,
      modal: true,
      title: "Sign in to YouTube Music",
      autoHideMenuBar: true,
      webPreferences: {
        session: this.session,
        sandbox: true
      }
    });
    this.activePopup.webContents.setUserAgent(chromeUa);
    const checkSuccess = (navUrl) => {
      const isTarget = navUrl.startsWith("https://music.youtube.com") || navUrl.startsWith("https://www.youtube.com");
      const elapsed = Date.now() - popupOpenedAt;
      if (isTarget && elapsed > 1500) {
        setTimeout(async () => {
          if (this.activePopup && !this.activePopup.isDestroyed()) {
            this.activePopup.close();
            this.activePopup = null;
          }
          this.cachedYtAccounts = null;
          this.cachedActiveChannel = null;
          const state = await this.getYtAuthState(true);
          this.broadcastYt(state);
        }, 1e3);
      }
    };
    this.activePopup.webContents.on("did-navigate", (_e, url) => checkSuccess(url));
    this.activePopup.webContents.on("did-redirect-navigation", (_e, url) => checkSuccess(url));
    this.activePopup.on("closed", () => {
      this.activePopup = null;
      setTimeout(async () => {
        this.cachedYtAccounts = null;
        this.cachedActiveChannel = null;
        const state = await this.getYtAuthState(true);
        this.broadcastYt(state);
      }, 500);
    });
    void this.activePopup.loadURL(
      targetUrl || "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F"
    );
  }
};

// src/main/bridge.ts
import fs from "fs";

// src/common/types.ts
var BRIDGE_PROTOCOL = 1;
var BRIDGE_CHANNEL = "bitchord-bridge";
function okResponse(id, result) {
  return { channel: BRIDGE_CHANNEL, protocol: BRIDGE_PROTOCOL, direction: "to-page", id, ok: true, result };
}
function errorResponse(id, code, message) {
  return { channel: BRIDGE_CHANNEL, protocol: BRIDGE_PROTOCOL, direction: "to-page", id, ok: false, error: { code, message } };
}

// src/main/bridge.ts
var CAPABILITIES = ["yt", "yt.auth", "yt.stats", "lyrics", "spotify", "discord"];
var BridgeHandler = class {
  auth;
  discord;
  getMainWindow;
  constructor(auth, discord, getMainWindow) {
    this.auth = auth;
    this.discord = discord;
    this.getMainWindow = getMainWindow;
  }
  async handle(request) {
    if (request.protocol !== BRIDGE_PROTOCOL) {
      return errorResponse(
        request.id,
        "protocol",
        `Protocol mismatch: expected ${BRIDGE_PROTOCOL}, received ${request.protocol}`
      );
    }
    try {
      switch (request.method) {
        case "ping":
          return okResponse(request.id, {
            version: "1.0.0",
            protocol: BRIDGE_PROTOCOL,
            browser: "chromium",
            capabilities: CAPABILITIES
          });
        // ---- YouTube ----
        case "yt.fetch": {
          const res = await this.proxyFetch(request.params);
          return okResponse(request.id, res);
        }
        case "yt.authState":
          return okResponse(request.id, await this.auth.getYtAuthState(request.params?.refresh === true));
        case "yt.selectChannel":
          return okResponse(request.id, await this.auth.selectChannel(request.params?.channelId));
        case "yt.setConnected":
          return okResponse(request.id, await this.auth.setYtConnected(request.params?.connected === true));
        // ---- Lyrics ----
        case "lyrics.permissions":
          return okResponse(request.id, { granted: request.params?.origins ?? [] });
        case "lyrics.requestPermissions":
          return okResponse(request.id, {});
        case "lyrics.fetch": {
          const res = await this.proxyFetch(request.params);
          return okResponse(request.id, res);
        }
        // ---- Spotify ----
        case "spotify.authState":
          return okResponse(request.id, await this.auth.getSpotifyAuthState());
        case "spotify.setConnected":
          return okResponse(request.id, await this.auth.setSpotifyConnected(request.params?.connected === true));
        case "spotify.signIn": {
          const win = this.getMainWindow();
          if (win) this.auth.openSpotifyLogin(win);
          return okResponse(request.id, {});
        }
        case "spotify.playlists":
          return okResponse(request.id, { items: [], total: 0, raw: 0 });
        case "spotify.tracks":
          return okResponse(request.id, { items: [], total: 0, raw: 0 });
        case "spotify.playlist":
          return okResponse(request.id, { name: "", owner: null, imageUrl: null, total: 0 });
        case "spotify.searchTracks":
          return okResponse(request.id, []);
        case "spotify.canvas":
          return okResponse(request.id, { url: null });
        // ---- Discord ----
        case "discord.state":
          return okResponse(request.id, this.discord.getState());
        case "discord.connect":
          await this.discord.connect();
          return okResponse(request.id, {});
        case "discord.disconnect":
          return okResponse(request.id, await this.discord.disconnect());
        case "discord.setEnabled":
          return okResponse(request.id, await this.discord.setEnabled(request.params?.enabled === true));
        case "discord.presence":
          await this.discord.setPresence(request.params?.track ?? null, request.params?.options);
          return okResponse(request.id, {});
        default:
          return errorResponse(request.id, "unsupported", `Method ${request.method} is not handled.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(request.id, "internal", message);
    }
  }
  async proxyFetch(req) {
    const headers = new Headers(req.headers || {});
    const urlObj = new URL(req.url);
    const isStats = urlObj.hostname === "s.youtube.com";
    const isYt = urlObj.hostname.includes("youtube.com");
    const origin = isStats ? "https://music.youtube.com" : urlObj.origin;
    if (req.auth) {
      headers.delete("authorization");
      headers.delete("cookie");
      headers.delete("x-goog-authuser");
      headers.delete("x-goog-pageid");
      headers.delete("x-origin");
      headers.delete("origin");
      headers.delete("referer");
      const sapisidHash = await this.auth.getSapisidHash(origin);
      if (sapisidHash) {
        headers.set("Authorization", sapisidHash);
      }
      const cookieHeader = await this.auth.getCookieHeader(req.url.startsWith("http") ? req.url : origin);
      if (cookieHeader) {
        headers.set("Cookie", cookieHeader);
      }
      if (isYt) {
        headers.set("Origin", origin);
        headers.set("Referer", `${origin}/`);
        headers.set("X-Origin", origin);
      }
      const identity = this.auth.getActiveIdentity();
      if (identity) {
        headers.set("X-Goog-AuthUser", identity.authUser);
        if (identity.pageId) {
          headers.set("X-Goog-PageId", identity.pageId);
        } else {
          headers.delete("X-Goog-PageId");
        }
      }
    } else {
      if (req.url.includes("amp-api.music.apple.com")) {
        headers.set("Origin", "https://music.apple.com");
        headers.set("Referer", "https://music.apple.com/");
      } else if (req.url.includes("musixmatch.com")) {
        headers.set("Cookie", "mxm_bab=AB");
      }
    }
    const response = await fetch(req.url, {
      method: req.method || "GET",
      headers,
      body: req.body ? req.bodyEncoding === "base64" ? Buffer.from(req.body, "base64") : req.body : void 0
    });
    const isBase64 = req.bodyEncoding === "base64";
    let body = "";
    if (isBase64) {
      const buffer = await response.arrayBuffer();
      body = Buffer.from(buffer).toString("base64");
    } else {
      body = await response.text();
    }
    try {
      fs.appendFileSync(
        "c:/Users/James/Documents/GitHub/BitChord/electron/bridge-debug.log",
        `[${(/* @__PURE__ */ new Date()).toISOString()}] ${req.method} ${req.url} -> ${response.status}
Request Headers: ${JSON.stringify(Object.fromEntries(headers.entries()))}
Request Body: ${req.body ? typeof req.body === "string" ? req.body.slice(0, 300) : "[binary]" : "none"}
Response: ${body.slice(0, 600)}

`
      );
    } catch {
    }
    const respHeaders = {};
    response.headers.forEach((value, key) => {
      respHeaders[key] = value;
    });
    return {
      status: response.status,
      headers: respHeaders,
      body,
      bodyEncoding: isBase64 ? "base64" : "text",
      url: response.url
    };
  }
};

// src/main/discord.ts
import { Client } from "@xhayper/discord-rpc";
var APPLICATION_ID = "1543679166967193620";
var DEFAULT_BUTTON_1 = "Listen on YouTube Music";
var DEFAULT_BUTTON_2 = "Visit BitChord";
var APP_URL = "https://bitchord-8bw.pages.dev";
var ACTIVITY_TYPES = {
  playing: 0,
  streaming: 1,
  listening: 2,
  watching: 3,
  competing: 5
};
var DiscordRpcManager = class {
  client = null;
  isConnected = false;
  isConnecting = false;
  enabled = true;
  problem = null;
  stateListeners = /* @__PURE__ */ new Set();
  reconnectTimer = null;
  constructor() {
    this.connect().catch(() => {
    });
  }
  subscribeState(listener) {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }
  broadcastState() {
    const state = this.getState();
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch (err) {
        console.error("Error notifying Discord state listener:", err);
      }
    }
  }
  getState() {
    const user = this.client?.user;
    return {
      available: true,
      connected: this.isConnected,
      enabled: this.enabled,
      user: user ? {
        name: user.global_name || user.globalName || user.username,
        username: user.username,
        avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null
      } : null,
      gateway: this.isConnected ? "ready" : this.isConnecting ? "connecting" : "off",
      problem: this.problem
    };
  }
  async connect() {
    if (this.isConnected || this.isConnecting) return;
    this.isConnecting = true;
    this.problem = null;
    this.broadcastState();
    try {
      if (this.client) {
        try {
          await this.client.destroy();
        } catch {
        }
      }
      this.client = new Client({ clientId: APPLICATION_ID });
      this.client.on("ready", () => {
        this.isConnected = true;
        this.isConnecting = false;
        this.problem = null;
        this.broadcastState();
      });
      this.client.on("disconnected", () => {
        this.isConnected = false;
        this.isConnecting = false;
        this.broadcastState();
        this.scheduleReconnect();
      });
      await this.client.login().catch((err) => {
        this.isConnected = false;
        this.isConnecting = false;
        this.problem = err instanceof Error ? err.message : String(err);
        this.broadcastState();
        this.scheduleReconnect();
      });
    } catch (err) {
      this.isConnected = false;
      this.isConnecting = false;
      this.problem = err instanceof Error ? err.message : String(err);
      this.broadcastState();
      this.scheduleReconnect();
    }
  }
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.enabled && !this.isConnected) {
        this.connect().catch(() => {
        });
      }
    }, 15e3);
  }
  async disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        await this.client.destroy();
      } catch {
      }
      this.client = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.problem = null;
    this.broadcastState();
    return this.getState();
  }
  async setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      if (this.client && this.isConnected) {
        try {
          await this.client.user?.clearActivity();
        } catch {
        }
      }
    } else if (!this.isConnected) {
      this.connect().catch(() => {
      });
    }
    this.broadcastState();
    return this.getState();
  }
  async setPresence(track, options) {
    if (!this.enabled || !this.isConnected || !this.client?.user) return;
    if (!track) {
      try {
        await this.client.user.clearActivity();
      } catch (err) {
        console.warn("Failed to clear Discord activity:", err);
      }
      return;
    }
    try {
      const playbackRate = track.playbackRate || 1;
      const startTimestamp = Math.floor(Date.now() - track.positionMs / playbackRate);
      const endTimestamp = startTimestamp + Math.floor(track.durationMs / playbackRate);
      const buttons = [];
      const resolveVars = (text2) => {
        return text2.replaceAll("{song_name}", track.title).replaceAll("{artist_name}", track.artist).replaceAll("{album_name}", track.album ?? "");
      };
      if (options?.button1Visible ?? true) {
        const url = track.videoId ? `https://music.youtube.com/watch?v=${track.videoId}` : APP_URL;
        buttons.push({
          label: resolveVars(options?.button1Text || DEFAULT_BUTTON_1).slice(0, 32),
          url
        });
      }
      if (options?.button2Visible ?? true) {
        buttons.push({
          label: resolveVars(options?.button2Text || DEFAULT_BUTTON_2).slice(0, 32),
          url: APP_URL
        });
      }
      const activityType = options?.activityType ? ACTIVITY_TYPES[options.activityType] ?? 2 : 2;
      const activityName = options?.activityName?.trim() || "BitChord";
      const details = playbackRate !== 1 ? `${track.title} [${playbackRate.toFixed(2)}x]` : track.title;
      const state = track.artist + (track.album ? ` \u2022 ${track.album}` : "");
      await this.client.user.setActivity({
        name: activityName,
        type: activityType,
        details: details.slice(0, 128),
        state: state.slice(0, 128),
        statusDisplayType: options?.useDetails ? 2 : 1,
        startTimestamp: new Date(startTimestamp),
        endTimestamp: new Date(endTimestamp),
        largeImageKey: track.artworkUrl || "bitchord_logo",
        largeImageText: (track.album || track.title).slice(0, 128),
        smallImageKey: "bitchord_logo",
        smallImageText: "BitChord",
        buttons: buttons.slice(0, 2)
      });
    } catch (err) {
      console.warn("Failed to update Discord presence:", err);
    }
  }
};

// src/main/headers.ts
function setupHeaderInterception(session2) {
  session2.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url;
    const headers = { ...details.requestHeaders };
    if (url.includes("googlevideo.com")) {
      if (url.includes("c=VISIONOS")) {
        delete headers["Origin"];
        delete headers["origin"];
        delete headers["Referer"];
        delete headers["referer"];
      } else {
        headers["Origin"] = "https://www.youtube.com";
        headers["Referer"] = "https://www.youtube.com/";
      }
    } else if (url.includes("music.youtube.com/youtubei/")) {
      headers["Origin"] = "https://music.youtube.com";
      headers["Referer"] = "https://music.youtube.com/";
      headers["X-Origin"] = "https://music.youtube.com";
    } else if (url.includes("www.youtube.com/youtubei/")) {
      headers["Origin"] = "https://www.youtube.com";
      headers["Referer"] = "https://www.youtube.com/";
      headers["X-Origin"] = "https://www.youtube.com";
    } else if (url.includes("s.youtube.com")) {
      headers["Origin"] = "https://music.youtube.com";
      headers["Referer"] = "https://music.youtube.com/";
    } else if (url.includes("open.spotify.com") || url.includes("api-partner.spotify.com") || url.includes("clienttoken.spotify.com")) {
      headers["Origin"] = "https://open.spotify.com";
      headers["Referer"] = "https://open.spotify.com/";
    } else if (url.includes("discord.com/api/")) {
      headers["Origin"] = "https://discord.com";
      headers["Referer"] = "https://discord.com/";
    }
    callback({ requestHeaders: headers });
  });
  session2.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url;
    const responseHeaders = { ...details.responseHeaders };
    const shouldInjectCors = url.includes("youtube.com") || url.includes("googlevideo.com") || url.includes("spotify.com") || url.includes("spotifycdn.com") || url.includes("lrclib.net") || url.includes("kuwo.cn") || url.includes("netease.com") || url.includes("qq.com") || url.includes("kugou.com");
    if (shouldInjectCors) {
      for (const key of Object.keys(responseHeaders)) {
        const lower = key.toLowerCase();
        if (lower === "access-control-allow-origin" || lower === "access-control-allow-methods" || lower === "access-control-allow-headers" || lower === "access-control-expose-headers" || lower === "access-control-allow-credentials" || lower === "x-frame-options" || lower === "content-security-policy" || lower === "content-security-policy-report-only") {
          delete responseHeaders[key];
        }
      }
      const reqOrigin = details.initiator || (details.referrer ? new URL(details.referrer).origin : null) || "*";
      responseHeaders["access-control-allow-origin"] = [reqOrigin];
      responseHeaders["access-control-allow-methods"] = ["GET, POST, PUT, DELETE, OPTIONS, HEAD"];
      responseHeaders["access-control-allow-headers"] = ["*"];
      responseHeaders["access-control-expose-headers"] = ["*"];
      responseHeaders["access-control-allow-credentials"] = ["true"];
    }
    callback({ responseHeaders });
  });
}

// src/main/media.ts
import zlib from "zlib";
import { globalShortcut, nativeImage, nativeTheme } from "electron";
var rect = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
var GLYPHS = {
  prev: [rect(6, 6, 8, 18), [[9.5, 12], [18, 6], [18, 18]]],
  play: [[[8, 5], [8, 19], [19, 12]]],
  pause: [rect(6, 5, 10, 19), rect(14, 5, 18, 19)],
  next: [[[6, 6], [14.5, 12], [6, 18]], rect(16, 6, 18, 18)]
};
var CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 4294967295;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function pointInPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function renderGlyph(polys, rgb, size = 32) {
  const SUPERSAMPLE = 4;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = (x + (sx + 0.5) / SUPERSAMPLE) * 24 / size;
          const py = (y + (sy + 0.5) / SUPERSAMPLE) * 24 / size;
          if (polys.some((p) => pointInPoly(p, px, py))) hits++;
        }
      }
      const o = y * stride + 1 + x * 4;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
      raw[o + 3] = Math.round(255 * hits / (SUPERSAMPLE * SUPERSAMPLE));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
  return nativeImage.createFromBuffer(png);
}
var MediaControlsManager = class {
  getMainWindow;
  getPageContents;
  isPlaying = false;
  onPlaybackChange = null;
  constructor(getMainWindow, getPageContents) {
    this.getMainWindow = getMainWindow;
    this.getPageContents = getPageContents;
    this.registerGlobalShortcuts();
    nativeTheme.on("updated", () => this.updateThumbarButtons());
  }
  sendAction(action) {
    const contents = this.getPageContents();
    if (!contents || contents.isDestroyed()) return;
    contents.send("media:action", action);
  }
  registerGlobalShortcuts() {
    try {
      globalShortcut.register("MediaPlayPause", () => this.sendAction("toggle"));
      globalShortcut.register("MediaNextTrack", () => this.sendAction("next"));
      globalShortcut.register("MediaPreviousTrack", () => this.sendAction("prev"));
      globalShortcut.register("CommandOrControl+Alt+Space", () => this.sendAction("toggle"));
      globalShortcut.register("CommandOrControl+Alt+Right", () => this.sendAction("next"));
      globalShortcut.register("CommandOrControl+Alt+Left", () => this.sendAction("prev"));
    } catch (err) {
      console.warn("Failed to register some global media shortcuts:", err);
    }
  }
  unregisterAll() {
    globalShortcut.unregisterAll();
  }
  setPlaybackState(playing) {
    this.isPlaying = playing;
    this.updateThumbarButtons();
    this.onPlaybackChange?.(playing);
  }
  /**
   * Sets up taskbar thumbnail toolbar buttons on Windows
   */
  updateThumbarButtons() {
    if (process.platform !== "win32") return;
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) return;
    try {
      const rgb = nativeTheme.shouldUseDarkColors ? [255, 255, 255] : [32, 32, 32];
      const prevIcon = renderGlyph(GLYPHS.prev, rgb);
      const playPauseIcon = renderGlyph(this.isPlaying ? GLYPHS.pause : GLYPHS.play, rgb);
      const nextIcon = renderGlyph(GLYPHS.next, rgb);
      win.setThumbarButtons([
        {
          tooltip: "Previous track",
          icon: prevIcon,
          click: () => this.sendAction("prev")
        },
        {
          tooltip: this.isPlaying ? "Pause" : "Play",
          icon: playPauseIcon,
          click: () => this.sendAction("toggle")
        },
        {
          tooltip: "Next track",
          icon: nextIcon,
          click: () => this.sendAction("next")
        }
      ]);
    } catch {
    }
  }
};

// src/main/tray.ts
import fs2 from "fs";
import { app, Menu, nativeImage as nativeImage2, nativeTheme as nativeTheme2, Tray } from "electron";
var TrayManager = class {
  tray = null;
  opts;
  isPlaying = false;
  title = "";
  constructor(opts) {
    this.opts = opts;
    if (!fs2.existsSync(opts.iconPath)) return;
    let image = nativeImage2.createFromPath(opts.iconPath);
    if (image.isEmpty()) return;
    image = image.resize({ width: process.platform === "darwin" ? 18 : 16, height: process.platform === "darwin" ? 18 : 16 });
    this.tray = new Tray(image);
    this.tray.on("click", () => this.openWindow());
    nativeTheme2.on("updated", () => this.refresh());
    this.refresh();
  }
  setPlaying(playing) {
    this.isPlaying = playing;
    this.refresh();
  }
  setTitle(title) {
    this.title = title;
    this.refresh();
  }
  destroy() {
    this.tray?.destroy();
    this.tray = null;
  }
  openWindow() {
    const win = this.opts.getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  refresh() {
    if (!this.tray) return;
    const label = this.title || "Nothing playing";
    const shortLabel = label.length > 60 ? `${label.slice(0, 57)}...` : label;
    const rgb = nativeTheme2.shouldUseDarkColors ? [255, 255, 255] : [32, 32, 32];
    const icon = (polys) => renderGlyph(polys, rgb, 32).resize({ width: 16, height: 16 });
    const mid = this.isPlaying ? GLYPHS.pause : GLYPHS.play;
    this.tray.setToolTip(this.title ? `BitChord - ${shortLabel}` : "BitChord");
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: shortLabel, enabled: false },
        { type: "separator" },
        { label: this.isPlaying ? "Pause" : "Play", icon: icon(mid), click: () => this.opts.sendAction("toggle") },
        { label: "Next", icon: icon(GLYPHS.next), click: () => this.opts.sendAction("next") },
        { label: "Previous", icon: icon(GLYPHS.prev), click: () => this.opts.sendAction("prev") },
        { type: "separator" },
        { label: "Open BitChord", click: () => this.openWindow() },
        { label: "Quit", click: () => app.quit() }
      ])
    );
  }
};

// src/main/index.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var DEFAULT_WEB_URL = "https://bitchord-8bw.pages.dev/home";
var TITLEBAR_HEIGHT = 32;
var mainWindow = null;
var pageView = null;
var titlebarView = null;
var authManager = null;
var discordManager = null;
var bridgeHandler = null;
var mediaManager = null;
var trayManager = null;
var isQuitting = false;
app2.setAppUserModelId("com.music.bitchord");
var gotTheLock = app2.requestSingleInstanceLock();
if (!gotTheLock) {
  app2.quit();
} else {
  app2.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
function broadcastBridgeEvent(event) {
  if (pageView && !pageView.webContents.isDestroyed()) {
    pageView.webContents.send("bridge:event", event);
  }
}
function sendToTitlebar(channel, payload) {
  if (titlebarView && !titlebarView.webContents.isDestroyed()) {
    titlebarView.webContents.send(channel, payload);
  }
}
function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed() || !pageView || !titlebarView) return;
  const { width, height } = mainWindow.getContentBounds();
  const hideBar = mainWindow.isFullScreen();
  const barHeight = hideBar ? 0 : TITLEBAR_HEIGHT;
  titlebarView.setVisible(!hideBar);
  titlebarView.setBounds({ x: 0, y: 0, width, height: barHeight });
  pageView.setBounds({ x: 0, y: barHeight, width, height: Math.max(0, height - barHeight) });
}
async function createWindow() {
  const currentSession = session.defaultSession;
  setupHeaderInterception(currentSession);
  authManager = new AuthManager(currentSession);
  discordManager = new DiscordRpcManager();
  bridgeHandler = new BridgeHandler(authManager, discordManager, () => mainWindow);
  mediaManager = new MediaControlsManager(() => mainWindow, () => pageView?.webContents ?? null);
  trayManager?.destroy();
  trayManager = new TrayManager({
    iconPath: path.resolve(__dirname, "../../assets/icon.png"),
    getMainWindow: () => mainWindow,
    sendAction: (action) => mediaManager?.sendAction(action)
  });
  mediaManager.onPlaybackChange = (playing) => trayManager?.setPlaying(playing);
  authManager.subscribeYt((data) => broadcastBridgeEvent({ event: "yt.authState", data }));
  authManager.subscribeSpotify((data) => broadcastBridgeEvent({ event: "spotify.authState", data }));
  discordManager.subscribeState((data) => broadcastBridgeEvent({ event: "discord.state", data }));
  const preloadPath = path.join(__dirname, "../preload/index.cjs");
  const titlebarPreloadPath = path.join(__dirname, "../preload/titlebar.cjs");
  const iconPath = process.platform === "win32" ? path.resolve(__dirname, "../../assets/icon.ico") : path.resolve(__dirname, "../../assets/icon.png");
  mainWindow = new BrowserWindow4({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "BitChord",
    icon: fs3.existsSync(iconPath) ? iconPath : void 0,
    backgroundColor: "#1f1f1f",
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...process.platform === "darwin" ? { trafficLightPosition: { x: 16, y: 10 } } : {}
  });
  mainWindow.setMenuBarVisibility(false);
  pageView = new WebContentsView({
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false
    }
  });
  titlebarView = new WebContentsView({
    webPreferences: {
      preload: titlebarPreloadPath,
      contextIsolation: false,
      sandbox: false
    }
  });
  mainWindow.contentView.addChildView(pageView);
  mainWindow.contentView.addChildView(titlebarView);
  layoutViews();
  mainWindow.on("resize", layoutViews);
  mainWindow.on("enter-full-screen", layoutViews);
  mainWindow.on("leave-full-screen", layoutViews);
  void titlebarView.webContents.loadURL('data:text/html;charset=utf-8,<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  pageView.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes("spotify.com") || url.includes("accounts.google.com") || url.includes("google.com") || url.includes("music.youtube.com")) {
      if (mainWindow) {
        if (url.includes("spotify.com")) {
          authManager?.openSpotifyLogin(mainWindow, url);
        } else {
          authManager?.openYouTubeLogin(mainWindow, url);
        }
      }
      return { action: "deny" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mediaManager?.updateThumbarButtons();
  });
  mainWindow.on("maximize", () => sendToTitlebar("window:state", { isMaximized: true }));
  mainWindow.on("unmaximize", () => sendToTitlebar("window:state", { isMaximized: false }));
  mainWindow.on("focus", () => sendToTitlebar("window:focus", { isFocused: true }));
  mainWindow.on("blur", () => sendToTitlebar("window:focus", { isFocused: false }));
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    pageView = null;
    titlebarView = null;
  });
  const cachedIndexPath = path.resolve(__dirname, "../../cached-web/index.html");
  const targetUrl = process.env.BITCHORD_URL || DEFAULT_WEB_URL;
  if (process.env.BITCHORD_OFFLINE && fs3.existsSync(cachedIndexPath)) {
    console.log("Loading local cached BitChord build:", cachedIndexPath);
    await pageView.webContents.loadFile(cachedIndexPath);
  } else {
    console.log("Loading BitChord web URL:", targetUrl);
    await pageView.webContents.loadURL(targetUrl);
  }
  return mainWindow;
}
ipcMain.handle("bridge:call", async (_event, request) => {
  if (!bridgeHandler) throw new Error("BridgeHandler not initialized");
  return bridgeHandler.handle(request);
});
ipcMain.on("playback:state", (_event, { playing }) => {
  mediaManager?.setPlaybackState(playing);
});
ipcMain.on("playback:title", (_event, { title }) => {
  trayManager?.setTitle(title);
});
ipcMain.on("window:minimize", () => {
  mainWindow?.minimize();
});
ipcMain.on("window:maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.on("window:close", () => {
  mainWindow?.close();
});
ipcMain.handle("window:isMaximized", () => {
  return mainWindow?.isMaximized() ?? false;
});
app2.whenReady().then(async () => {
  await createWindow();
  app2.on("activate", () => {
    if (mainWindow) {
      mainWindow.show();
    } else if (BrowserWindow4.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});
app2.on("before-quit", () => {
  isQuitting = true;
});
app2.on("will-quit", () => {
  mediaManager?.unregisterAll();
  trayManager?.destroy();
  void discordManager?.disconnect();
});
app2.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app2.quit();
  }
});
//# sourceMappingURL=index.js.map