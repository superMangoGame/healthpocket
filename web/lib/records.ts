import { apiFetch, apiUrl } from "@/lib/api";
import type { EvidenceSource, MedicalRecord, RecordCategory, RecordFile, RecordParseStatus, ReportSummary } from "@/lib/types";

/** 时间线里的类别：体检报告来自 reports，其余来自 medical_records。 */
export type TimelineCategory = RecordCategory | "exam";

export const RECORD_CATEGORIES: Array<{ id: RecordCategory; label: string; hint: string; placeholder: string }> = [
  { id: "outpatient", label: "门诊病历", hint: "门诊、急诊病历与诊断证明", placeholder: "例如：呼吸内科复诊" },
  { id: "inpatient", label: "住院记录", hint: "入出院、手术记录与出院小结", placeholder: "例如：阑尾切除术出院小结" },
  { id: "imaging", label: "影像检查", hint: "CT、核磁、X 光、B 超的报告与图片", placeholder: "例如：胸部 CT 平扫" },
  { id: "lab", label: "检验报告", hint: "化验单、病理与基因检测", placeholder: "例如：甲状腺功能五项" },
  { id: "prescription", label: "处方用药", hint: "处方、用药清单与医嘱", placeholder: "例如：降压药调整" },
  { id: "other", label: "其他", hint: "疫苗接种、体测等其他资料", placeholder: "例如：乙肝疫苗接种记录" },
];

export const TIMELINE_CATEGORIES: TimelineCategory[] = ["exam", ...RECORD_CATEGORIES.map((item) => item.id)];

export const CATEGORY_LABELS: Record<TimelineCategory, string> = {
  exam: "体检报告", outpatient: "门诊病历", inpatient: "住院记录", imaging: "影像检查", lab: "检验报告", prescription: "处方用药", other: "其他",
};

/** For tight places such as the year cards on the overview. */
export const CATEGORY_SHORT_LABELS: Record<TimelineCategory, string> = {
  exam: "体检", outpatient: "门诊", inpatient: "住院", imaging: "影像", lab: "检验", prescription: "用药", other: "其他",
};

export const isTimelineCategory = (value: string | null): value is TimelineCategory =>
  value !== null && (TIMELINE_CATEGORIES as string[]).includes(value);

export interface TimelineEntry {
  key: string;
  kind: "exam" | "record";
  id: string;
  category: TimelineCategory;
  title: string;
  /** YYYY-MM-DD; a checkup whose date was not recognized has none. */
  date: string | null;
  year: number | null;
  institution: string | null;
  department: string | null;
  notes: string | null;
  files: RecordFile[];
  /** Checkups only: how far parsing got. */
  parseStatus: string | null;
  href: string;
}

export const recordTitle = (record: Pick<MedicalRecord, "title" | "category">) => record.title || CATEGORY_LABELS[record.category];

export function buildTimeline(reports: ReportSummary[], records: MedicalRecord[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...reports.map((report): TimelineEntry => ({
      key: `exam:${report.id}`, kind: "exam", id: report.id, category: "exam", title: "健康体检",
      date: report.exam_date, year: report.year ?? (report.exam_date ? Number(report.exam_date.slice(0, 4)) : null),
      institution: report.institution, department: null, notes: null, files: [], parseStatus: report.parse_status,
      href: `/reports/detail?id=${report.id}`,
    })),
    ...records.map((record): TimelineEntry => ({
      key: `record:${record.id}`, kind: "record", id: record.id, category: record.category, title: recordTitle(record),
      date: record.record_date, year: record.year, institution: record.institution, department: record.department,
      notes: record.notes, files: record.files, parseStatus: null, href: `/reports/record?id=${record.id}`,
    })),
  ];
  // A checkup known only by its year sorts to the end of that year.
  const sortKey = (entry: TimelineEntry) => entry.date ?? (entry.year ? `${entry.year}-00-00` : "0000");
  return entries.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
}

/** Newest year first; entries without any date come last. */
export function groupByYear(entries: TimelineEntry[]): Array<{ year: number | null; entries: TimelineEntry[] }> {
  const groups = new Map<number | null, TimelineEntry[]>();
  for (const entry of entries) groups.set(entry.year, [...(groups.get(entry.year) ?? []), entry]);
  return [...groups].map(([year, list]) => ({ year, entries: list })).sort((a, b) => (b.year ?? -1) - (a.year ?? -1));
}

export function countByCategory(entries: TimelineEntry[]): Partial<Record<TimelineCategory, number>> {
  const counts: Partial<Record<TimelineCategory, number>> = {};
  for (const entry of entries) counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  return counts;
}

const pad = (value: number) => String(value).padStart(2, "0");
export const localDateKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** "2024-03-15" → "03/15". */
export const monthDay = (date: string | null) => (date ? `${date.slice(5, 7)}/${date.slice(8, 10)}` : "日期待定");

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return year >= 1900 && date.getTime() <= Date.now() ? localDateKey(date) : null;
}

