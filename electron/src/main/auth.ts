import { BrowserWindow, Session } from 'electron';
import crypto from 'node:crypto';
import type {
  SpotifyAuthState,
  YtAccount,
  YtAuthState,
  YtChannel,
} from '../common/types.js';

const SIGNING_COOKIES = ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'];
const SESSION_COOKIES = new Set([...SIGNING_COOKIES, 'SID', '__Secure-1PSID', '__Secure-3PSID']);
const MUSIC_ORIGIN = 'https://music.youtube.com';
const WEB_REMIX_VERSION = '1.20251006.03.00';
const MAX_LOGINS = 10;

type Json = Record<string, unknown>;

function renderers(root: unknown, key: string, out: Json[] = []): Json[] {
  if (Array.isArray(root)) {
    for (const item of root) renderers(item, key, out);
  } else if (root && typeof root === 'object') {
    for (const [k, v] of Object.entries(root)) {
      if (k === key && v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Json);
      else renderers(v, key, out);
    }
  }
  return out;
}

function findString(root: unknown, key: string): string | null {
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findString(item, key);
      if (found) return found;
    }
  } else if (root && typeof root === 'object') {
    for (const [k, v] of Object.entries(root)) {
      if (k === key && typeof v === 'string' && v) return v;
      const found = findString(v, key);
      if (found) return found;
    }
  }
  return null;
}

function text(node: unknown): string {
  const n = node as { runs?: { text?: string }[]; simpleText?: string } | undefined;
  if (n?.runs) return n.runs.map((r) => r.text ?? '').join('');
  return n?.simpleText ?? '';
}

function photo(item: Json): string | null {
  const thumbnails = (item.accountPhoto as { thumbnails?: { url?: string }[] } | undefined)?.thumbnails;
  return thumbnails?.at(-1)?.url ?? null;
}

interface StoredChannel extends YtChannel {
  authUser: string;
  pageId: string | null;
  selectedOnWeb: boolean;
}

export class AuthManager {
  private session: Session;
  private ytConnected = true;
  private spotifyConnected = true;
  private activePopup: BrowserWindow | null = null;
  private ytListeners: Set<(state: YtAuthState) => void> = new Set();
  private spotifyListeners: Set<(state: SpotifyAuthState) => void> = new Set();
  private cachedYtAccounts: YtAccount[] | null = null;
  private cachedActiveChannel: (YtChannel & { authUser: string }) | null = null;
  private selectedChannelId: string | null = null;
  private isClearingCookies = false;
  private cookieDebounceTimer: NodeJS.Timeout | null = null;

  constructor(session: Session) {
    this.session = session;
    this.setupCookieListener();
  }

  public subscribeYt(listener: (state: YtAuthState) => void): () => void {
    this.ytListeners.add(listener);
    void this.getYtAuthState().then(listener);
    return () => this.ytListeners.delete(listener);
  }

  public subscribeSpotify(listener: (state: SpotifyAuthState) => void): () => void {
    this.spotifyListeners.add(listener);
    void this.getSpotifyAuthState().then(listener);
    return () => this.spotifyListeners.delete(listener);
  }

  private broadcastYt(state: YtAuthState): void {
    for (const listener of this.ytListeners) {
      listener(state);
    }
  }

  private broadcastSpotify(state: SpotifyAuthState): void {
    for (const listener of this.spotifyListeners) {
      listener(state);
    }
  }

  private setupCookieListener(): void {
    this.session.cookies.on('changed', (_event, cookie) => {
      if (this.isClearingCookies) return;

      const domain = cookie.domain || '';
      if (domain.includes('youtube.com') || domain.includes('google.com')) {
        if (SESSION_COOKIES.has(cookie.name)) {
          if (this.cookieDebounceTimer) clearTimeout(this.cookieDebounceTimer);
          this.cookieDebounceTimer = setTimeout(() => {
            this.cachedYtAccounts = null;
            this.cachedActiveChannel = null;
            void this.getYtAuthState(true).then((state) => this.broadcastYt(state));
          }, 300);
        }
      } else if (domain.includes('spotify.com')) {
        if (cookie.name === 'sp_dc') {
          void this.getSpotifyAuthState().then((state) => this.broadcastSpotify(state));
        }
      }
    });
  }

  // ---- YouTube Auth ----

  public async getSigningSecret(): Promise<string | null> {
    for (const name of SIGNING_COOKIES) {
      const cookies = await this.session.cookies.get({ url: MUSIC_ORIGIN, name });
      if (cookies.length > 0 && cookies[0]?.value) {
        return cookies[0].value;
      }
    }
    return null;
  }

