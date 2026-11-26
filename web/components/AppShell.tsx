"use client";

import {
  Brain,
  ChartLineUp,
  Desktop,
  FolderOpen,
  Gear,
  Heartbeat,
  House,
  Moon,
  PersonSimple,
  ShieldCheck,
  SidebarSimple,
  Sun,
  Watch,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ProfileSwitcher } from "@/components/ProfileSwitcher";
import { useTheme, type ThemePreference } from "@/components/ThemeProvider";
import { apiFetch } from "@/lib/api";
import type { GarminSettings } from "@/lib/types";

const SIDEBAR_KEY = "healthpocket-sidebar-collapsed";

const primaryItems = [
  { href: "/", label: "健康总览", icon: House },
  { href: "/reports", label: "报告管理", icon: FolderOpen },
  { href: "/trends", label: "指标趋势", icon: ChartLineUp },
  { href: "/body", label: "人体图谱", icon: PersonSimple },
];

const systemItems = [
  { href: "/insights", label: "AI 洞察", icon: Brain },
  { href: "/settings", label: "设置", icon: Gear },
];

const THEME_CYCLE: ThemePreference[] = ["auto", "dark", "light"];
const THEME_META: Record<ThemePreference, { label: string; title: string }> = {
  auto: { label: "跟随", title: "跟随 Obsidian / 系统主题" },
  dark: { label: "深色", title: "深色主题" },
  light: { label: "浅色", title: "浅色主题" },
};

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { preference, setPreference, hasHostTheme } = useTheme();
  const [garminConnected, setGarminConnected] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_KEY) === "1");
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const refresh = () =>
      void apiFetch<GarminSettings>("/garmin/settings")
        .then((value) => setGarminConnected(value.feature_enabled !== false && value.authenticated))
        .catch(() => setGarminConnected(false));
    refresh();
    window.addEventListener("healthpocket:garmin-status", refresh);
    return () => window.removeEventListener("healthpocket:garmin-status", refresh);
  }, []);

  const toggleSidebar = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  const healthNav = garminConnected
    ? [{ href: "/daily", label: "日常健康", icon: Watch }, ...primaryItems]
    : primaryItems;
  const allNav = [...healthNav, ...systemItems];

  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(preference);
    setPreference(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]);
  };

  const renderNavItem = ({ href, label, icon: Icon }: (typeof allNav)[number]) => {
    const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
    return (
      <Link
        key={href}
        href={href}
        title={collapsed ? label : undefined}
        className={`nav-item ${active ? "active" : ""}`}
      >
        <Icon size={19} weight={active ? "fill" : "regular"} />
        <span className="nav-item-label">{label}</span>
      </Link>
    );
  };

  return (
    <div className={`app-shell ${collapsed ? "is-collapsed" : ""}`}>
      <aside className="sidebar" aria-label="侧边导航栏">
        <div className="sidebar-top">
          <Link href="/" className="brand" aria-label="健康口袋首页" title="健康口袋">
            <span className="brand-mark"><Heartbeat size={18} weight="bold" /></span>
            <span className="brand-name">健康口袋</span>
          </Link>
          <button
            type="button"
            className="sidebar-collapse-btn"
            aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
            title={collapsed ? "展开侧边栏" : "折叠侧边栏"}
            onClick={toggleSidebar}
          >
            <SidebarSimple size={17} weight={collapsed ? "fill" : "regular"} />
          </button>
        </div>

        <div className="desktop-profile-switcher">
          <ProfileSwitcher collapsed={collapsed} />
        </div>

        <nav className="nav-list" aria-label="主导航">
          <div className="nav-group">
            <span className="nav-group-label">健康视图</span>
            {healthNav.map(renderNavItem)}
          </div>
          <div className="nav-group">
            <span className="nav-group-label">智能与系统</span>
            {systemItems.map(renderNavItem)}
          </div>
        </nav>

        <div className="sidebar-footer">
          {collapsed ? (
            <button
              type="button"
              className="theme-cycle-btn"
              title={`外观：${THEME_META[preference].title}（点击切换）`}
              aria-label={`切换主题，当前为${THEME_META[preference].label}`}
              onClick={cycleTheme}
            >
              {preference === "dark" ? <Moon size={16} weight="fill" /> : preference === "light" ? <Sun size={16} weight="fill" /> : <Desktop size={16} weight="fill" />}
            </button>
          ) : (
            <>
              <div className="theme-switch" role="group" aria-label="界面主题">
                <button
                  type="button"
                  className={preference === "auto" ? "active" : ""}
                  title={hasHostTheme ? "跟随 Obsidian 主题" : "跟随系统主题"}
                  aria-pressed={preference === "auto"}
                  onClick={() => setPreference("auto")}
                >
                  <Desktop size={14} weight={preference === "auto" ? "fill" : "regular"} />
                  <span>跟随</span>
                </button>
                <button
                  type="button"
                  className={preference === "dark" ? "active" : ""}
                  title="深色主题"
                  aria-pressed={preference === "dark"}
                  onClick={() => setPreference("dark")}
                >
                  <Moon size={14} weight={preference === "dark" ? "fill" : "regular"} />
                  <span>深色</span>
                </button>
                <button
                  type="button"
                  className={preference === "light" ? "active" : ""}
                  title="浅色主题"
                  aria-pressed={preference === "light"}
                  onClick={() => setPreference("light")}
                >
                  <Sun size={14} weight={preference === "light" ? "fill" : "regular"} />
                  <span>浅色</span>
                </button>
              </div>
              <div className="local-note">
                <ShieldCheck size={15} weight="fill" />
                <span>数据仅在本机处理</span>
              </div>
            </>
          )}
        </div>
      </aside>

      <main className="main-content">
        <div className="main-inner">
          <div className="mobile-profile-switcher">
            <ProfileSwitcher compact />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
