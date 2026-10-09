/**
 * 人体结构树：报告解析、聚合与 3D 图谱共用的唯一解剖模型。
 *
 * 任何体检机构的报告内容都先归到这棵树上最具体的节点，再沿父链汇总到
 * `organ`（器官导航使用的展示器官）和 `system`（解剖系统）。新增识别能力只需
 * 在这里补充别名或检查名，不需要改解析代码。
 *
 * 本文件不能有任何 import：它同时被插件运行时（src/）与 Next 前端（web/）引用。
 */

export type AnatomySystem =
  | "general" | "nervous" | "sensory" | "endocrine" | "cardiovascular" | "respiratory"
  | "digestive" | "urinary" | "reproductive" | "musculoskeletal" | "hematologic"
  | "metabolic" | "integumentary" | "lymphatic";

export interface AnatomyNode {
  id: string;
  parent: string | null;
  label: string;
  system: AnatomySystem;
  /** 器官导航里的展示器官；子节点未声明时沿父链继承。 */
  organ?: string;
  sex?: "female" | "male";
  /** 全身性节点（血液、代谢）没有固定的解剖位置。 */
  systemic?: boolean;
  /** BodyParts3D / FMA 概念，用于 3D 高亮。 */
  fma?: string[];
  /** 结构名称、体征、检验项目、检查名称：出现在报告文字里即可命中。 */
  terms: string[];
}

const node = (id: string, parent: string | null, label: string, system: AnatomySystem, terms: string[], extra: Partial<AnatomyNode> = {}): AnatomyNode =>
  ({ id, parent, label, system, terms, ...extra });

