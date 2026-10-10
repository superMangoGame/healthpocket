"use client";

import { CombinedAdvice } from "@/components/CombinedAdvice";
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
            结合 {activeProfile?.name || "当前档案"} 的体检报告和 Garmin 数据（如已同步）给出 AI 建议，也可以直接提问或附加新的结构化数据。
          </p>
        </div>
      </header>
      <HealthChat
        profileId={activeProfileId}
        profileName={activeProfile?.name || "当前档案"}
        reportCount={activeProfile?.report_count}
        beforeComposer={<CombinedAdvice profileId={activeProfileId} />}
      />
    </>
  );
}