  public async getSapisidHash(origin = MUSIC_ORIGIN): Promise<string | null> {
    const secret = await this.getSigningSecret();
    if (!secret) return null;
    const timestamp = Math.floor(Date.now() / 1000);
    const hash = crypto.createHash('sha1').update(`${timestamp} ${secret} ${origin}`).digest('hex');
    return `SAPISIDHASH ${timestamp}_${hash}`;
  }

  public async getCookieHeader(url: string): Promise<string> {
    const cookies = await this.session.cookies.get({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  public getActiveIdentity(): { authUser: string; pageId: string | null } | null {
    if (!this.cachedActiveChannel) return null;
    const parts = this.cachedActiveChannel.id.split(':');
    const authUser = this.cachedActiveChannel.authUser || parts[0] || '0';
    const pageId = parts[1] && parts[1] !== 'own' ? parts[1] : null;
    return { authUser, pageId };
  }

  private async webSessionIndex(cookieHeader: string, sapisidHash: string): Promise<string | null> {
    try {
      const response = await fetch(`${MUSIC_ORIGIN}/`, {
        headers: {
          Accept: 'text/html',
          Authorization: sapisidHash,
          Cookie: cookieHeader,
          Origin: MUSIC_ORIGIN,
          Referer: `${MUSIC_ORIGIN}/`,
          'X-Origin': MUSIC_ORIGIN,
        },
      });
      const html = await response.text();
      return /"SESSION_INDEX":"?(\d+)/.exec(html)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  private async readLogin(
    authUser: string,
    cookieHeader: string,
    sapisidHash: string
  ): Promise<{ account: YtAccount | null; why: string | null }> {
    try {
      const response = await fetch(`${MUSIC_ORIGIN}/youtubei/v1/account/account_menu?prettyPrint=false`, {
        method: 'POST',
        headers: {
          Authorization: sapisidHash,
          'X-Goog-AuthUser': authUser,
          'X-Origin': MUSIC_ORIGIN,
          Origin: MUSIC_ORIGIN,
          Referer: `${MUSIC_ORIGIN}/`,
          Cookie: cookieHeader,
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': '67',
          'X-Youtube-Client-Version': WEB_REMIX_VERSION,
        },
        body: JSON.stringify({
          context: {
            client: { clientName: 'WEB_REMIX', clientVersion: WEB_REMIX_VERSION, hl: 'en', gl: 'US' },
            user: {},
          },
        }),
      });

      if (!response.ok) return { account: null, why: `HTTP ${response.status}` };
      const menu: any = await response.json();
      const header = renderers(menu, 'activeAccountHeaderRenderer')[0];
      if (!header) return { account: null, why: 'No activeAccountHeaderRenderer' };

      const name = text(header.accountName) || `Google Account ${authUser}`;
      const email = text(header.email) || null;
      const handle = text(header.channelHandle) || null;
      const avatarUrl = photo(header);

      let channels: StoredChannel[] = [];
      try {
        const listRes = await fetch(`${MUSIC_ORIGIN}/youtubei/v1/account/accounts_list?prettyPrint=false`, {
          method: 'POST',
          headers: {
            Authorization: sapisidHash,
            'X-Goog-AuthUser': authUser,
            'X-Origin': MUSIC_ORIGIN,
            Origin: MUSIC_ORIGIN,
            Referer: `${MUSIC_ORIGIN}/`,
            Cookie: cookieHeader,
            'Content-Type': 'application/json',
            'X-Youtube-Client-Name': '67',
            'X-Youtube-Client-Version': WEB_REMIX_VERSION,
          },
          body: JSON.stringify({
            context: {
              client: { clientName: 'WEB_REMIX', clientVersion: WEB_REMIX_VERSION, hl: 'en', gl: 'US' },
              user: {},
            },
          }),
        });

        if (listRes.ok) {
          const listJson: any = await listRes.json();
          for (const item of renderers(listJson, 'accountItem')) {
            const chName = text(item.accountName);
            if (!chName) continue;
            const pageId = findString(item, 'pageId');
            const chHandle = text(item.channelHandle) || text(item.accountByline) || null;
            const id = `${authUser}:${pageId ?? 'own'}`;
            if (channels.some((c) => c.id === id)) continue;
            channels.push({
              id,
              name: chName,
              handle: chHandle,
              avatarUrl: photo(item),
              brand: pageId !== null,
              authUser,
              pageId,
              selectedOnWeb: item.isSelected === true,
            });
          }
        }
      } catch {}

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
            selectedOnWeb: true,
          },
        ];
      }

      return {
        account: {
          authUser,
          name,
          email,
          avatarUrl,
          channels,
        },
        why: null,
      };
    } catch (err: unknown) {
      return { account: null, why: err instanceof Error ? err.message : String(err) };
    }
  }

  private async fetchYtAccounts(): Promise<{
    accounts: YtAccount[];
    active: (YtChannel & { authUser: string }) | null;
  }> {
    const sapisidHash = await this.getSapisidHash();
    if (!sapisidHash) return { accounts: [], active: null };

    const cookieHeader = await this.getCookieHeader(MUSIC_ORIGIN);

    // Parallel scan of authUser indices 0 through MAX_LOGINS - 1
    const [results, webIndex] = await Promise.all([
      Promise.all(Array.from({ length: MAX_LOGINS }, (_, i) => this.readLogin(String(i), cookieHeader, sapisidHash))),
      this.webSessionIndex(cookieHeader, sapisidHash),
    ]);

    const accounts: YtAccount[] = [];
    const seen = new Set<string>();
    for (const { account } of results) {
      if (!account) continue;
      const channelSuffixes = (account.channels as StoredChannel[]).map((c) => c.id.split(':')[1]).join(',');
      const key = account.email ?? `${account.name}|${channelSuffixes}`;
      if (seen.has(key)) continue;
      seen.add(key);
      accounts.push(account);
    }

    if (accounts.length === 0) {
      const fallback: YtChannel = {
        id: '0:own',
        name: 'Google Account',
        handle: null,
        avatarUrl: null,
        brand: false,
      };
      return {
        accounts: [
          {
            authUser: '0',
            name: 'Google Account',
            email: null,
            avatarUrl: null,
            channels: [fallback],
          },
        ],
        active: { ...fallback, authUser: '0' },
      };
    }

    const allChannels = accounts.flatMap((a) => a.channels as StoredChannel[]);
    const webAccount = accounts.find((a) => a.authUser === webIndex) ?? accounts[0];
    const webChannels = (webAccount?.channels ?? []) as StoredChannel[];

    let activeChannel: (YtChannel & { authUser: string }) | null = null;
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

  public async getYtAuthState(refresh = false): Promise<YtAuthState> {
    const secret = await this.getSigningSecret();
    const browserSignedIn = !!secret;

    if (!browserSignedIn || !this.ytConnected) {
      return {
        browserSignedIn,
        connected: this.ytConnected,
        signedIn: false,
        accounts: [],
        active: null,
        problem: null,
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
      problem: null,
    };
  }

  public async selectChannel(channelId: string): Promise<YtAuthState> {
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

  public async clearGoogleCookies(): Promise<void> {
    this.isClearingCookies = true;
    try {
      const cookies = await this.session.cookies.get({});
      for (const cookie of cookies) {
        const domain = (cookie.domain || '').replace(/^\./, '');
        if (domain.includes('youtube.com') || domain.includes('google.com')) {
          const scheme = cookie.secure ? 'https' : 'http';
          const urls = [
            `${scheme}://${domain}${cookie.path || '/'}`,
            `${scheme}://www.${domain}${cookie.path || '/'}`,
            `${scheme}://music.${domain}${cookie.path || '/'}`,
            `${scheme}://accounts.${domain}${cookie.path || '/'}`,
          ];
          for (const url of urls) {
            try {
              await this.session.cookies.remove(url, cookie.name);
            } catch {}
          }
        }
      }
      if (await this.getSigningSecret()) {
        await this.session.clearStorageData({ storages: ['cookies'] });
      }
    } finally {
      this.isClearingCookies = false;
    }
  }

  public async setYtConnected(connected: boolean): Promise<YtAuthState> {
    if (!connected) {
      this.ytConnected = false;
      await this.clearGoogleCookies();
      this.cachedYtAccounts = null;
      this.cachedActiveChannel = null;
      this.selectedChannelId = null;
      const state: YtAuthState = {
        browserSignedIn: false,
        connected: false,
        signedIn: false,
        accounts: [],
        active: null,
        problem: null,
      };
      this.broadcastYt(state);
      return state;
    }

    this.ytConnected = true;
    const state = await this.getYtAuthState(true);
    this.broadcastYt(state);
    return state;
  }

  // ---- Spotify Auth ----

  public async getSpotifyDc(): Promise<string | null> {
    const cookies = await this.session.cookies.get({ domain: '.spotify.com', name: 'sp_dc' });
    return cookies[0]?.value ?? null;
  }

  public async getSpotifyAuthState(): Promise<SpotifyAuthState> {
    const spDc = await this.getSpotifyDc();
    const browserSignedIn = !!spDc;
    return {
      browserSignedIn,
      connected: this.spotifyConnected,
      signedIn: browserSignedIn && this.spotifyConnected,
      user: null,
      problem: null,
    };
  }

  public async setSpotifyConnected(connected: boolean): Promise<SpotifyAuthState> {
    if (!connected) {
      const cookies = await this.session.cookies.get({ domain: '.spotify.com' });
      for (const cookie of cookies) {
        const url = `https://open.spotify.com${cookie.path || '/'}`;
        try {
          await this.session.cookies.remove(url, cookie.name);
        } catch {}
      }
      this.spotifyConnected = false;
      const state: SpotifyAuthState = {
        browserSignedIn: false,
        connected: false,
        signedIn: false,
        user: null,
        problem: null,
      };
      this.broadcastSpotify(state);
      return state;
    }

    this.spotifyConnected = true;
    const state = await this.getSpotifyAuthState();
    this.broadcastSpotify(state);
    return state;
  }

  public openSpotifyLogin(parentWindow: BrowserWindow, targetUrl?: string): void {
    if (this.activePopup && !this.activePopup.isDestroyed()) {
      this.activePopup.focus();
      return;
    }

    const chromeUa = parentWindow.webContents.getUserAgent().replace(/Electron\/\S+\s?/, '');

    this.activePopup = new BrowserWindow({
      width: 500,
      height: 700,
      parent: parentWindow,
      modal: true,
      title: 'Sign in to Spotify',
      autoHideMenuBar: true,
      webPreferences: {
        session: this.session,
        sandbox: true,
      },
    });

    this.activePopup.webContents.setUserAgent(chromeUa);

    const checkSuccess = (navUrl: string) => {
      if (navUrl.startsWith('https://open.spotify.com')) {
        setTimeout(() => {
          if (this.activePopup && !this.activePopup.isDestroyed()) {
            this.activePopup.close();
            this.activePopup = null;
          }
        }, 1000);
      }
    };

    this.activePopup.webContents.on('did-navigate', (_e, url) => checkSuccess(url));
    this.activePopup.webContents.on('did-redirect-navigation', (_e, url) => checkSuccess(url));

    this.activePopup.on('closed', () => {
      this.activePopup = null;
      void this.getSpotifyAuthState().then((state) => this.broadcastSpotify(state));
    });

    void this.activePopup.loadURL(
      targetUrl || 'https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F'
    );
  }

  public openYouTubeLogin(parentWindow: BrowserWindow, targetUrl?: string): void {
    if (this.activePopup && !this.activePopup.isDestroyed()) {
      this.activePopup.focus();
      return;
    }

    const chromeUa = parentWindow.webContents.getUserAgent().replace(/Electron\/\S+\s?/, '');
    const popupOpenedAt = Date.now();

    this.activePopup = new BrowserWindow({
      width: 500,
      height: 700,
      parent: parentWindow,
      modal: true,
      title: 'Sign in to YouTube Music',
      autoHideMenuBar: true,
      webPreferences: {
        session: this.session,
        sandbox: true,
      },
    });

    this.activePopup.webContents.setUserAgent(chromeUa);

    const checkSuccess = (navUrl: string) => {
      const isTarget = navUrl.startsWith('https://music.youtube.com') || navUrl.startsWith('https://www.youtube.com');
      const elapsed = Date.now() - popupOpenedAt;

      // Ensure popup doesn't close on an immediate pre-sign-in redirect
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
        }, 1000);
      }
    };

    this.activePopup.webContents.on('did-navigate', (_e, url) => checkSuccess(url));
    this.activePopup.webContents.on('did-redirect-navigation', (_e, url) => checkSuccess(url));

    this.activePopup.on('closed', () => {
      this.activePopup = null;
      setTimeout(async () => {
        this.cachedYtAccounts = null;
        this.cachedActiveChannel = null;
        const state = await this.getYtAuthState(true);
        this.broadcastYt(state);
      }, 500);
    });

    void this.activePopup.loadURL(
      targetUrl || 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F'
    );
  }
}
