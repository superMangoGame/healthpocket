"use client";

import {
  Brain,
  ChartLineUp,
  Gear,
  Heartbeat,
  House,
  PersonSimple,
  ShieldCheck,
  Watch,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ProfileSwitcher } from "@/components/ProfileSwitcher";
import { apiFetch } from "@/lib/api";
import type { GarminSettings } from "@/lib/types";

const baseItems = [
  { href: "/", label: "健康总览", icon: House },
  { href: "/reports", label: "报告管理", icon: ShieldCheck },
  { href: "/trends", label: "指标趋势", icon: ChartLineUp },
  { href: "/body", label: "人体图谱", icon: PersonSimple },
  { href: "/insights", label: "AI 洞察", icon: Brain },
  { href: "/settings", label: "设置", icon: Gear },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [garminConnected, setGarminConnected] = useState(false);
  useEffect(() => {
    const refresh = () => void apiFetch<GarminSettings>("/garmin/settings").then((value) => setGarminConnected(value.feature_enabled !== false && value.authenticated)).catch(() => setGarminConnected(false));
    refresh();
    window.addEventListener("healthpocket:garmin-status", refresh);
    return () => window.removeEventListener("healthpocket:garmin-status", refresh);
  }, []);
  const items = garminConnected
    ? [{ href: "/daily", label: "日常健康", icon: Watch }, ...baseItems]
    : baseItems;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/" className="brand" aria-label="健康口袋首页">
          <span className="brand-mark"><Heartbeat weight="bold" /></span>
          <span>健康口袋</span>
        </Link>
        <div className="desktop-profile-switcher"><ProfileSwitcher /></div>
        <nav className="nav-list" aria-label="主导航">
          {items.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link key={href} href={href} className={`nav-item ${active ? "active" : ""}`}>
                <Icon size={21} weight={active ? "fill" : "regular"} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="local-note"><ShieldCheck size={18} /> 数据仅在本地处理</div>
      </aside>
      <main className="main-content"><div className="mobile-profile-switcher"><ProfileSwitcher compact /></div>{children}</main>
    </div>
  );
}
