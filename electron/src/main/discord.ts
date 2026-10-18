import { Client } from '@xhayper/discord-rpc';
import type { DiscordNowPlaying, DiscordPresenceOptions, DiscordState } from '../common/types.js';

export const APPLICATION_ID = '1543679166967193620';
const DEFAULT_BUTTON_1 = 'Listen on YouTube Music';
const DEFAULT_BUTTON_2 = 'Visit BitChord';
const APP_URL = 'https://bitchord-8bw.pages.dev';

const ACTIVITY_TYPES: Record<string, number> = {
  playing: 0,
  streaming: 1,
  listening: 2,
  watching: 3,
  competing: 5,
};

export class DiscordRpcManager {
  private client: Client | null = null;
  private isConnected = false;
  private isConnecting = false;
  private enabled = true;
  private problem: string | null = null;
  private stateListeners: Set<(state: DiscordState) => void> = new Set();
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Attempt non-blocking auto-connect on startup
    this.connect().catch(() => {});
  }

  public subscribeState(listener: (state: DiscordState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  private broadcastState(): void {
    const state = this.getState();
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('Error notifying Discord state listener:', err);
      }
    }
  }

  public getState(): DiscordState {
    const user = this.client?.user;
    return {
      available: true,
      connected: this.isConnected,
      enabled: this.enabled,
      user: user
        ? {
            name: (user as any).global_name || (user as any).globalName || user.username,
            username: user.username,
            avatarUrl: user.avatar
              ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
              : null,
          }
        : null,
      gateway: this.isConnected ? 'ready' : this.isConnecting ? 'connecting' : 'off',
      problem: this.problem,
    };
  }

  public async connect(): Promise<void> {
    if (this.isConnected || this.isConnecting) return;
    this.isConnecting = true;
    this.problem = null;
    this.broadcastState();

    try {
      if (this.client) {
        try {
          await this.client.destroy();
        } catch {}
      }

      this.client = new Client({ clientId: APPLICATION_ID });

      this.client.on('ready', () => {
        this.isConnected = true;
        this.isConnecting = false;
        this.problem = null;
        this.broadcastState();
      });

      this.client.on('disconnected', () => {
        this.isConnected = false;
        this.isConnecting = false;
        this.broadcastState();
        this.scheduleReconnect();
      });

      await this.client.login().catch((err: unknown) => {
        this.isConnected = false;
        this.isConnecting = false;
        this.problem = err instanceof Error ? err.message : String(err);
        this.broadcastState();
        this.scheduleReconnect();
      });
    } catch (err: unknown) {
      this.isConnected = false;
      this.isConnecting = false;
      this.problem = err instanceof Error ? err.message : String(err);
      this.broadcastState();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.enabled && !this.isConnected) {
        this.connect().catch(() => {});
      }
    }, 15000);
  }

  public async disconnect(): Promise<DiscordState> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        await this.client.destroy();
      } catch {}
      this.client = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.problem = null;
    this.broadcastState();
    return this.getState();
  }

  public async setEnabled(enabled: boolean): Promise<DiscordState> {
    this.enabled = enabled;
    if (!enabled) {
      if (this.client && this.isConnected) {
        try {
          await this.client.user?.clearActivity();
        } catch {}
      }
    } else if (!this.isConnected) {
      this.connect().catch(() => {});
    }
    this.broadcastState();
    return this.getState();
  }


  public async setPresence(track: DiscordNowPlaying | null, options?: DiscordPresenceOptions): Promise<void> {
    if (!this.enabled || !this.isConnected || !this.client?.user) return;

    if (!track) {
      try {
        await this.client.user.clearActivity();
      } catch (err) {
        console.warn('Failed to clear Discord activity:', err);
      }
      return;
    }

    try {
      const playbackRate = track.playbackRate || 1;
      const startTimestamp = Math.floor(Date.now() - (track.positionMs / playbackRate));
      const endTimestamp = startTimestamp + Math.floor(track.durationMs / playbackRate);

      const buttons: Array<{ label: string; url: string }> = [];

      const resolveVars = (text: string): string => {
        return text
          .replaceAll('{song_name}', track.title)
          .replaceAll('{artist_name}', track.artist)
          .replaceAll('{album_name}', track.album ?? '');
      };

      if (options?.button1Visible ?? true) {
        const url = track.videoId
          ? `https://music.youtube.com/watch?v=${track.videoId}`
          : APP_URL;
        buttons.push({
          label: resolveVars(options?.button1Text || DEFAULT_BUTTON_1).slice(0, 32),
          url,
        });
      }

      if (options?.button2Visible ?? true) {
        buttons.push({
          label: resolveVars(options?.button2Text || DEFAULT_BUTTON_2).slice(0, 32),
          url: APP_URL,
        });
      }

      const activityType = options?.activityType ? (ACTIVITY_TYPES[options.activityType] ?? 2) : 2;
      const activityName = options?.activityName?.trim() || 'BitChord';
      const details = playbackRate !== 1 ? `${track.title} [${playbackRate.toFixed(2)}x]` : track.title;
      const state = track.artist + (track.album ? ` • ${track.album}` : '');

      await this.client.user.setActivity({
        name: activityName,
        type: activityType,
        details: details.slice(0, 128),
        state: state.slice(0, 128),
        statusDisplayType: options?.useDetails ? 2 : 1,
        startTimestamp: new Date(startTimestamp),
        endTimestamp: new Date(endTimestamp),
        largeImageKey: track.artworkUrl || 'bitchord_logo',
        largeImageText: (track.album || track.title).slice(0, 128),
        smallImageKey: 'bitchord_logo',
        smallImageText: 'BitChord',
        buttons: buttons.slice(0, 2),
      });
    } catch (err) {
      console.warn('Failed to update Discord presence:', err);
    }
  }
}
