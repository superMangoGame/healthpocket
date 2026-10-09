"use client";

import { ArrowCounterClockwise, CaretDown, CursorClick, Stack } from "@phosphor-icons/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { apiFetch, withProfile } from "@/lib/api";
import {
  ATLAS_SYSTEM_ORDER,
  ATLAS_SYSTEMS,
  DEFAULT_ATLAS_SYSTEMS,
  ORGAN_LABELS,
  ORGAN_PRESET_SYSTEMS,
  type AtlasSystemId,
} from "@/lib/human-atlas";
import { DISPLAY_ORGANS } from "@/lib/anatomy";
import type { HealthStatus, OrganTimeline } from "@/lib/types";
import { useProfiles } from "@/components/ProfileProvider";

const AnatomyScene = dynamic(() => import("@/components/AnatomyScene").then((mod) => mod.AnatomyScene), { ssr: false, loading: () => <div className="skeleton" style={{ height: "100%" }} /> });

type AnatomySex = "female" | "male";

const toOption = (item: (typeof DISPLAY_ORGANS)[number]) => [item.id, item.label] as const;
const commonOrganOptions = DISPLAY_ORGANS.filter((item) => !item.sex).map(toOption);
const femaleOrganOptions = DISPLAY_ORGANS.filter((item) => item.sex === "female").map(toOption);
const maleOrganOptions = DISPLAY_ORGANS.filter((item) => item.sex === "male").map(toOption);
const femaleOrganIds = femaleOrganOptions.map(([id]) => id);

const allOrganOptions = DISPLAY_ORGANS.map(toOption);

const layerPresets: Array<{ id: string; label: string; systems: AtlasSystemId[] }> = [
  { id: "all", label: "全部", systems: ATLAS_SYSTEM_ORDER },
  { id: "skeletal", label: "骨骼", systems: ["skeletal"] },
  { id: "muscular", label: "肌肉", systems: ["muscular"] },
  { id: "organs", label: "内脏", systems: ORGAN_PRESET_SYSTEMS },
];

function riskCount(timeline: OrganTimeline | undefined): number {
  return timeline?.years.reduce((sum, item) => sum + item.abnormal_count + item.attention_count, 0) || 0;
}

function inferredAnatomySex(timelines: Record<string, OrganTimeline>): AnatomySex | null {
  const maleRiskCount = riskCount(timelines.prostate);
  const femaleRiskCount = femaleOrganIds.reduce(
    (sum, organ) => sum + riskCount(timelines[organ]),
    0,
  );
  if (maleRiskCount > 0 && femaleRiskCount === 0) return "male";
  if (femaleRiskCount > 0 && maleRiskCount === 0) return "female";
  return null;
}

const organGlyphs: Record<string, string> = {
  head: "头", eyes: "眼", ent: "耳", oral: "口", neck: "颈", lungs: "胸", heart: "心", spine: "椎",
  thyroid: "甲", liver: "肝", gallbladder: "胆", stomach: "胃", pancreas: "胰", spleen: "脾",
  kidney: "肾", bladder: "膀", breast: "乳", uterus: "宫", ovary: "卵", prostate: "前", blood: "血", metabolic: "般", other: "他",
};

const organTitles = ORGAN_LABELS;

const statusLabels: Record<HealthStatus, string> = {
  normal: "正常", attention: "关注", abnormal: "异常", insufficient: "数据不足",
};

const statusDescriptions: Record<HealthStatus, string> = {
  normal: "本年度可信关联检查未见明确异常标记。",
  attention: "本年度部分关联项目被报告标记为需要关注。",
  abnormal: "本年度报告中存在明确异常标记，请查看对应原文。",
  insufficient: "本年度没有足够的可信检查数据，不沿用其他年份状态。",
};

const fallbackColors: Record<HealthStatus, string> = {
  normal: "#4a7d5d", attention: "#a8742a", abnormal: "#b04a3b", insufficient: "#b2aa9c",
};

