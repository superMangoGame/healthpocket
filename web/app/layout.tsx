import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { HealthChatProvider } from "@/components/HealthChatProvider";
import { ProfileProvider } from "@/components/ProfileProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "健康口袋",
  description: "本地优先的个人体检报告管理与趋势看板",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <ProfileProvider><HealthChatProvider><AppShell>{children}</AppShell></HealthChatProvider></ProfileProvider>
      </body>
    </html>
  );
}
