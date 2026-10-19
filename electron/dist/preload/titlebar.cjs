"use strict";

// src/preload/titlebar.ts
var import_electron = require("electron");
var isDarwin = process.platform === "darwin";
var css = `
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
    background: transparent;
    user-select: none;
    -webkit-user-select: none;
  }
  .bar {
    display: flex;
    align-items: center;
    height: 100%;
    background: #1f1f1f;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    -webkit-app-region: drag;
    transition: background 0.15s ease, border-color 0.15s ease;
    justify-content: space-between;
    padding-right: 12px;
  }
  @media (prefers-color-scheme: light) {
    body:not([data-theme="dark"]) .bar { background: #ffffff; border-bottom-color: rgba(0, 0, 0, 0.08); }
  }
  body[data-theme="light"] .bar {
    background: #ffffff;
    border-bottom-color: rgba(0, 0, 0, 0.08);
  }
  body[data-theme="dark"] .bar {
    background: #1f1f1f;
    border-bottom-color: rgba(255, 255, 255, 0.08);
  }
  .lights {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding-left: 14px;
    -webkit-app-region: no-drag;
  }
  .actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    -webkit-app-region: no-drag;
  }
  .theme-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 6px;
    background: transparent;
    border: none;
    cursor: pointer;
    color: rgba(255, 255, 255, 0.7);
    padding: 0;
    transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
  }
  .theme-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #ffffff;
  }
  .theme-btn:active {
    transform: scale(0.92);
  }
  body[data-theme="light"] .theme-btn {
    color: rgba(0, 0, 0, 0.65);
  }
  body[data-theme="light"] .theme-btn:hover {
    background: rgba(0, 0, 0, 0.08);
    color: #000000;
  }
  @media (prefers-color-scheme: light) {
    body:not([data-theme="dark"]) .theme-btn {
      color: rgba(0, 0, 0, 0.65);
    }
    body:not([data-theme="dark"]) .theme-btn:hover {
      background: rgba(0, 0, 0, 0.08);
      color: #000000;
    }
  }
  .theme-icon-sun { display: none; }
  .theme-icon-moon { display: block; }
  body[data-theme="light"] .theme-icon-moon { display: none; }
  body[data-theme="light"] .theme-icon-sun { display: block; }
  @media (prefers-color-scheme: light) {
    body:not([data-theme="dark"]) .theme-icon-moon { display: none; }
    body:not([data-theme="dark"]) .theme-icon-sun { display: block; }
  }
  body[data-theme="dark"] .theme-icon-sun { display: none; }
  body[data-theme="dark"] .theme-icon-moon { display: block; }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 12px;
    padding: 0;
    margin: 0;
    border-radius: 50%;
    border: 0.5px solid rgba(0, 0, 0, 0.25);
    cursor: pointer;
    outline: none;
    transition: transform 0.08s ease, background-color 0.15s ease;
  }
  .btn:active { transform: scale(0.92); }
  .close { background: #ff5f56; border-color: rgba(224, 68, 62, 0.6); }
  .minimize { background: #ffbd2e; border-color: rgba(222, 161, 35, 0.6); }
  .maximize { background: #27c93f; border-color: rgba(43, 177, 65, 0.6); }
  .close:active { background: #bf3c36; }
  .minimize:active { background: #be881b; }
  .maximize:active { background: #13881f; }
  body[data-blurred="true"] .btn { background: #4a4a4d; border-color: rgba(0, 0, 0, 0.25); }
  body[data-blurred="true"] .lights:hover .close { background: #ff5f56; }
  body[data-blurred="true"] .lights:hover .minimize { background: #ffbd2e; }
  body[data-blurred="true"] .lights:hover .maximize { background: #27c93f; }
  .icon {
    width: 7px;
    height: 7px;
    opacity: 0;
    transition: opacity 0.12s ease-in-out;
    pointer-events: none;
  }
  .lights:hover .icon { opacity: 1; }
  .icon-restore { display: none; }
  body[data-maximized="true"] .icon-maximize { display: none; }
  body[data-maximized="true"] .icon-restore { display: block; }
`;
var buttons = `
  <div class="lights">
    <button class="btn close" id="close" aria-label="Close" title="Close">
      <svg class="icon" viewBox="0 0 10 10"><path d="M2.2 2.2L7.8 7.8M7.8 2.2L2.2 7.8" stroke="#4d0000" stroke-width="1.3" stroke-linecap="round"/></svg>
    </button>
    <button class="btn minimize" id="minimize" aria-label="Minimize" title="Minimize">
      <svg class="icon" viewBox="0 0 10 10"><path d="M1.8 5H8.2" stroke="#5a3b00" stroke-width="1.3" stroke-linecap="round"/></svg>
    </button>
    <button class="btn maximize" id="maximize" aria-label="Maximize" title="Maximize">
      <svg class="icon icon-maximize" viewBox="0 0 10 10"><path d="M1.5 4.5V1.5H4.5M8.5 5.5V8.5H5.5M2 2L4 4M8 8L6 6" stroke="#004000" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <svg class="icon icon-restore" viewBox="0 0 10 10"><path d="M4.5 1.5V4.5H1.5M5.5 8.5V5.5H8.5M4 4L2 2M6 6L8 8" stroke="#004000" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>
`;
var themeButton = `
  <div class="actions">
    <button class="theme-btn" id="theme-toggle" aria-label="Toggle Theme" title="Toggle theme">
      <!-- Sun icon for light mode (shows when dark mode is active to toggle to light, or vice-versa) -->
      <svg class="theme-icon-sun" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5"></circle>
        <line x1="12" y1="1" x2="12" y2="3"></line>
        <line x1="12" y1="21" x2="12" y2="23"></line>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
        <line x1="1" y1="12" x2="3" y2="12"></line>
        <line x1="21" y1="12" x2="23" y2="12"></line>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
      </svg>
      <!-- Moon icon -->
      <svg class="theme-icon-moon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      </svg>
    </button>
  </div>
`;
var currentThemeSetting = "system";
function isCurrentlyDark() {
  if (currentThemeSetting === "dark") return true;
  if (currentThemeSetting === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
function updateThemeDom(theme) {
  currentThemeSetting = theme;
  if (theme && theme !== "system") {
    document.body.setAttribute("data-theme", theme);
  } else {
    document.body.removeAttribute("data-theme");
  }
}
function setup() {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  const leftHtml = isDarwin ? "<div></div>" : buttons;
  document.body.innerHTML = `<div class="bar" id="bar">${leftHtml}${themeButton}</div>`;
  document.getElementById("close")?.addEventListener("click", () => import_electron.ipcRenderer.send("window:close"));
  document.getElementById("minimize")?.addEventListener("click", () => import_electron.ipcRenderer.send("window:minimize"));
  document.getElementById("maximize")?.addEventListener("click", () => import_electron.ipcRenderer.send("window:maximize"));
  document.getElementById("bar")?.addEventListener("dblclick", (e) => {
    if (e.target.closest(".lights") || e.target.closest(".actions")) return;
    import_electron.ipcRenderer.send("window:maximize");
  });
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const nextTheme = isCurrentlyDark() ? "light" : "dark";
    updateThemeDom(nextTheme);
    import_electron.ipcRenderer.send("theme:set", { theme: nextTheme });
  });
  import_electron.ipcRenderer.invoke("window:isMaximized").then((isMax) => {
    document.body.setAttribute("data-maximized", isMax ? "true" : "false");
  }).catch(() => {
  });
  import_electron.ipcRenderer.on("window:state", (_e, { isMaximized }) => {
    document.body.setAttribute("data-maximized", isMaximized ? "true" : "false");
  });
  import_electron.ipcRenderer.on("window:focus", (_e, { isFocused }) => {
    document.body.setAttribute("data-blurred", isFocused ? "false" : "true");
  });
  import_electron.ipcRenderer.invoke("theme:get").then((theme) => {
    updateThemeDom(theme);
  }).catch(() => {
  });
  import_electron.ipcRenderer.on("theme:change", (_e, { theme }) => {
    updateThemeDom(theme);
  });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setup);
} else {
  setup();
}
//# sourceMappingURL=titlebar.cjs.map