function AnatomyBackdrop({ selected, statuses, anatomySex }: { selected: string; statuses: Record<string, HealthStatus>; anatomySex: AnatomySex }) {
  const fill = (id: string) => fallbackColors[statuses[id] || "insufficient"];
  const stroke = (id: string) => selected === id ? "#22201c" : "#fffefb";
  return <div className="anatomy-backdrop" aria-hidden="true">
    <svg viewBox="0 0 360 620" role="presentation">
      <path className="body-outline" d="M180 30c-31 0-53 24-53 55 0 24 13 43 31 51l-7 29-58 34c-15 9-21 25-16 40l23 70 13-5-8-73 49-19-9 116-22 180 28 3 29-150 29 150 28-3-22-180-9-116 49 19-8 73 13 5 23-70c5-15-1-31-16-40l-58-34-7-29c18-8 31-27 31-51 0-31-22-55-53-55Z" />
      <g className="organ-shapes">
        <path fill={fill("head")} stroke={stroke("head")} d="M158 55c0-18 10-29 22-29s22 11 22 29c0 24-8 43-22 43s-22-19-22-43Z" />
        <path fill={fill("eyes")} stroke={stroke("eyes")} d="M165 56c5-4 10-4 14 0-4 5-10 5-14 0Zm16 0c5-4 10-4 14 0-4 5-10 5-14 0Z" />
        <path fill={fill("ent")} stroke={stroke("ent")} d="M176 62h8l3 13-7 3-7-3Z" />
        <path fill={fill("oral")} stroke={stroke("oral")} d="M169 84c7 4 15 4 22 0-3 10-19 10-22 0Z" />
        <path fill={fill("neck")} stroke={stroke("neck")} d="M162 116h36l-5 30h-26Z" />
        <path fill={fill("spine")} stroke={stroke("spine")} d="M174 159h12l4 252-10 24-10-24Z" />
        <path fill={fill("thyroid")} stroke={stroke("thyroid")} d="M164 146c7-7 13-4 16 4 3-8 9-11 16-4l-4 18-12-7-12 7Z" />
        <path fill={fill("lungs")} stroke={stroke("lungs")} d="M173 184c-19-21-42-5-42 31 0 33 17 55 42 36Zm14 0c19-21 42-5 42 31 0 33-17 55-42 36Z" />
        <path fill={fill("heart")} stroke={stroke("heart")} d="M181 223c-11-17-32-6-29 11 3 17 29 32 29 32s26-15 29-32c3-17-18-28-29-11Z" />
        {anatomySex === "female" && <path fill={fill("breast")} stroke={stroke("breast")} d="M142 226c-12-5-23 4-22 17 1 12 13 20 27 13 11-6 9-24-5-30Zm76 0c12-5 23 4 22 17-1 12-13 20-27 13-11-6-9-24 5-30Z" />}
        <path fill={fill("liver")} stroke={stroke("liver")} d="M142 272c31-14 80-10 96 4-5 26-18 38-48 34-29 7-48-6-48-38Z" />
        <path fill={fill("gallbladder")} stroke={stroke("gallbladder")} d="M197 296c10 3 13 17 5 27-10-4-13-18-5-27Z" />
        <path fill={fill("stomach")} stroke={stroke("stomach")} d="M199 311c26 3 28 35 9 51-13 11-35 5-34-13 17 3 26-13 25-38Z" />
        <path fill={fill("spleen")} stroke={stroke("spleen")} d="M226 315c13 8 15 29 4 38-12-7-17-24-4-38Z" />
        <path fill={fill("pancreas")} stroke={stroke("pancreas")} d="M145 361c24-10 57-8 77 5-21 13-56 16-77-5Z" />
        <path fill={fill("kidney")} stroke={stroke("kidney")} d="M144 378c-19 0-25 32-8 44 13-4 20-25 8-44Zm72 0c19 0 25 32 8 44-13-4-20-25-8-44Z" />
        <path fill={fill("bladder")} stroke={stroke("bladder")} d="M166 440c8-8 20-8 28 0 8 12 2 29-14 33-16-4-22-21-14-33Z" />
        {anatomySex === "female" ? <>
          <path fill={fill("uterus")} stroke={stroke("uterus")} d="M165 472c9-9 21-9 30 0l-5 24-10 8-10-8Z" />
          <path fill={fill("ovary")} stroke={stroke("ovary")} d="M151 470c-11-3-17 8-9 16 9 4 18-7 9-16Zm58 0c11-3 17 8 9 16-9 4-18-7-9-16Z" />
        </> : <path fill={fill("prostate")} stroke={stroke("prostate")} d="M164 474c10-8 22-8 32 0-3 19-29 19-32 0Z" />}
      </g>
    </svg>
  </div>;
}

