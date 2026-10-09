import type { HealthStatus } from "@/lib/types";
import { DISPLAY_ORGAN_LABELS, organConceptIds } from "@/lib/anatomy";

export type AtlasSystemId =
  | "skeletal"
  | "muscular"
  | "arterial"
  | "venous"
  | "nervous"
  | "digestive"
  | "respiratory"
  | "urinary"
  | "reproductive"
  | "lymphatic"
  | "endocrine"
  | "integumentary"
  | "connective"
  | "sensory"
  | "cardiac";

export interface AtlasPart {
  id: string;
  name: string;
  nameZh?: string;
  conceptId: string;
  system: AtlasSystemId;
  chunk: number;
  positions: number;
  normals: number;
  indices: number;
  vertexCount: number;
  indexCount: number;
  bounds: [[number, number, number], [number, number, number]];
}

export interface AtlasConcept {
  id: string;
  name: string;
  elements: string[];
}

export interface AtlasChunk {
  url: string;
  bytes: number;
  gzip?: string;
  gzipBytes?: number;
}

export interface HumanAtlas {
  version: string;
  sex?: "male";
  source?: string;
  scope?: string;
  parts: AtlasPart[];
  concepts: AtlasConcept[];
  chunks: AtlasChunk[];
  triangles: number;
}

export const ATLAS_SYSTEMS: Record<AtlasSystemId, { label: string; color: string; opacity: number }> = {
  skeletal: { label: "骨骼系统", color: "#ded6bd", opacity: 1 },
  muscular: { label: "肌肉系统", color: "#a85b50", opacity: 0.86 },
  cardiac: { label: "心脏", color: "#a54e4b", opacity: 1 },
  sensory: { label: "感觉器官", color: "#adc6cc", opacity: 0.9 },
  arterial: { label: "动脉", color: "#c05245", opacity: 0.72 },
  venous: { label: "静脉", color: "#527c9f", opacity: 0.62 },
  nervous: { label: "神经系统", color: "#d8b565", opacity: 0.82 },
  respiratory: { label: "呼吸系统", color: "#b98991", opacity: 0.9 },
  digestive: { label: "消化系统", color: "#b8916b", opacity: 0.94 },
  urinary: { label: "泌尿系统", color: "#a96555", opacity: 0.95 },
  lymphatic: { label: "淋巴系统", color: "#879f7c", opacity: 0.78 },
  endocrine: { label: "内分泌系统", color: "#c58f91", opacity: 0.9 },
  reproductive: { label: "生殖系统", color: "#b78379", opacity: 0.92 },
  integumentary: { label: "体表", color: "#ba9b7d", opacity: 0.08 },
  connective: { label: "结缔组织", color: "#aec3bb", opacity: 0.7 },
};

export const ATLAS_SYSTEM_ORDER: AtlasSystemId[] = [
  "skeletal", "muscular", "cardiac", "sensory", "arterial",
  "venous", "nervous", "respiratory", "digestive", "urinary",
  "lymphatic", "endocrine", "reproductive", "integumentary", "connective",
];

/** 与 Human Atlas 一致：默认显示全部解剖系统，仅隐藏体表层。 */
export const DEFAULT_ATLAS_SYSTEMS: AtlasSystemId[] = ATLAS_SYSTEM_ORDER.filter(
  (system) => system !== "integumentary",
);

export const ORGAN_PRESET_SYSTEMS: AtlasSystemId[] = [
  "cardiac", "respiratory", "digestive", "urinary", "endocrine", "reproductive",
];

/** 展示器官与 BodyParts3D/FMA 概念的映射，由人体结构树（lib/anatomy）统一推导。 */
export const ORGAN_CONCEPT_IDS: Record<string, string[]> = organConceptIds();

export const ORGAN_LABELS: Record<string, string> = DISPLAY_ORGAN_LABELS;

export const HEALTH_HIGHLIGHTS: Partial<Record<HealthStatus, string>> = {
  abnormal: "#e45543",
  attention: "#d9962f",
};

export function createPartOrganMap(atlas: HumanAtlas): Map<string, string> {
  const concepts = new Map(atlas.concepts.map((concept) => [concept.id, concept]));
  const result = new Map<string, string>();
  Object.entries(ORGAN_CONCEPT_IDS).forEach(([organ, conceptIds]) => {
    conceptIds.forEach((conceptId) => {
      concepts.get(conceptId)?.elements.forEach((partId) => {
        if (!result.has(partId)) result.set(partId, organ);
      });
    });
  });
  return result;
}
