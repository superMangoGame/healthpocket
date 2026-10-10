export type HealthStatus = "normal" | "attention" | "abnormal" | "insufficient";

export type ProfileRelation = "self" | "spouse" | "parent" | "child" | "other";

export interface Profile {
  id: string;
  name: string;
  relation: ProfileRelation;
  birth_date: string | null;
  is_default: boolean;
  report_count: number;
  created_at: string;
}

export interface ReportSummary {
  id: string;
  profile_id: string;
  filename: string;
  sha256: string;
  size_bytes: number;
  page_count: number | null;
  exam_date: string | null;
  year: number | null;
  institution: string | null;
  template_type: string;
  parse_status: string;
  parser_version: string;
  created_at: string;
}

export interface Measurement {
  id: string;
  canonical_id: string;
  raw_name: string;
  abbreviation: string | null;
  value_numeric: number | null;
  value_text: string | null;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  ref_text: string | null;
  flag: string | null;
  status: HealthStatus;
  category: string;
  organ: string | null;
  anatomy_id?: string | null;
  confidence: number;
  page: number;
  bbox: number[] | null;
  raw_text: string;
}

export interface Finding {
  id: string;
  title: string;
  content: string;
  category: string;
  organ: string | null;
  anatomy_id?: string | null;
  section?: string | null;
  source?: "conclusion" | "summary" | "item" | null;
  severity: HealthStatus;
  page: number;
  confidence: number;
}

export interface ReportDetail extends ReportSummary {
  measurements: Measurement[];
  findings: Finding[];
}

export interface DashboardData {
  report_count: number;
  year_from: number | null;
  year_to: number | null;
  years: Array<{
    year: number;
    status: HealthStatus;
    abnormal_count: number;
    attention_count: number;
  }>;
  recent_findings: Array<{
    id: string;
    title: string;
    content: string;
    severity: HealthStatus;
    year: number;
    report_id: string;
    page: number;
  }>;
  latest_reports: ReportSummary[];
  risk_matrix: RiskDomain[];
}

export interface RiskCell {
  year: number;
  status: HealthStatus;
  abnormal_count: number;
  attention_count: number;
  evidence_count: number;
}

export interface RiskDomain {
  id: string;
  label: string;
  years: RiskCell[];
}

export interface RiskEvidence {
  kind: "measurement" | "finding";
  title: string;
  value: string | null;
  reference: string | null;
  status: HealthStatus;
  flag: string | null;
  status_reason: string;
  confidence: number;
  report_id: string;
  page: number;
}

export interface RiskDetail {
  domain_id: string;
  label: string;
  year: number;
  abnormal_count: number;
  attention_count: number;
  evidence: RiskEvidence[];
}

export interface MetricDefinition {
  canonical_id: string;
  display_name: string;
  abbreviation: string | null;
  aliases: string[];
  value_type: string;
  canonical_unit: string | null;
  category: string;
  organ: string | null;
}

export interface TrendPoint {
  report_id: string;
  year: number;
  exam_date: string | null;
  value_numeric: number | null;
  value_text: string | null;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  ref_text: string | null;
  status: HealthStatus;
  confidence: number;
  page: number;
}

export interface TrendSeries {
  canonical_id: string;
  display_name: string;
  category: string;
  organ: string | null;
  selected_unit: string | null;
  available_units: string[];
  points: TrendPoint[];
}

export interface OrganEvidence {
  kind: "measurement" | "finding";
  title: string;
  value: string | null;
  reference: string | null;
  status: HealthStatus;
  flag: string | null;
  status_reason: string;
  confidence: number;
  report_id: string;
  page: number;
  /** 人体结构树中的具体部位，例如“宫颈”“胸腔与胸膜”。 */
  anatomy_id: string | null;
  anatomy_label: string | null;
}

export interface OrganTimeline {
  organ: string;
  label: string;
  rules_version: string;
  years: Array<{
    year: number;
    status: HealthStatus;
    abnormal_count: number;
    attention_count: number;
    evidence: OrganEvidence[];
  }>;
}