/** Hospital exports and phone photos usually carry the date: "2024-03-15 CT.jpg", "IMG_20240315_0931.jpg". */
export function dateFromFilename(name: string): string | null {
  const patterns = [/(?:^|\D)((?:19|20)\d{2})[-_.年/](\d{1,2})[-_.月/](\d{1,2})(?!\d)/, /(?:^|\D)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/];
  for (const pattern of patterns) {
    const match = pattern.exec(name);
    const value = match && validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (value) return value;
  }
  return null;
}

export const RECORD_FILE_ACCEPT = "application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp";
export const MAX_RECORD_FILE_BYTES = 80 * 1024 * 1024;
const RECORD_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

export const isImageFile = (file: File) => ["image/jpeg", "image/png", "image/webp"].includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
export const isRecordFile = (file: File) => RECORD_MIME_TYPES.includes(file.type) || /\.(pdf|jpe?g|png|webp)$/i.test(file.name);

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A smaller JPEG copy of an image. The timeline gets a 480 px thumbnail: phone
 * photos of a CT film run to 12 MP, and decoding dozens at full size just to show
 * 56-pixel tiles would eat gigabytes. The vision model gets a 2048 px copy, which
 * reads as well and uploads faster. The original always stays untouched.
 */
async function resizeImage(file: File, size: number, quality: number, onlyIfLarger = false): Promise<Blob | null> {
  if (!isImageFile(file)) return null;
  try {
    const bitmap = await createImageBitmap(file);
    if (onlyIfLarger && Math.max(bitmap.width, bitmap.height) <= size && file.size <= 3 * 1024 * 1024) { bitmap.close(); return null; }
    const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) { bitmap.close(); return null; }
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  } catch {
    return null;
  }
}

/** `recognize` sends images and scanned PDFs to the configured vision model once stored. */
export async function uploadRecordFile(recordId: string, file: File, options: { recognize?: boolean } = {}): Promise<RecordFile> {
  const body = new FormData();
  body.append("file", file);
  const thumbnail = await resizeImage(file, 480, 0.82);
  if (thumbnail) body.append("thumbnail", thumbnail, "thumbnail.jpg");
  const readable = await resizeImage(file, 2048, 0.86, true);
  if (readable) body.append("readable", readable, "readable.jpg");
  if (options.recognize) body.append("recognize", "1");
  return apiFetch<RecordFile>(`/records/${recordId}/files`, { method: "POST", body });
}

export const PARSE_STATUS_LABELS: Record<RecordParseStatus, string> = {
  queued: "等待识别", processing: "识别中", completed: "已识别", needs_ai: "待 AI 识别", failed: "识别失败",
};

export const isParsing = (file: Pick<RecordFile, "parse_status">) => file.parse_status === "queued" || file.parse_status === "processing";

/** One line for the timeline: what was read from a record's files, or what is still waiting. */
export function parseSummary(files: RecordFile[]): { text: string; tone: "normal" | "attention" | "abnormal" | "muted" } | null {
  if (!files.length) return null;
  if (files.some(isParsing)) return { text: "识别中…", tone: "muted" };
  const measurements = files.reduce((sum, file) => sum + (file.measurement_count ?? 0), 0);
  const findings = files.reduce((sum, file) => sum + (file.finding_count ?? 0), 0);
  const waiting = files.filter((file) => file.parse_status === "needs_ai").length;
  const failed = files.filter((file) => file.parse_status === "failed").length;
  const read = [measurements && `${measurements} 项指标`, findings && `${findings} 条诊断 / 结论`].filter(Boolean).join(" · ");
  const pending = [waiting && `${waiting} 个待 AI 识别`, failed && `${failed} 个识别失败`].filter(Boolean).join(" · ");
  if (read) return { text: `识别出 ${read}${pending ? `；${pending}` : ""}`, tone: failed ? "attention" : "normal" };
  if (pending) return { text: pending, tone: failed ? "abnormal" : "attention" };
  return { text: "未识别出指标或诊断", tone: "muted" };
}

/** Where a measurement or finding links back to: the checkup page, or the record with that file open. */
export function evidenceHref(item: EvidenceSource & { report_id: string; page?: number }): string {
  if (item.origin === "record") return `/reports/record?id=${item.report_id}${item.file_id ? `&file=${item.file_id}` : ""}`;
  return `/reports/detail?id=${item.report_id}`;
}

export function evidenceLink(item: EvidenceSource & { page?: number }): string {
  return item.origin === "record" ? item.source_label || "就医记录" : `第 ${item.page ?? 1} 页`;
}

export const recordFileUrl = (file: Pick<RecordFile, "record_id" | "id">, thumbnail = false) =>
  apiUrl(`/records/${file.record_id}/files/${file.id}${thumbnail ? "?thumb=1" : ""}`);
