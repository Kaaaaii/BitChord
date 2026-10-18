import fs from 'node:fs';
import { BrowserWindow } from 'electron';
import type { AuthManager } from './auth.js';
import type { DiscordRpcManager } from './discord.js';
import {
  BRIDGE_PROTOCOL,
  errorResponse,
  okResponse,
  type BridgeRequest,
  type BridgeResponse,
  type Capability,
  type HttpRequest,
  type HttpResponse,
} from '../common/types.js';

const CAPABILITIES: Capability[] = ['yt', 'yt.auth', 'yt.stats', 'lyrics', 'spotify', 'discord'];

export class BridgeHandler {
  private auth: AuthManager;
  private discord: DiscordRpcManager;
  private getMainWindow: () => BrowserWindow | null;

  constructor(auth: AuthManager, discord: DiscordRpcManager, getMainWindow: () => BrowserWindow | null) {
    this.auth = auth;
    this.discord = discord;
    this.getMainWindow = getMainWindow;
  }

  public async handle(request: BridgeRequest): Promise<BridgeResponse> {
    if (request.protocol !== BRIDGE_PROTOCOL) {
      return errorResponse(
        request.id,
        'protocol',
        `Protocol mismatch: expected ${BRIDGE_PROTOCOL}, received ${request.protocol}`
      );
    }

    try {
      switch (request.method) {
        case 'ping':
          return okResponse(request.id, {
            version: '1.0.0',
            protocol: BRIDGE_PROTOCOL,
            browser: 'chromium',
            capabilities: CAPABILITIES,
          });

        // ---- YouTube ----
        case 'yt.fetch': {
          const res = await this.proxyFetch(request.params);
          return okResponse(request.id, res);
        }
        case 'yt.authState':
          return okResponse(request.id, await this.auth.getYtAuthState(request.params?.refresh === true));
        case 'yt.selectChannel':
          return okResponse(request.id, await this.auth.selectChannel(request.params?.channelId));
        case 'yt.setConnected':
          return okResponse(request.id, await this.auth.setYtConnected(request.params?.connected === true));

        // ---- Lyrics ----
        case 'lyrics.permissions':
          return okResponse(request.id, { granted: request.params?.origins ?? [] });
        case 'lyrics.requestPermissions':
          return okResponse(request.id, {});
        case 'lyrics.fetch': {
          const res = await this.proxyFetch(request.params);
          return okResponse(request.id, res);
        }

        // ---- Spotify ----
        case 'spotify.authState':
          return okResponse(request.id, await this.auth.getSpotifyAuthState());
        case 'spotify.setConnected':
          return okResponse(request.id, await this.auth.setSpotifyConnected(request.params?.connected === true));
        case 'spotify.signIn': {
          const win = this.getMainWindow();
          if (win) this.auth.openSpotifyLogin(win);
          return okResponse(request.id, {});
        }
        case 'spotify.playlists':
          return okResponse(request.id, { items: [], total: 0, raw: 0 });
        case 'spotify.tracks':
          return okResponse(request.id, { items: [], total: 0, raw: 0 });
        case 'spotify.playlist':
          return okResponse(request.id, { name: '', owner: null, imageUrl: null, total: 0 });
        case 'spotify.searchTracks':
          return okResponse(request.id, []);
        case 'spotify.canvas':
          return okResponse(request.id, { url: null });

        // ---- Discord ----
        case 'discord.state':
          return okResponse(request.id, this.discord.getState());
        case 'discord.connect':
          await this.discord.connect();
          return okResponse(request.id, {});
        case 'discord.disconnect':
          return okResponse(request.id, await this.discord.disconnect());
        case 'discord.setEnabled':
          return okResponse(request.id, await this.discord.setEnabled(request.params?.enabled === true));
        case 'discord.presence':
          await this.discord.setPresence(request.params?.track ?? null, request.params?.options);
          return okResponse(request.id, {});

        default:
          return errorResponse(request.id, 'unsupported', `Method ${request.method} is not handled.`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(request.id, 'internal', message);
    }
  }

  private async proxyFetch(req: HttpRequest & { auth?: boolean }): Promise<HttpResponse> {
    const headers = new Headers(req.headers || {});

    const urlObj = new URL(req.url);
    const isStats = urlObj.hostname === 's.youtube.com';
    const isYt = urlObj.hostname.includes('youtube.com');
    const origin = isStats ? 'https://music.youtube.com' : urlObj.origin;

    if (req.auth) {
      headers.delete('authorization');
      headers.delete('cookie');
      headers.delete('x-goog-authuser');
      headers.delete('x-goog-pageid');
      headers.delete('x-origin');
      headers.delete('origin');
      headers.delete('referer');

      const sapisidHash = await this.auth.getSapisidHash(origin);
      if (sapisidHash) {
        headers.set('Authorization', sapisidHash);
      }
      const cookieHeader = await this.auth.getCookieHeader(req.url.startsWith('http') ? req.url : origin);
      if (cookieHeader) {
        headers.set('Cookie', cookieHeader);
      }
      if (isYt) {
        headers.set('Origin', origin);
        headers.set('Referer', `${origin}/`);
        headers.set('X-Origin', origin);
      }
      const identity = this.auth.getActiveIdentity();
      if (identity) {
        headers.set('X-Goog-AuthUser', identity.authUser);
        if (identity.pageId) {
          headers.set('X-Goog-PageId', identity.pageId);
        } else {
          headers.delete('X-Goog-PageId');
        }
      }
    } else {
      if (req.url.includes('amp-api.music.apple.com')) {
        headers.set('Origin', 'https://music.apple.com');
        headers.set('Referer', 'https://music.apple.com/');
      } else if (req.url.includes('musixmatch.com')) {
        headers.set('Cookie', 'mxm_bab=AB');
      }
    }

    const response = await fetch(req.url, {
      method: req.method || 'GET',
      headers,
      body: req.body
        ? req.bodyEncoding === 'base64'
          ? Buffer.from(req.body, 'base64')
          : req.body
        : undefined,
    });

    const isBase64 = req.bodyEncoding === 'base64';
    let body = '';

    if (isBase64) {
      const buffer = await response.arrayBuffer();
      body = Buffer.from(buffer).toString('base64');
    } else {
      body = await response.text();
    }

    try {
      fs.appendFileSync(
        'c:/Users/James/Documents/GitHub/BitChord/electron/bridge-debug.log',
        `[${new Date().toISOString()}] ${req.method} ${req.url} -> ${response.status}\n` +
        `Request Headers: ${JSON.stringify(Object.fromEntries(headers.entries()))}\n` +
        `Request Body: ${req.body ? (typeof req.body === 'string' ? req.body.slice(0, 300) : '[binary]') : 'none'}\n` +
        `Response: ${body.slice(0, 600)}\n\n`
      );
    } catch {}

    const respHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      respHeaders[key] = value;
    });

    return {
      status: response.status,
      headers: respHeaders,
      body,
      bodyEncoding: isBase64 ? 'base64' : 'text',
      url: response.url,
    };
  }
}
