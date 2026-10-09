import { DISPLAY_ORGAN_LABELS, organOfAnatomy } from '../web/lib/anatomy.ts'

export type HealthStatus = 'normal' | 'attention' | 'abnormal' | 'insufficient'

export interface MetricSpec {
  canonical_id: string
  display_name: string
  abbreviation: string | null
  aliases: string[]
  value_type: 'numeric' | 'text'
  canonical_unit: string | null
  category: string
  /** 人体结构树节点 id；organ 由它推导，保留给旧接口。 */
  anatomy: string
  organ: string | null
}

const metric = (
  canonical_id: string,
  display_name: string,
  abbreviation: string | null,
  aliases: string[],
  value_type: 'numeric' | 'text',
  canonical_unit: string | null,
  category: string,
  anatomy: string,
): MetricSpec => ({ canonical_id, display_name, abbreviation, aliases, value_type, canonical_unit, category, anatomy, organ: organOfAnatomy(anatomy) })

/** 与原 Python 解析器相同的稳定指标词典。 */
export const METRICS: MetricSpec[] = [
  metric('bmi', '体重指数', 'BMI', ['体重指数', '身体质量指数'], 'numeric', 'kg/m²', '一般检查', 'metabolic'),
  metric('systolic_bp', '收缩压', 'SBP', ['收缩压'], 'numeric', 'mmHg', '心血管', 'cardiovascular.vessels'),
  metric('diastolic_bp', '舒张压', 'DBP', ['舒张压'], 'numeric', 'mmHg', '心血管', 'cardiovascular.vessels'),
  metric('wbc', '白细胞计数', 'WBC', ['白细胞计数', '白细胞'], 'numeric', '10^9/L', '血常规', 'hematologic'),
  metric('rbc', '红细胞计数', 'RBC', ['红细胞计数'], 'numeric', '10^12/L', '血常规', 'hematologic'),
  metric('hemoglobin', '血红蛋白', 'Hb', ['血红蛋白', '血红蛋白测定'], 'numeric', 'g/L', '血常规', 'hematologic'),
  metric('platelet', '血小板计数', 'PLT', ['血小板计数'], 'numeric', '10^9/L', '血常规', 'hematologic'),
  metric('glucose', '空腹血糖', 'GLU', ['空腹血糖', '葡萄糖测定', '血清葡萄糖'], 'numeric', 'mmol/L', '血糖与代谢', 'metabolic'),
  metric('total_cholesterol', '血清总胆固醇', 'TC', ['血清总胆固醇', '总胆固醇'], 'numeric', 'mmol/L', '血脂与代谢', 'cardiovascular.lipids'),
  metric('triglyceride', '血清甘油三酯', 'TG', ['血清甘油三酯', '甘油三酯'], 'numeric', 'mmol/L', '血脂与代谢', 'cardiovascular.lipids'),
  metric('hdl', '高密度脂蛋白胆固醇', 'HDL-C', ['高密度脂蛋白胆固醇'], 'numeric', 'mmol/L', '血脂与代谢', 'cardiovascular.lipids'),
  metric('ldl', '低密度脂蛋白胆固醇', 'LDL-C', ['低密度脂蛋白胆固醇'], 'numeric', 'mmol/L', '血脂与代谢', 'cardiovascular.lipids'),
  metric('alt', '丙氨酸氨基转移酶', 'ALT', ['丙氨酸氨基转移酶', '谷丙转氨酶'], 'numeric', 'U/L', '肝胆功能', 'digestive.liver'),
  metric('ast', '天门冬氨酸氨基转移酶', 'AST', ['天门冬氨酸氨基转移酶', '谷草转氨酶'], 'numeric', 'U/L', '肝胆功能', 'digestive.liver'),
  metric('ggt', 'γ-谷氨酰转移酶', 'GGT', ['γ-谷氨酰转移酶', '谷氨酰转移酶'], 'numeric', 'U/L', '肝胆功能', 'digestive.liver'),
  metric('alp', '碱性磷酸酶', 'ALP', ['碱性磷酸酶'], 'numeric', 'U/L', '肝胆功能', 'digestive.liver'),
  metric('total_bilirubin', '总胆红素', 'TBIL', ['血清总胆红素', '总胆红素'], 'numeric', 'μmol/L', '肝胆功能', 'digestive.liver'),
  metric('direct_bilirubin', '直接胆红素', 'DBIL', ['血清直接胆红素', '直接胆红素'], 'numeric', 'μmol/L', '肝胆功能', 'digestive.liver'),
  metric('albumin', '白蛋白', 'ALB', ['血清白蛋白', '白蛋白'], 'numeric', 'g/L', '肝胆功能', 'digestive.liver'),
  metric('urea', '尿素', 'Urea', ['血清尿素', '尿素测定'], 'numeric', 'mmol/L', '肾功能与泌尿', 'urinary.kidney'),
  metric('creatinine', '肌酐', 'CREA', ['血清肌酐', '肌酐测定'], 'numeric', 'μmol/L', '肾功能与泌尿', 'urinary.kidney'),
  metric('uric_acid', '尿酸', 'UA', ['血清尿酸', '尿酸测定', '尿酸'], 'numeric', 'μmol/L', '肾功能与泌尿', 'urinary.kidney'),
  metric('tsh', '促甲状腺激素', 'TSH', ['血清促甲状腺激素', '促甲状腺激素'], 'numeric', 'uIU/mL', '甲状腺功能', 'endocrine.thyroid'),
  metric('t3', '三碘甲状原氨酸', 'T3', ['血清三碘甲状原氨酸', '三碘甲状原氨酸'], 'numeric', 'ng/mL', '甲状腺功能', 'endocrine.thyroid'),
  metric('t4', '甲状腺素', 'T4', ['血清甲状腺素', '甲状腺素'], 'numeric', 'ug/dL', '甲状腺功能', 'endocrine.thyroid'),
  metric('ft3', '游离三碘甲状原氨酸', 'FT3', ['血清游离三碘甲状原氨酸', '游离三碘甲状原氨酸'], 'numeric', 'pg/mL', '甲状腺功能', 'endocrine.thyroid'),
  metric('ft4', '游离甲状腺素', 'FT4', ['血清游离甲状腺素', '游离甲状腺素'], 'numeric', 'ng/dL', '甲状腺功能', 'endocrine.thyroid'),
  metric('urine_ph', '尿酸碱度', 'pH', ['尿酸碱度', '尿液酸碱度'], 'numeric', null, '尿常规', 'urinary.urine'),
  metric('urine_specific_gravity', '尿比重', 'SG', ['尿比重'], 'numeric', null, '尿常规', 'urinary.urine'),
  metric('urine_protein', '尿蛋白质', 'PRO', ['尿蛋白质', '尿蛋白'], 'text', null, '尿常规', 'urinary.urine'),
  metric('urine_glucose', '尿葡萄糖', 'U-GLU', ['尿葡萄糖', '尿糖'], 'text', null, '尿常规', 'urinary.urine'),
  metric('urine_blood', '尿隐血', 'BLD', ['尿隐血'], 'text', null, '尿常规', 'urinary.urine'),
  metric('h_pylori', '幽门螺杆菌抗体', null, ['幽门螺杆菌抗体检测', '幽门螺杆菌抗体'], 'numeric', 'AU/mL', '消化系统', 'digestive.stomach'),
  metric('vaginal_cleanliness', '白带清洁度', 'VC', ['白带清洁度'], 'numeric', '级', '妇科检验', 'reproductive.female.vagina'),
  metric('hpv', 'HPV 分型检测', 'HPV', ['HPV'], 'text', null, '宫颈筛查', 'reproductive.female.cervix'),
  metric('tct', '宫颈细胞学（TCT）', 'TCT', ['液基薄层细胞学检测TCT', 'TCT检测', '宫颈TCT', '宫颈刮片'], 'text', null, '宫颈筛查', 'reproductive.female.cervix'),
  metric('ca125', '糖链抗原 125', 'CA125', ['糖链抗原125测定', '糖链抗原125', 'CA125'], 'numeric', 'U/mL', '妇科相关标志物', 'reproductive.female.adnexa'),
  metric('ca153', '糖链抗原 15-3', 'CA15-3', ['糖链抗原15-3测定', '糖链抗原15-3', 'CA15-3'], 'numeric', 'U/mL', '乳腺相关标志物', 'reproductive.breast'),
  metric('birads', '乳腺影像 BI-RADS 分类', 'BI-RADS', ['BI-RADS'], 'numeric', '类', '乳腺检查', 'reproductive.breast'),
]

export const METRIC_BY_ID = new Map(METRICS.map((item) => [item.canonical_id, item]))

/** 器官导航的展示器官，统一来自人体结构树。 */
export const ORGAN_LABELS: Record<string, string> = DISPLAY_ORGAN_LABELS

export const RISK_DOMAINS: Array<[string, string, string[]]> = [
  ['cardiovascular', '心血管', ['heart']], ['hepatobiliary', '肝胆', ['liver', 'gallbladder']],
  ['digestive', '胃肠与消化', ['stomach', 'pancreas', 'spleen']], ['endocrine', '内分泌与代谢', ['thyroid', 'metabolic']],
  ['respiratory', '呼吸', ['lungs']], ['hematology', '血液', ['blood']], ['urinary', '肾脏与泌尿', ['kidney', 'bladder']],
  ['musculoskeletal', '脊柱骨骼', ['spine']], ['sensory', '头颈与感官', ['head', 'eyes', 'ent', 'oral', 'neck']],
  ['reproductive', '生殖与乳腺', ['breast', 'uterus', 'ovary', 'prostate']], ['other', '皮肤与其他', ['other']],
]
