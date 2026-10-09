"use client";

import { HealthChat } from "@/components/HealthChat";
import { useProfiles } from "@/components/ProfileProvider";

export default function InsightsPage() {
  const { activeProfile, activeProfileId } = useProfiles();
  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">AI 洞察</h1>
          <p className="page-subtitle">
            与 AI 一起查看 {activeProfile?.name || "当前档案"} 的体检数据，也可以输入或附加新的结构化数据。
          </p>
        </div>
      </header>
      <HealthChat
        profileId={activeProfileId}
        profileName={activeProfile?.name || "当前档案"}
        reportCount={activeProfile?.report_count}
      />
    </>
  );
}
