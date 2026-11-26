import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { HealthChatProvider } from "@/components/HealthChatProvider";
import { ProfileProvider } from "@/components/ProfileProvider";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "健康口袋",
  description: "本地优先的个人体检报告管理与趋势看板",
};

const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem('healthpocket-theme-pref')||'auto';var h=new URLSearchParams(location.hash.slice(1)).get('healthpocket-theme');if(h==='dark'||h==='light'){sessionStorage.setItem('healthpocket-host-theme',h);}else{h=sessionStorage.getItem('healthpocket-host-theme');}var s=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';var t=p==='auto'?(h==='dark'||h==='light'?h:s):p;document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <ProfileProvider>
            <HealthChatProvider>
              <AppShell>{children}</AppShell>
            </HealthChatProvider>
          </ProfileProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
