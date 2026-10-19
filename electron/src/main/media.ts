import zlib from 'node:zlib';
import { BrowserWindow, globalShortcut, nativeImage, nativeTheme, type NativeImage, type WebContents } from 'electron';

export type MediaAction = 'toggle' | 'next' | 'prev' | 'play' | 'pause';

// ---- Taskbar thumbnail icons ----------------------------------------------
// nativeImage can't read SVG, so the glyphs are rasterised to PNG here.
// Shapes are in a 24x24 box (Material icon geometry).

type Poly = Array<[number, number]>;
const rect = (x1: number, y1: number, x2: number, y2: number): Poly => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];

export const GLYPHS: Record<'prev' | 'play' | 'pause' | 'next', Poly[]> = {
  prev: [rect(6, 6, 8, 18), [[9.5, 12], [18, 6], [18, 18]]],
  play: [[[8, 5], [8, 19], [19, 12]]],
  pause: [rect(6, 5, 10, 19), rect(14, 5, 18, 19)],
  next: [[[6, 6], [14.5, 12], [6, 18]], rect(16, 6, 18, 18)],
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function pointInPoly(poly: Poly, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as [number, number];
    const [xj, yj] = poly[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A size x size anti-aliased glyph in one colour on a transparent background. */
export function renderGlyph(polys: Poly[], rgb: [number, number, number], size = 32): NativeImage {
  const SUPERSAMPLE = 4;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = ((x + (sx + 0.5) / SUPERSAMPLE) * 24) / size;
          const py = ((y + (sy + 0.5) / SUPERSAMPLE) * 24) / size;
          if (polys.some((p) => pointInPoly(p, px, py))) hits++;
        }
      }
      const o = y * stride + 1 + x * 4;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
      raw[o + 3] = Math.round((255 * hits) / (SUPERSAMPLE * SUPERSAMPLE));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return nativeImage.createFromBuffer(png);
}

export class MediaControlsManager {
  private getMainWindow: () => BrowserWindow | null;
  private getPageContents: () => WebContents | null;
  private isPlaying = false;
  public onPlaybackChange: ((playing: boolean) => void) | null = null;

  constructor(getMainWindow: () => BrowserWindow | null, getPageContents: () => WebContents | null) {
    this.getMainWindow = getMainWindow;
    this.getPageContents = getPageContents;
    this.registerGlobalShortcuts();
    // The taskbar background follows the system theme, so the glyph colour has to as well.
    nativeTheme.on('updated', () => this.updateThumbarButtons());
  }

  public sendAction(action: MediaAction): void {
    const contents = this.getPageContents();
    if (!contents || contents.isDestroyed()) return;
    contents.send('media:action', action);
  }

  public registerGlobalShortcuts(): void {
    // Note: OS dedicated hardware media keys (Play/Pause, Next, Previous) are handled
    // cooperatively by Chromium's HardwareMediaKeyHandling and mapped directly to
    // navigator.mediaSession (Windows SMTC / Linux MPRIS / macOS Now Playing).
    // Registering them with globalShortcut would use OS RegisterHotKey, which aggressively
    // suppresses the OS media popup/overlay.
    // We only register custom fallback hotkeys for keyboards without dedicated media keys:
    try {
      globalShortcut.register('CommandOrControl+Alt+Space', () => this.sendAction('toggle'));
      globalShortcut.register('CommandOrControl+Alt+Right', () => this.sendAction('next'));
      globalShortcut.register('CommandOrControl+Alt+Left', () => this.sendAction('prev'));
    } catch (err) {
      console.warn('Failed to register some global media shortcuts:', err);
    }
  }

  public unregisterAll(): void {
    globalShortcut.unregisterAll();
  }

  public setPlaybackState(playing: boolean): void {
    this.isPlaying = playing;
    this.updateThumbarButtons();
    this.onPlaybackChange?.(playing);
  }

  /**
   * Sets up taskbar thumbnail toolbar buttons on Windows
   */
  public updateThumbarButtons(): void {
    if (process.platform !== 'win32') return;
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) return;

    try {
      // White on a dark taskbar, near-black on a light one.
      const rgb: [number, number, number] = nativeTheme.shouldUseDarkColors ? [255, 255, 255] : [32, 32, 32];

      const prevIcon = renderGlyph(GLYPHS.prev, rgb);
      const playPauseIcon = renderGlyph(this.isPlaying ? GLYPHS.pause : GLYPHS.play, rgb);
      const nextIcon = renderGlyph(GLYPHS.next, rgb);

      win.setThumbarButtons([
        {
          tooltip: 'Previous track',
          icon: prevIcon,
          click: () => this.sendAction('prev'),
        },
        {
          tooltip: this.isPlaying ? 'Pause' : 'Play',
          icon: playPauseIcon,
          click: () => this.sendAction('toggle'),
        },
        {
          tooltip: 'Next track',
          icon: nextIcon,
          click: () => this.sendAction('next'),
        },
      ]);
    } catch {
      // Thumbar buttons might fail if window handle is not ready yet
    }
  }
}
