import fs from 'node:fs';
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Tray } from 'electron';
import { GLYPHS, renderGlyph, type MediaAction } from './media.js';

type Poly = Array<[number, number]>;

export interface TrayOptions {
  iconPath: string;
  getMainWindow: () => BrowserWindow | null;
  sendAction: (action: MediaAction) => void;
}

/** System tray (Windows notification area / macOS menu bar / Linux indicator) with playback controls. */
export class TrayManager {
  private tray: Tray | null = null;
  private opts: TrayOptions;
  private isPlaying = false;
  private title = '';

  constructor(opts: TrayOptions) {
    this.opts = opts;
    if (!fs.existsSync(opts.iconPath)) return;
    let image = nativeImage.createFromPath(opts.iconPath);
    if (image.isEmpty()) return;
    image = image.resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
    this.tray = new Tray(image);
    this.tray.on('click', () => this.openWindow());
    nativeTheme.on('updated', () => this.refresh());
    this.refresh();
  }

  public setPlaying(playing: boolean): void {
    this.isPlaying = playing;
    this.refresh();
  }

  public setTitle(title: string): void {
    this.title = title;
    this.refresh();
  }

  public destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private openWindow(): void {
    const win = this.opts.getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  private refresh(): void {
    if (!this.tray) return;
    const label = this.title || 'Nothing playing';
    const shortLabel = label.length > 60 ? `${label.slice(0, 57)}...` : label;
    const rgb: [number, number, number] = nativeTheme.shouldUseDarkColors ? [255, 255, 255] : [32, 32, 32];
    const icon = (polys: Poly[]) => renderGlyph(polys, rgb, 32).resize({ width: 16, height: 16 });
    const mid = this.isPlaying ? GLYPHS.pause : GLYPHS.play;
    this.tray.setToolTip(this.title ? `BitChord - ${shortLabel}` : 'BitChord');
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: shortLabel, enabled: false },
        { type: 'separator' },
        { label: this.isPlaying ? 'Pause' : 'Play', icon: icon(mid), click: () => this.opts.sendAction('toggle') },
        { label: 'Next', icon: icon(GLYPHS.next), click: () => this.opts.sendAction('next') },
        { label: 'Previous', icon: icon(GLYPHS.prev), click: () => this.opts.sendAction('prev') },
        { type: 'separator' },
        { label: 'Open BitChord', click: () => this.openWindow() },
        { label: 'Quit', click: () => app.quit() },
      ]),
    );
  }
}