export const ANATOMY: AnatomyNode[] = [
  node("body", null, "全身与其他", "general", ["其他部位", "全身"], { organ: "other" }),
  node("integumentary.skin", "body", "皮肤", "integumentary", ["皮肤", "皮疹", "蜘蛛痣", "皮下肿块", "色素痣", "湿疹"], { organ: "other" }),
  node("lymphatic.nodes", "body", "浅表淋巴结", "lymphatic", ["淋巴结"], { organ: "other" }),

  node("nervous", "body", "神经系统", "nervous", ["神经系统", "膝反射", "神经反射"], { organ: "head" }),
  node("nervous.brain", "nervous", "头部与颅脑", "nervous", ["头颅", "颅脑", "脑部", "脑血管", "头部", "经颅多普勒", "TCD", "脑电图"], { organ: "head", fma: ["FMA50801"] }),

  node("sensory", "body", "感官", "sensory", []),
  node("sensory.eye", "sensory", "眼部", "sensory", ["眼科", "眼底", "眼压", "视力", "晶状体", "眼球", "外眼", "裂隙灯", "结膜", "角膜", "视网膜", "玻璃体", "屈光", "近视", "散光", "白内障", "眼睑", "沙眼", "视盘", "黄斑"], { organ: "eyes", fma: ["FMA54449", "FMA54450"] }),
  node("sensory.ent", "sensory", "耳鼻喉", "sensory", ["耳鼻喉", "耳鼻咽喉", "听力", "外耳", "耳道", "鼓膜", "鼻腔", "鼻中隔", "鼻甲", "鼻咽", "咽喉", "咽部", "扁桃体", "鼻炎", "咽炎", "鼻窦", "耵聍"], { organ: "ent", fma: ["FMA52781", "FMA46472", "FMA7394"] }),
  node("sensory.oral", "sensory", "口腔", "sensory", ["口腔", "牙", "牙齿", "牙龈", "牙周", "牙列", "牙石", "龋齿", "齿列", "智齿", "阻生", "残根", "颞下颌", "口腔粘膜", "口腔黏膜", "舌苔"], { organ: "oral", fma: ["FMA49184"] }),

  node("neck", "body", "颈部", "musculoskeletal", ["颈部", "颈部淋巴"], { organ: "neck", fma: ["FMA7155"] }),
  node("endocrine", "body", "内分泌", "endocrine", ["内分泌"], { organ: "thyroid" }),
  node("endocrine.thyroid", "endocrine", "甲状腺", "endocrine", ["甲状腺", "甲功", "TSH", "FT3", "FT4", "TI-RADS", "TIRADS", "甲状腺球蛋白", "降钙素"], { organ: "thyroid" }),

  node("cardiovascular", "body", "心血管", "cardiovascular", ["心血管"], { organ: "heart" }),
  node("cardiovascular.heart", "cardiovascular", "心脏", "cardiovascular", ["心脏", "心率", "心律", "心音", "心界", "杂音", "心电", "心肌", "心包", "心室", "心房", "低电压", "窦性", "早搏", "期前收缩", "ST段", "T波", "传导阻滞", "束支", "心动过速", "心动过缓", "超声心动", "瓣膜", "肌酸激酶", "乳酸脱氢酶", "肌钙蛋白", "BNP", "心肌酶"], { organ: "heart", fma: ["FMA7088"] }),
  node("cardiovascular.vessels", "cardiovascular", "血管与血压", "cardiovascular", ["血压", "收缩压", "舒张压", "低血压", "高血压", "动脉", "颈动脉", "动脉硬化", "斑块", "脉搏波", "踝臂", "血管弹性", "同型半胱氨酸", "静脉曲张"], { organ: "heart" }),
  node("cardiovascular.lipids", "cardiovascular", "血脂", "cardiovascular", ["血脂", "胆固醇", "甘油三酯", "脂蛋白", "载脂蛋白"], { organ: "heart", systemic: true }),

  node("respiratory", "body", "呼吸系统", "respiratory", ["呼吸系统", "呼吸科"], { organ: "lungs" }),
  node("respiratory.lung", "respiratory", "肺", "respiratory", ["肺", "支气管", "Lung-RADS", "肺功能", "呼吸音", "罗音", "啰音", "肺纹理"], { organ: "lungs", fma: ["FMA7309", "FMA7310"] }),
  node("respiratory.thorax", "respiratory", "胸腔与胸膜", "respiratory", ["胸部", "胸膜", "胸廓", "纵隔", "胸腔", "胸片", "胸部正位", "胸部CT", "胸部DR"], { organ: "lungs" }),

  node("digestive", "body", "消化系统", "digestive", ["消化系统", "消化内科"], { organ: "stomach" }),
  node("digestive.liver", "digestive", "肝脏", "digestive", ["肝", "脂肪肝", "转氨酶", "胆红素", "肝功能", "肝脏瞬时弹性", "脂肪衰减", "白蛋白", "球蛋白", "AFP", "甲胎蛋白", "乙肝", "丙肝"], { organ: "liver", fma: ["FMA7197"] }),
  node("digestive.gallbladder", "digestive", "胆囊与胆道", "digestive", ["胆", "胆囊", "胆管", "胆道", "胆结石", "胆汁淤积"], { organ: "gallbladder", fma: ["FMA7202"] }),
  node("digestive.pancreas", "digestive", "胰腺", "digestive", ["胰", "胰腺", "淀粉酶", "脂肪酶", "CA19-9", "CA199", "糖类抗原19-9", "糖链抗原19-9"], { organ: "pancreas", fma: ["FMA7198"] }),
  node("digestive.spleen", "digestive", "脾脏", "digestive", ["脾", "副脾"], { organ: "spleen", fma: ["FMA7196"] }),
  node("digestive.stomach", "digestive", "胃", "digestive", ["胃", "幽门螺杆菌", "胃泌素", "胃蛋白酶原", "PGI", "PGII", "G-17", "碳13", "碳14", "C13", "C14", "胃镜", "胃功能"], { organ: "stomach", fma: ["FMA7148"] }),
  node("digestive.intestine", "digestive", "肠道与肛门", "digestive", ["肠", "结肠", "直肠", "肛门", "肛周", "痔", "便隐血", "大便", "粪便", "肠镜", "CEA", "癌胚抗原"], { organ: "stomach", fma: ["FMA7131", "FMA7200", "FMA7201"] }),

  node("urinary", "body", "泌尿系统", "urinary", ["泌尿系", "泌尿系统", "泌尿"], { organ: "kidney" }),
  node("urinary.kidney", "urinary", "肾脏", "urinary", ["肾", "肾功能", "肌酐", "尿素", "尿素氮", "尿酸", "胱抑素", "肾小球滤过", "eGFR"], { organ: "kidney", fma: ["FMA7203"] }),
  node("urinary.bladder", "urinary", "输尿管与膀胱", "urinary", ["膀胱", "输尿管", "尿路", "尿道"], { organ: "bladder", fma: ["FMA15900", "FMA9704"] }),
  node("urinary.urine", "urinary", "尿液检查", "urinary", ["尿常规", "尿液", "尿白细胞", "尿红细胞", "尿镜检", "尿隐血", "尿蛋白", "尿糖", "尿葡萄糖", "尿比重", "尿酸碱度", "尿亚硝酸盐", "尿酮体", "尿胆原", "尿胆红素", "管型", "尿沉渣"], { organ: "kidney" }),

  node("reproductive", "body", "生殖系统", "reproductive", ["生殖"], {}),
  node("reproductive.breast", "reproductive", "乳腺", "reproductive", ["乳腺", "乳房", "乳头", "BI-RADS", "BIRADS", "钼靶", "CA15-3", "CA153", "糖链抗原15-3", "糖类抗原15-3"], { organ: "breast", sex: "female" }),
  node("reproductive.female", "reproductive", "女性生殖", "reproductive", ["妇科", "妇检"], { organ: "uterus", sex: "female" }),
  node("reproductive.female.uterus", "reproductive.female", "子宫", "reproductive", ["子宫", "宫体", "内膜", "肌瘤", "宫腔"], { organ: "uterus", sex: "female" }),
  node("reproductive.female.cervix", "reproductive.female", "宫颈", "reproductive", ["宫颈", "TCT", "HPV", "刮片", "糜样", "NILM", "SCC", "鳞状上皮细胞癌抗原"], { organ: "uterus", sex: "female" }),
  node("reproductive.female.vagina", "reproductive.female", "阴道与外阴", "reproductive", ["阴道", "外阴", "白带", "清洁度", "滴虫", "霉菌", "线索细胞", "分泌物"], { organ: "uterus", sex: "female" }),
  node("reproductive.female.adnexa", "reproductive.female", "卵巢与附件", "reproductive", ["卵巢", "附件", "输卵管", "盆腔", "CA125", "糖链抗原125", "糖类抗原125", "HE4"], { organ: "ovary", sex: "female" }),
  node("reproductive.male", "reproductive", "男性生殖", "reproductive", ["男科"], { organ: "prostate", sex: "male" }),
  node("reproductive.male.prostate", "reproductive.male", "前列腺", "reproductive", ["前列腺", "PSA", "FPSA"], { organ: "prostate", sex: "male", fma: ["FMA9600"] }),

  node("musculoskeletal", "body", "骨骼与关节", "musculoskeletal", ["骨骼", "骨密度", "骨质疏松", "骨量", "四肢", "关节"], { organ: "spine" }),
  node("musculoskeletal.spine", "musculoskeletal", "脊柱", "musculoskeletal", ["脊柱", "颈椎", "胸椎", "腰椎", "椎间盘", "椎体", "生理曲度", "骨质增生"], { organ: "spine", fma: ["FMA13478", "FMA7647"] }),

  node("hematologic", "body", "血液", "hematologic", ["血常规", "白细胞", "红细胞", "血小板", "血红蛋白", "中性粒", "淋巴细胞", "单核细胞", "嗜酸", "嗜碱", "贫血", "红细胞压积", "红细胞比容", "凝血", "血型", "铁蛋白", "血清铁", "铁结合力", "TIBC", "转铁蛋白"], { organ: "blood", systemic: true }),
  node("metabolic", "body", "代谢与一般检查", "metabolic", ["一般检查", "一般项目", "体重指数", "BMI", "超重", "肥胖", "消瘦", "血糖", "葡萄糖", "糖化", "胰岛素", "C肽", "体重", "腰围", "臀围", "体脂", "糖尿病", "电解质", "维生素"], { organ: "metabolic", systemic: true }),
];