export interface AiSettings {
  provider: AiProvider;
  name: string;
  base_url: string;
  model: string;
  has_api_key: boolean;
  enabled: boolean;
  updated_at: string | null;
}

/** A Models.dev provider id, or "ollama" / "custom". */
export type AiProvider = string;

export interface AiProviderInfo {
  id: AiProvider;
  name: string;
  base_url: string;
  requires_api_key: boolean;
  /** Listed first; checked to work from inside Obsidian. */
  featured: boolean;
  /** Ollama and custom endpoints take a user-supplied address. */
  custom_base_url: boolean;
}

export interface AiModelList {
  models: string[];
  source: "provider" | "catalog";
  warning?: string;
}

/** Set while a Garmin login is parked on the verification-code step. */
export interface GarminMfaPrompt {
  required: true;
  method: "email" | "sms";
  target: string | null;
  masked_phone: string | null;
  allow_phone: boolean;
  email: string;
  expires_at: string;
}

/**
 * A Garmin action the backend is running right now, and how long it has been
 * running. Published from the moment the action starts so the settings page can
 * show real progress instead of a button that simply looks frozen - the log
 * only records completed work, so without this a stall is invisible.
 */
export interface GarminActive {
  action: string;
  stage: string;
  elapsed_ms: number;
  /**
   * Time spent on the current hop, which is the number that explains a stall: an
   * action parked on one step for 40 s reads very differently from one that has
   * been walking through hops.
   */
  stage_elapsed_ms?: number;
}

export type DailyInsightLevel = "good" | "attention" | "important";

export interface DailyInsight {
  id: string;
  category: "body_age" | "sleep" | "activity" | "recovery";
  level: DailyInsightLevel;
  title: string;
  finding: string;
  advice: string;
  sources: string[];
}

export interface FitnessAgeComponent {
  key: string;
  label: string;
  value: number;
  unit: string;
  target: string;
  on_target: boolean;
  advice: string;
}

export interface FitnessAge {
  date: string;
  fitness_age: number;
  chronological_age: number | null;
  achievable_fitness_age: number | null;
  previous_fitness_age: number | null;
  components: FitnessAgeComponent[];
}

export interface DailyAdvice {
  id: string;
  model: string;
  created_at: string;
  range: { from: string; to: string } | null;
  content: {
    summary: string;
    recommendations: Array<{ title: string; category: string; priority: "high" | "medium" | "low"; why: string; actions: string[] }>;
    cautions: string[];
  };
}

export interface DailyInsights {
  range: { from: string; to: string };
  fitness_age: FitnessAge | null;
  insights: DailyInsight[];
  advice: DailyAdvice | null;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releasesPage: string;
}

export interface UpdateStatus {
  phase: "idle" | "downloading" | "ready" | "error";
  version: string | null;
  received: number;
  total: number;
  error: string | null;
}

export interface GarminSettings {
  email: string;
  region: "global" | "cn";
  profile_id: string | null;
  authenticated: boolean;
  display_name: string | null;
  last_sync_at: string | null;
  last_sync_error: string | null;
  syncing: boolean;
  updated_at: string | null;
  mfa: GarminMfaPrompt | null;
  /** The action in flight, if any; null when the backend is idle. */
  running: GarminActive | null;
  /** Days fetched so far by the running sync. */
  sync_progress?: { done: number; total: number } | null;
  /** What the last successful sync saved; how a background sync reports back. */
  last_sync_result?: GarminSyncResult | null;
  /** False while the experimental Garmin sync is switched off in the Obsidian settings tab. */
  feature_enabled?: boolean;
}

export interface GarminSyncResult {
  synced_days: number;
  synced_activities: number;
  from: string | null;
  to: string | null;
  finished_at: string;
}