export default function BodyPage() {
  const { activeProfile, activeProfileId } = useProfiles();
  const [anatomySex, setAnatomySex] = useState<AnatomySex>("female");
  const [selected, setSelected] = useState("liver");
  const [visibleSystems, setVisibleSystems] = useState<AtlasSystemId[]>(() => [...DEFAULT_ATLAS_SYSTEMS]);
  const [explodeProgress, setExplodeProgress] = useState(0);
  const [layerPanelOpen, setLayerPanelOpen] = useState(true);
  const [timelines, setTimelines] = useState<Record<string, OrganTimeline>>({});
  const [year, setYear] = useState<number | null>(null);
  const [webgl, setWebgl] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const timelineRef = useRef<HTMLDivElement>(null);
  const organOptions = useMemo(() => anatomySex === "female" ? [...commonOrganOptions, ...femaleOrganOptions] : [...commonOrganOptions, ...maleOrganOptions], [anatomySex]);
  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches) setLayerPanelOpen(false);
  }, []);
  useEffect(() => {
    if (!activeProfileId) return;
    const request = ++requestVersion.current;
    setTimelines({});
    setYear(null);
    setError("");
    try { const canvas = document.createElement("canvas"); setWebgl(Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"))); } catch { setWebgl(false); }
    Promise.all(allOrganOptions.map(async ([id]) => [id, await apiFetch<OrganTimeline>(withProfile(`/organs/${id}/timeline`, activeProfileId))] as const))
      .then((entries) => {
        if (request !== requestVersion.current) return;
        const map = Object.fromEntries(entries);
        setTimelines(map);
        const inferredSex = inferredAnatomySex(map);
        if (inferredSex) setAnatomySex(inferredSex);
        const allYears = entries.flatMap(([, timeline]) => timeline.years.map((item) => item.year));
        setYear(allYears.length ? Math.max(...allYears) : new Date().getFullYear());
      }).catch((reason) => { if (request === requestVersion.current) setError(reason.message); });
  }, [activeProfileId]);
  const changeAnatomySex = (next: AnatomySex) => {
    setAnatomySex(next);
    if (next === "female" && selected === "prostate") setSelected("breast");
    if (next === "male" && femaleOrganIds.includes(selected)) setSelected("prostate");
  };
  const toggleSystem = (system: AtlasSystemId) => {
    setVisibleSystems((current) => {
      const next = new Set(current);
      if (next.has(system)) next.delete(system);
      else next.add(system);
      return ATLAS_SYSTEM_ORDER.filter((item) => next.has(item));
    });
  };
  const applyLayerPreset = (systems: AtlasSystemId[]) => setVisibleSystems([...systems]);
  const presetIsActive = (systems: AtlasSystemId[]) =>
    systems.length === visibleSystems.length && systems.every((system) => visibleSystems.includes(system));
  const timeline = timelines[selected];
  const current = timeline?.years.find((item) => item.year === year);
  const statuses = useMemo(() => Object.fromEntries(organOptions.map(([id]) => [id, timelines[id]?.years.find((item) => item.year === year)?.status || "insufficient"])), [organOptions, timelines, year]) as Record<string, HealthStatus>;
  const abnormalOrganCount = organOptions.filter(
    ([id]) => id !== "blood" && id !== "metabolic" && statuses[id] === "abnormal",
  ).length;
  const allYears = useMemo(() => [...new Set(Object.values(timelines).flatMap((item) => item.years.map((entry) => entry.year)))].sort(), [timelines]);
  useEffect(() => {
    const track = timelineRef.current;
    const active = track?.querySelector<HTMLElement>(".organ-year.active");
    if (!track || !active) return;
    const centeredLeft = active.offsetLeft - (track.clientWidth - active.offsetWidth) / 2;
    track.scrollTo({ left: Math.max(0, centeredLeft), behavior: "smooth" });
  }, [selected, timeline, year]);

  return (
    <>
      <header className="page-header">
        <div><h1 className="page-title">人体健康图谱</h1><p className="page-subtitle">查看 {activeProfile?.name || "当前档案"} 的器官年度状态。3D 底图来自 Human Atlas / BodyParts3D，模型仅用于报告导航。</p></div>
        <div className="anatomy-toolbar">
          <div className="segmented-control" aria-label="选择性别相关器官标记" title="Human Atlas 底图为成年男性参考模型；女性模式会补充女性特异器官导航标记">
            <button className={anatomySex === "female" ? "active" : ""} aria-pressed={anatomySex === "female"} onClick={() => changeAnatomySex("female")}>女性标记</button>
            <button className={anatomySex === "male" ? "active" : ""} aria-pressed={anatomySex === "male"} onClick={() => changeAnatomySex("male")}>男性标记</button>
          </div>
          <select className="select mono" aria-label="选择年份" value={year || ""} onChange={(event) => setYear(Number(event.target.value))}>{allYears.map((item) => <option key={item}>{item}</option>)}</select>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      <section className="body-grid">
        <div className="panel anatomy-canvas">
          <div className="canvas-hint"><CursorClick size={17} /> 拆解后悬停查看独立中文结构名 <span className="map-key tone-abnormal">● {year} 年异常器官 {abnormalOrganCount} 个</span><span className="map-key tone-attention">● 关注高亮</span></div>
          <button className="canvas-reset" onClick={() => { setExplodeProgress(0); setResetKey((value) => value + 1); }}><ArrowCounterClockwise /> 重置视角</button>
          <div className={`atlas-layer-control ${layerPanelOpen ? "open" : ""}`}>
            <button
              type="button"
              className="atlas-layer-trigger"
              aria-expanded={layerPanelOpen}
              aria-controls="atlas-layer-options"
              onClick={() => setLayerPanelOpen((value) => !value)}
            >
              <Stack size={16} />
              <span>解剖图层</span>
              <small>{visibleSystems.length}/{ATLAS_SYSTEM_ORDER.length}</small>
              <CaretDown className="atlas-layer-caret" size={14} />
            </button>
            {layerPanelOpen && (
              <div id="atlas-layer-options" className="atlas-layer-body">
                <div className="atlas-layer-presets" aria-label="图层预设">
                  {layerPresets.map((preset) => (
                    <button
                      type="button"
                      key={preset.id}
                      className={presetIsActive(preset.systems) ? "active" : ""}
                      aria-pressed={presetIsActive(preset.systems)}
                      onClick={() => applyLayerPreset(preset.systems)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <div className="atlas-system-list" aria-label="人体系统图层">
                  {ATLAS_SYSTEM_ORDER.map((system) => {
                    const enabled = visibleSystems.includes(system);
                    const spec = ATLAS_SYSTEMS[system];
                    return (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        className={`atlas-system-row ${enabled ? "enabled" : ""}`}
                        key={system}
                        onClick={() => toggleSystem(system)}
                      >
                        <i style={{ backgroundColor: spec.color }} aria-hidden="true" />
                        <span>{spec.label}</span>
                        <b aria-hidden="true"><span /></b>
                      </button>
                    );
                  })}
                </div>
                <button type="button" className="atlas-hide-all" onClick={() => setVisibleSystems([])}>隐藏全部图层</button>
              </div>
            )}
          </div>
          {webgl
            ? <AnatomyScene selected={selected} statuses={statuses} onSelect={setSelected} resetKey={resetKey} anatomySex={anatomySex} visibleSystems={visibleSystems} explode={explodeProgress / 100} />
            : <><AnatomyBackdrop selected={selected} statuses={statuses} anatomySex={anatomySex} /><div className="webgl-fallback-note">浏览器未启用 WebGL，可通过器官导航查看数据。</div></>}
          <div className="atlas-explode-control">
            <div className="atlas-explode-head">
              <label htmlFor="atlas-explode-range">拆解分割</label>
              <output htmlFor="atlas-explode-range" className="mono">{explodeProgress}%</output>
            </div>
            <input
              id="atlas-explode-range"
              type="range"
              min="0"
              max="100"
              step="1"
              value={explodeProgress}
              aria-label="人体模型拆解分割进度"
              aria-valuetext={`${explodeProgress}%`}
              onChange={(event) => setExplodeProgress(Number(event.target.value))}
            />
            <div className="atlas-explode-scale" aria-hidden="true"><span>完整人体</span><span>系统分层</span><span>结构展开</span></div>
          </div>
        </div>
        <nav className="panel organ-nav" aria-label="器官导航">
          <strong className="organ-nav-title">器官导航</strong>
          <div className="organ-nav-track">
            {organOptions.map(([id, label]) => (
              <button key={id} className={`${selected === id ? "active " : ""}tone-${statuses[id] || "insufficient"}`} aria-pressed={selected === id} onClick={() => setSelected(id)}>
                <span className="organ-nav-glyph" aria-hidden="true">{organGlyphs[id]}</span>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </nav>
        <aside className="panel organ-detail">
          <div className="organ-title"><h2>{organTitles[selected] || timeline?.label || organOptions.find(([id]) => id === selected)?.[1]}</h2><span className="organ-year-label mono">{year}</span></div>
          <div className={`organ-status-summary tone-${current?.status || "insufficient"}`}>
            <div className="organ-status-line"><span className="organ-status-dot" aria-hidden="true" /><strong>{statusLabels[current?.status || "insufficient"]}</strong>{current && <span className="organ-status-count mono">异常 {current.abnormal_count} · 关注 {current.attention_count}</span>}</div>
            <p>{statusDescriptions[current?.status || "insufficient"]}</p>
          </div>
          <section className="organ-history">
            <div className="section-head"><h3>历年变化</h3><span className="muted">点击年份切换</span></div>
            <div ref={timelineRef} className="organ-timeline" role="list" aria-label={`${organTitles[selected] || timeline?.label || "器官"}历年状态`}>
              {timeline?.years.map((item) => (
                <button key={item.year} role="listitem" aria-label={`${item.year}年，${statusLabels[item.status]}`} aria-pressed={year === item.year} className={`organ-year tone-${item.status} ${year === item.year ? "active" : ""}`} onClick={() => setYear(item.year)}>
                  <span className="organ-year-marker" aria-hidden="true"><span className="organ-year-node mono">{item.abnormal_count + item.attention_count}</span></span>
                  <strong className="mono organ-year-value">{item.year}</strong>
                  <span className="organ-year-status">异常 {item.abnormal_count} · 关注 {item.attention_count}</span>
                </button>
              ))}
            </div>
          </section>
          <section><div className="section-head"><h3>异常与关注明细</h3><span className="muted">{current?.evidence.length || 0} 项风险</span></div>
            {!current?.evidence.length ? <div className="empty-state" style={{ minHeight: 280 }}><p>这一年没有可信的异常或关注项，不沿用其他年份状态。</p></div> : current.evidence.map((item, index) => (
              <div className="evidence-row" key={`${item.title}-${index}`}>
                <div><strong>{item.title}</strong>{item.anatomy_label && <span className="evidence-anatomy">{item.anatomy_label}</span>}{item.kind === "finding" && <div className="muted" style={{ marginTop: 4, lineHeight: 1.45 }}>{item.value}</div>}</div>
                <div className="evidence-status"><div className="mono">{item.value || "—"}</div><StatusBadge status={item.status} compact /><small>{item.status_reason}</small></div>
                <div><div className="muted mono" style={{ marginBottom: 4 }}>{item.reference || "报告结论"}</div><Link className="link" href={`/reports/detail?id=${item.report_id}`}>第 {item.page} 页</Link></div>
              </div>
            ))}
          </section>
        </aside>
      </section>
    </>
  );
}
