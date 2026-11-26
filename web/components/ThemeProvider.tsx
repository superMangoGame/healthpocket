"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemePreference = "auto" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

const PREF_KEY = "healthpocket-theme-pref";
const HOST_THEME_KEY = "healthpocket-host-theme";

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  hasHostTheme: boolean;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: "auto",
  resolvedTheme: "dark",
  hasHostTheme: false,
  setPreference: () => undefined,
});

function readHashHostTheme(): ResolvedTheme | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.hash.slice(1)).get("healthpocket-theme");
  if (raw === "dark" || raw === "light") {
    try { window.sessionStorage.setItem(HOST_THEME_KEY, raw); } catch { /* ignore */ }
    return raw;
  }
  try {
    const cached = window.sessionStorage.getItem(HOST_THEME_KEY);
    if (cached === "dark" || cached === "light") return cached;
  } catch { /* ignore */ }
  return null;
}

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "auto";
  try {
    const saved = window.localStorage.getItem(PREF_KEY);
    if (saved === "auto" || saved === "dark" || saved === "light") return saved;
  } catch { /* ignore */ }
  return "auto";
}

function readSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("auto");
  const [hostTheme, setHostTheme] = useState<ResolvedTheme | null>(null);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>("dark");

  useEffect(() => {
    setPreferenceState(readStoredPreference());
    setHostTheme(readHashHostTheme());
    setSystemTheme(readSystemTheme());

    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMediaChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };
    mq?.addEventListener?.("change", onMediaChange);

    const onMessage = (event: MessageEvent) => {
      const payload = event.data as { type?: string; theme?: unknown } | null;
      if (payload?.type !== "healthpocket:host-theme") return;
      if (payload.theme === "dark" || payload.theme === "light") {
        setHostTheme(payload.theme);
        try { window.sessionStorage.setItem(HOST_THEME_KEY, payload.theme); } catch { /* ignore */ }
      }
    };
    window.addEventListener("message", onMessage);

    return () => {
      mq?.removeEventListener?.("change", onMediaChange);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  const resolvedTheme: ResolvedTheme =
    preference === "auto" ? (hostTheme ?? systemTheme) : preference;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try { window.localStorage.setItem(PREF_KEY, next); } catch { /* ignore */ }
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolvedTheme, hasHostTheme: hostTheme !== null, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