export const ANATOMY_BY_ID = new Map(ANATOMY.map((item) => [item.id, item]));

/** 器官导航的展示器官，按导航顺序排列。 */
export const DISPLAY_ORGANS: Array<{ id: string; label: string; sex?: "female" | "male" }> = [
  { id: "head", label: "头部与颅脑" }, { id: "eyes", label: "眼部" }, { id: "ent", label: "耳鼻喉" },
  { id: "oral", label: "口腔" }, { id: "neck", label: "颈部" }, { id: "thyroid", label: "甲状腺" },
  { id: "lungs", label: "胸腔与肺" }, { id: "heart", label: "心血管" }, { id: "breast", label: "乳腺", sex: "female" },
  { id: "liver", label: "肝脏" }, { id: "gallbladder", label: "胆囊与胆道" }, { id: "stomach", label: "胃肠" },
  { id: "pancreas", label: "胰腺" }, { id: "spleen", label: "脾脏" }, { id: "kidney", label: "肾脏与尿液" },
  { id: "bladder", label: "输尿管与膀胱" }, { id: "uterus", label: "子宫宫颈", sex: "female" },
  { id: "ovary", label: "卵巢附件", sex: "female" }, { id: "prostate", label: "前列腺", sex: "male" },
  { id: "spine", label: "脊柱与骨关节" }, { id: "blood", label: "血液" }, { id: "metabolic", label: "代谢与一般检查" },
  { id: "other", label: "皮肤与其他" },
];

