import { create } from 'zustand';

export type SidePanel = 'up-next' | 'lyrics' | null;
export type ThemeMode = 'system' | 'dark' | 'light';

interface UiState {
  /** The right-hand glass panel (report §7); one of Up Next or Lyrics at a time. */
  sidePanel: SidePanel;
  toggleSidePanel: (panel: Exclude<SidePanel, null>) => void;
  closeSidePanel: () => void;
  /** The full-screen player: artwork, controls and lyrics over the artwork's mesh (report §7). */
  fullScreen: boolean;
  setFullScreen: (open: boolean) => void;
  /** The sidebar as a drawer, below 484px where it's otherwise hidden. */
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  /** The extension install banner, dismissed for this tab only. */
  installBannerDismissed: boolean;
  dismissInstallBanner: () => void;
  /** Appearance theme: system, dark, or light */
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
}

const BANNER_KEY = 'bitchord:install-banner-dismissed';
const THEME_KEY = 'bitchord:theme';

function getInitialTheme(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light' || saved === 'system') return saved;
  return 'system';
}

export function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  // Notify electron host if running in electron desktop shell
  if (typeof (window as any).bitchordDesktop?.setTheme === 'function') {
    (window as any).bitchordDesktop.setTheme(theme);
  }
}

const initialTheme = getInitialTheme();
if (typeof document !== 'undefined') {
  applyTheme(initialTheme);
}

export const useUi = create<UiState>()((set) => ({
  sidePanel: null,
  toggleSidePanel: (panel) => set((s) => ({ sidePanel: s.sidePanel === panel ? null : panel })),
  closeSidePanel: () => set({ sidePanel: null }),
  fullScreen: false,
  setFullScreen: (fullScreen) => set({ fullScreen }),
  drawerOpen: false,
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  installBannerDismissed: sessionStorage.getItem(BANNER_KEY) === '1',
  dismissInstallBanner: () => {
    sessionStorage.setItem(BANNER_KEY, '1');
    set({ installBannerDismissed: true });
  },
  theme: initialTheme,
  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
}));

// For browser-driven tests, next to __bcPlayer.
if (import.meta.env.DEV) Object.assign(window, { __bcUi: useUi });