/** One finished Garmin action, as recorded by the plugin backend. */
export interface GarminDiagnostic {
  at: string;
  action: string;
  stage: string;
  ok: boolean;
  ms: number;
  message: string | null;
}

/**
 * One hop of a Garmin conversation: an endpoint the plugin actually called, how
 * long it took and what it answered. The action log says a login failed; this
 * says how far it got before it stopped, which is what a stall needs in order to
 * be fixable rather than just reportable.
 */
export interface GarminRequestRecord {
  at: string;
  action: string;
  step: string;
  ms: number;
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface GarminDiagnostics {
  entries: GarminDiagnostic[];
  /** Per-hop detail behind those actions, newest first. */
  requests?: GarminRequestRecord[];
  /** Set while an action is still running, so "no entries" stops meaning "nothing happened". */
  active: GarminActive | null;
  last_failure: GarminDiagnostic | null;
  limit: number;
  /** Backend queue state, which separates "queued behind another request" from "stuck". */
  queue?: { garmin_active: number; garmin_stalls: number; waiting: number } | null;
}

export interface GarminDailyPoint {
  date: string;
  steps: number | null;
  distance_m: number | null;
  active_calories: number | null;
  total_calories: number | null;
  resting_hr: number | null;
  min_hr: number | null;
  max_hr: number | null;
  average_stress: number | null;
  max_stress: number | null;
  body_battery: number | null;
  body_battery_low: number | null;
  body_battery_high: number | null;
  spo2_avg: number | null;
  spo2_low: number | null;
  respiration_avg: number | null;
  respiration_sleep: number | null;
  intensity_minutes: number | null;
  sleep_seconds: number | null;
  deep_sleep_seconds: number | null;
  light_sleep_seconds: number | null;
  rem_sleep_seconds: number | null;
  awake_sleep_seconds: number | null;
  sleep_score: number | null;
  hrv_last_night: number | null;
  hrv_weekly_avg: number | null;
  hrv_5min_high: number | null;
  hrv_status: string | null;
  training_status: string | null;
  training_readiness: number | null;
  vo2_max: number | null;
  fitness_age: number | null;
}

export interface GarminActivity {
  activity_id: string;
  date: string;
  type: string;
  name: string;
  duration_seconds: number;
  distance_m: number | null;
  calories: number | null;
  average_hr: number | null;
  max_hr: number | null;
  elevation_gain: number | null;
  training_effect: number | null;
  anaerobic_training_effect: number | null;
}

export interface GarminDashboard {
  authenticated: boolean;
  account_profile_id: string | null;
  last_sync_at: string | null;
  last_sync_error: string | null;
  syncing: boolean;
  latest: GarminDailyPoint | null;
  trends: GarminDailyPoint[];
  activities: GarminActivity[];
  activity_summary: { count: number; duration_seconds: number };
  activity_by_date: Array<{ date: string; count: number; duration_seconds: number }>;
  activity_by_type: Array<{ type: string; count: number; duration_seconds: number }>;
  /** Everything stored for the profile, whatever range was requested. */
  totals: { days: number; activities: number; first_date: string | null; last_date: string | null };
}

export interface InsightEvidence {
  id: string;
  kind: "measurement" | "finding";
  report_id: string;
  year: number;
  exam_date: string | null;
  page: number;
  title: string;
  value: string | null;
  reference: string | null;
  status: HealthStatus;
}

export interface AiInsight {
  id: string;
  profile_id: string;
  dimension: "comprehensive" | "annual" | "trend" | "organ" | "custom";
  year_from: number | null;
  year_to: number | null;
  question: string | null;
  model: string;
  summary: string;
  created_at: string;
  content: {
    summary: string;
    highlights: Array<{ title: string; explanation: string; level: "observation" | "attention" | "important"; evidence_ids: string[] }>;
    limitations: string[];
    doctor_questions: string[];
  };
  evidence: InsightEvidence[];
  /** A report was added or changed since this analysis. */
  stale: boolean;
}