export const DISPLAY_ORGAN_LABELS: Record<string, string> = Object.fromEntries(DISPLAY_ORGANS.map((item) => [item.id, item.label]));

export function anatomyAncestors(id: string): AnatomyNode[] {
  const chain: AnatomyNode[] = [];
  for (let current = ANATOMY_BY_ID.get(id); current; current = current.parent ? ANATOMY_BY_ID.get(current.parent) : undefined) chain.push(current);
  return chain;
}

/** 节点汇总到的展示器官；未知节点归到“其他”。 */
export function organOfAnatomy(id: string | null | undefined): string {
  if (!id) return "other";
  return anatomyAncestors(id).find((item) => item.organ)?.organ ?? "other";
}

export function isAnatomyDescendant(id: string, ancestor: string): boolean {
  return anatomyAncestors(id).some((item) => item.id === ancestor);
}

/** 展示器官下挂的所有 FMA 概念，供 3D 图谱高亮。 */
export function organConceptIds(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const item of ANATOMY) {
    if (!item.fma?.length) continue;
    const organ = organOfAnatomy(item.id);
    result[organ] = [...(result[organ] ?? []), ...item.fma];
  }
  return result;
}

export interface AnatomyMatch { id: string; score: number }

const TERM_INDEX: Array<{ term: string; upper: string; id: string }> = ANATOMY
  .flatMap((item) => item.terms.map((term) => ({ term, upper: term.toUpperCase(), id: item.id })))
  .sort((a, b) => b.term.length - a.term.length);

/**
 * 在文字中找解剖命中。较长的术语优先占位，避免“胆固醇”落到“胆”、
 * “乳酸脱氢酶”落到“乳房”这类误判；每个节点的得分是其命中术语的长度和。
 */
export function matchAnatomy(text: string, sex?: "female" | "male" | null): AnatomyMatch[] {
  const upper = text.toUpperCase();
  const taken = new Array<boolean>(upper.length).fill(false);
  const scores = new Map<string, number>();
  for (const entry of TERM_INDEX) {
    let from = 0;
    for (let index = upper.indexOf(entry.upper, from); index >= 0; index = upper.indexOf(entry.upper, from)) {
      from = index + entry.upper.length;
      if (taken.slice(index, from).some(Boolean)) continue;
      for (let cursor = index; cursor < from; cursor += 1) taken[cursor] = true;
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + entry.term.length);
    }
  }
  const depth = (id: string) => anatomyAncestors(id).length;
  return [...scores.entries()]
    .filter(([id]) => !sex || !ANATOMY_BY_ID.get(id)?.sex || ANATOMY_BY_ID.get(id)?.sex === sex)
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || depth(b.id) - depth(a.id));
}

/**
 * 按上下文把一条内容归到最具体的节点：
 * 1. 内容本身命中的节点，若落在所属章节节点之内，直接采用；
 * 2. 章节只指向一个具体部位（如【尿常规】【乳腺超声】）时以章节为准，
 *    避免“尿常规-白细胞”被当成血液；
 * 3. 否则采用内容命中，再退回章节命中，最后归到根节点，保证不丢。
 */
export function classifyAnatomy(input: { text: string; context?: string | null; sex?: "female" | "male" | null }): string {
  const own = matchAnatomy(input.text, input.sex);
  const context = input.context ? matchAnatomy(input.context, input.sex) : [];
  const best = own[0]?.id;
  const unique = context[0] && (!context[1] || context[0].score > context[1].score) ? context[0].id : undefined;
  if (unique) {
    if (best && isAnatomyDescendant(best, unique)) return best;
    const contextNode = ANATOMY_BY_ID.get(unique);
    if (contextNode && !contextNode.systemic && unique !== "body" && (!best || ANATOMY_BY_ID.get(best)?.systemic)) return unique;
  }
  return best ?? unique ?? context[0]?.id ?? "body";
}

/** 多器官章节（如“肝胆脾胰双肾彩超”）的正常小结可同时作为多个节点的正常证据。 */
export function anatomyTargets(text: string, sex?: "female" | "male" | null): string[] {
  return matchAnatomy(text, sex).map((item) => item.id);
}
