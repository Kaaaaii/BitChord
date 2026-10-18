export const BRIDGE_PROTOCOL = 1;
export const BRIDGE_CHANNEL = 'bitchord-bridge';
export const EVENTS_PORT = 'bitchord-events';

export type Capability = 'yt' | 'yt.auth' | 'yt.stats' | 'addon' | 'lyrics' | 'spotify' | 'discord';
export type BrowserFamily = 'chromium' | 'firefox';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  bodyEncoding?: 'text' | 'base64';
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'text' | 'base64';
  url: string;
}

export interface YtChannel {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  brand: boolean;
}

export interface YtAccount {
  authUser: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  channels: YtChannel[];
}

export interface YtAuthState {
  browserSignedIn: boolean;
  connected: boolean;
  signedIn: boolean;
  accounts: YtAccount[];
  active: (YtChannel & { authUser: string }) | null;
  problem: string | null;
}

export interface SpotifyAuthState {
  browserSignedIn: boolean;
  connected: boolean;
  signedIn: boolean;
  user: { name: string; avatarUrl: string | null } | null;
  problem: string | null;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  owner: string | null;
  imageUrl: string | null;
}

export interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number;
  imageUrl: string | null;
}

export interface SpotifyPage<T> {
  items: T[];
  total: number;
  raw: number;
}

export interface DiscordState {
  available: boolean;
  connected: boolean;
  enabled: boolean;
  user: { name: string; username: string; avatarUrl: string | null } | null;
  gateway: 'off' | 'connecting' | 'ready' | 'error';
  problem: string | null;
}

export interface DiscordPresenceOptions {
  activityType: 'listening' | 'playing' | 'watching' | 'competing';
  status: 'online' | 'idle' | 'dnd' | 'invisible';
  useDetails: boolean;
  activityName: string;
  button1Text: string;
  button1Visible: boolean;
  button2Text: string;
  button2Visible: boolean;
}

export interface DiscordNowPlaying {
  videoId: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  positionMs: number;
  durationMs: number;
  playbackRate: number;
}

export type BridgeEvent =
  | { event: 'yt.authState'; data: YtAuthState }
  | { event: 'spotify.authState'; data: SpotifyAuthState }
  | { event: 'discord.state'; data: DiscordState };

export interface BridgeRequest<M = string> {
  channel: typeof BRIDGE_CHANNEL;
  protocol: number;
  direction: 'to-extension';
  id: string;
  method: M;
  params: any;
}

export type BridgeResponse = {
  channel: typeof BRIDGE_CHANNEL;
  protocol: number;
  direction: 'to-page';
  id: string;
} & ({ ok: true; result: any } | { ok: false; error: { code: string; message: string } });

export function okResponse(id: string, result: any): BridgeResponse {
  return { channel: BRIDGE_CHANNEL, protocol: BRIDGE_PROTOCOL, direction: 'to-page', id, ok: true, result };
}

export function errorResponse(id: string, code: string, message: string): BridgeResponse {
  return { channel: BRIDGE_CHANNEL, protocol: BRIDGE_PROTOCOL, direction: 'to-page', id, ok: false, error: { code, message } };
}
