"use client";

import { ArrowClockwise, CaretDown, CaretUp, CheckCircle, ClipboardText, DownloadSimple, FloppyDisk, PlugsConnected, ShieldCheck, SignOut, Trash, WarningOctagon, Watch, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiFetch, apiUrl, isAbortError } from "@/lib/api";
import { BASE_PATH } from "@/lib/base-path";
import type { AiModelList, AiProvider, AiProviderInfo, AiSettings, GarminActive, GarminDashboard, GarminDiagnostics, GarminMfaPrompt, GarminSettings } from "@/lib/types";
import { useProfiles } from "@/components/ProfileProvider";
import { UpdateSettingsRow } from "@/components/UpdateSettingsRow";

const DEFAULT_SETTINGS: AiSettings = { provider: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com", model: "", has_api_key: false, enabled: false, updated_at: null };
const DEFAULT_GARMIN: GarminSettings = { email: "", region: "global", profile_id: null, authenticated: false, display_name: null, last_sync_at: null, last_sync_error: null, syncing: false, updated_at: null, mfa: null, running: null };
/**
 * Ceiling for one login action. The backend bounds a whole login attempt
 * (sign-in, verification code, ticket redemption, token exchange) to 60 s, so
 * this sits above it: the request must not be cut off while the backend is still
 * working, which is what produced a "network timeout" report for a login that
 * was merely slow. The backend is the one that knows which hop stopped
 * answering, so it must always be the one to answer.
 */
const GARMIN_ACTION_TIMEOUT_MS = 90_000;
/**
 * A first sync walks 30 days of Garmin endpoints and is allowed to take minutes;
 * a login is interactive and must answer quickly. They get separate ceilings so
 * a long sync is never mistaken for a hung login.
 */
const GARMIN_SYNC_TIMEOUT_MS = 300_000;
/** Reading the current settings must never be able to hang a caller forever. */
const GARMIN_READ_TIMEOUT_MS = 8_000;

const garminRequestInit = (init: RequestInit = {}, timeoutMs = GARMIN_ACTION_TIMEOUT_MS): RequestInit => ({ ...init, signal: AbortSignal.timeout(timeoutMs) });
const isGarminTimeout = isAbortError;

/**
 * A request that ran out of time is not proof of failure: the backend may have
 * finished anyway, or parked the login waiting for a code. Ask what actually
 * happened before reporting an error.
 *
 * The read itself is bounded: an unbounded one used to be able to hang
 * `adoptGarminState`, which in turn left the button stuck on "正在登录…" with no
 * error ever shown - the literal "登录没有任何反应".
 */
const readGarminState = async (): Promise<GarminSettings | null> => {
  try { return await apiFetch<GarminSettings>("/garmin/settings", { signal: AbortSignal.timeout(GARMIN_READ_TIMEOUT_MS) }); }
  catch { return null; }
};

/**
 * The backend's own view of what it is doing, and what it has done.
 *
 * Two problems this solves. First, the request log only records *finished*
 * actions, so a stalled one used to leave the panel empty - indistinguishable
 * from "no request was ever sent". `active` covers the in-flight case. Second,
 * the page used to render the cached copy of this log, which is only filled when
 * the panel is opened by hand; every export therefore said "（无记录）" no matter
 * what the backend held.
 */
const readDiagnosticLog = async (): Promise<GarminDiagnostics | null> => {
  try { return await apiFetch<GarminDiagnostics>("/garmin/diagnostics", { signal: AbortSignal.timeout(GARMIN_READ_TIMEOUT_MS) }); }
  catch { return null; }
};

const readGarminProgress = async (): Promise<GarminActive | null> => (await readDiagnosticLog())?.active ?? null;

const garminActionError = (reason: unknown, fallback: string): string => {
  if (isGarminTimeout(reason)) {
    return "等待本地服务响应超时（90 秒）。后端本身最多 60 秒就会给出结论，所以这通常意味着本地服务被其它任务占住或已经重启——请刷新本页重试；若反复出现，请点「复制诊断信息」并把它发出来。";
  }
  return reason instanceof Error && reason.message ? reason.message : fallback;
};

/**
 * Everything the settings page needs to explain a failed Garmin request. The
 * stage and the HTTP status come from the plugin backend; when the request never
 * reached it (the local API is down, the plugin was reloaded) they stay null and
 * the status line says so rather than inventing a reason.
 */
interface GarminFailure {
  action: string;
  message: string;
  stage: string | null;
  hint: string | null;
  status: number | null;
  at: string;
}

const describeGarminFailure = (reason: unknown, action: string, fallback: string, elapsedMs: number): GarminFailure => {
  const at = new Date().toISOString();
  if (isAbortError(reason)) {
    return {
      action, at, stage: null, status: null,
      message: `${action}超过 ${Math.round(elapsedMs / 1000)} 秒仍未返回，已停止等待。`,
      hint: "插件仍可能在后台完成任务，可点击「查看请求记录」查看真实结果，或稍后刷新本页。",
    };
  }
  if (reason instanceof ApiError) {
    return { action, at, message: reason.message, stage: reason.stage, hint: reason.hint, status: reason.status };
  }
  const message = reason instanceof Error && reason.message ? reason.message : fallback;
  return { action, at, message, stage: null, status: null, hint: "本地服务可能已重启或插件已重载，请重新打开健康口袋后再试。" };
};

const formatStamp = (value: string | null): string => {
  if (!value) return "尚未同步";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
};

export default function SettingsPage() {
  const { activeProfileId } = useProfiles();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [ai, setAi] = useState<AiSettings>(DEFAULT_SETTINGS);
  const [providers, setProviders] = useState<AiProviderInfo[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [modelWarning, setModelWarning] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [garmin, setGarmin] = useState<GarminSettings>(DEFAULT_GARMIN);
  const [garminPassword, setGarminPassword] = useState("");
  const [garminSaving, setGarminSaving] = useState(false);
  const [garminSyncing, setGarminSyncing] = useState(false);
  /** Shown inside the Garmin card, next to the buttons that caused it. */
  const [garminFailure, setGarminFailure] = useState<GarminFailure | null>(null);
  const [garminNotice, setGarminNotice] = useState("");
  const [garminBusy, setGarminBusy] = useState<"login" | "sync" | null>(null);
  const [garminElapsed, setGarminElapsed] = useState(0);
  /** What the backend says it is doing right now, refreshed while an action runs. */
  const [garminProgress, setGarminProgress] = useState<GarminActive | null>(null);
  const [diagnostics, setDiagnostics] = useState<GarminDiagnostics | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mfa, setMfa] = useState<GarminMfaPrompt | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaMethod, setMfaMethod] = useState<"email" | "sms">("email");
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState("");
  const [mfaNotice, setMfaNotice] = useState("");
  const [mfaRemaining, setMfaRemaining] = useState("");
  // A few embedded webviews refuse `showModal()`. The prompt must never vanish
  // silently, so fall back to a floating dialog instead of losing it.
  const [mfaDialogFloating, setMfaDialogFloating] = useState(false);
  const mfaDialog = useRef<HTMLDialogElement>(null);
  const mfaInlineInput = useRef<HTMLInputElement>(null);
  const provider = useMemo(() => providers.find((item) => item.id === ai.provider), [providers, ai.provider]);
  /** The provider whose model list was asked for last; a slower earlier answer must not replace it. */
  const modelsFor = useRef("");

  const showMfaDialog = () => {
    const dialog = mfaDialog.current;
    if (!dialog || dialog.open) return;
    try { dialog.showModal(); }
    catch { setMfaDialogFloating(true); dialog.setAttribute("open", ""); }
  };

  const openMfa = (prompt: GarminMfaPrompt) => {
    setMfa(prompt);
    setMfaCode("");
    setMfaMethod(prompt.method);
    setMfaError("");
    setMfaNotice("");
    showMfaDialog();
  };

  // Dismissing the dialog only hides it: the parked Garmin login stays alive, so
  // the code can still be entered from the panel inside the Garmin section.
  const closeMfaDialog = () => {
    const dialog = mfaDialog.current;
    if (dialog?.open) dialog.close();
    else dialog?.removeAttribute("open");
    setMfaDialogFloating(false);
  };

  /**
   * Reloads the Garmin half of the page. Kept separate from the AI settings so a
   * failure here never blanks the rest of the form, and so a login can refresh
   * its own status without refetching everything.
   */
  const refreshGarmin = async (): Promise<GarminSettings | null> => {
    const current = await readGarminState();
    if (!current) { setError("无法读取 Garmin 设置：本地服务没有响应，请重新打开健康口袋。"); return null; }
    setGarmin(current);
    // A reloaded page can still have a login waiting on Garmin's code step.
    if (current.mfa?.required) openMfa(current.mfa);
    return current;
  };

  useEffect(() => {
    Promise.all([apiFetch<AiSettings>("/ai/settings"), apiFetch<AiProviderInfo[]>("/ai/providers")])
      .then(([saved, list]) => {
        setAi(saved); setProviders(list); setModels(saved.model ? [saved.model] : []);
        if (list.some((item) => item.id === saved.provider && !item.custom_base_url)) void loadModels(saved);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取设置"));
    void refreshGarmin();
  }, []);

  // While a login or a sync is in flight, show how long it has been running.
  // Without this the card looks frozen for the full timeout, which is the other
  // half of "登录没有任何反应".
  useEffect(() => {
    if (!garminBusy) { setGarminElapsed(0); setGarminProgress(null); return; }
    const startedAt = Date.now();
    setGarminElapsed(0);
    setGarminProgress(null);
    const timer = window.setInterval(() => setGarminElapsed(Math.round((Date.now() - startedAt) / 1000)), 500);
    // Ask the backend what it is doing. A slow step then shows its own name
    // ("正在提交账号密码") instead of a bare spinner, and the same poll is what
    // lets a client-side timeout report the stage the backend is stuck on.
    const poll = window.setInterval(() => { void readGarminProgress().then(setGarminProgress); }, 2_000);
    void readGarminProgress().then(setGarminProgress);
    return () => { window.clearInterval(timer); window.clearInterval(poll); };
  }, [garminBusy]);

  const loadDiagnostics = async () => {
    setDiagnostics(await readDiagnosticLog() ?? { entries: [], requests: [], active: null, last_failure: null, limit: 0 });
  };

  /**
   * Live progress for the request-log panel. The polled value is fresher than
   * the loaded log, which only refreshes when the panel is opened or refreshed by
   * hand - the same reason an export used to say "（无记录）".
   */
  const liveActive = garminProgress ?? diagnostics?.active ?? null;

  const toggleDiagnostics = () => {
    const next = !showDiagnostics;
    setShowDiagnostics(next);
    if (next) void loadDiagnostics();
  };

  /**
   * Copies everything needed to explain a failure, so it can be pasted somewhere
   * useful. Deliberately excludes the password and the OAuth tokens: those live
   * in Obsidian's secret storage and never reach the settings API.
   */
  const copyGarminDiagnostics = async () => {
    // Read the backend's log now rather than reusing the cached copy: the cache
    // is only filled when the panel is opened by hand, so exporting after a
    // failure reported "（无记录）" even when the backend had entries - which is
    // exactly the wrong answer for someone trying to report a bug.
    const live = await readDiagnosticLog();
    const state = await readGarminState();
    if (live) setDiagnostics(live);
    if (state) setGarmin(state);
    const current = state ?? garmin;
    const entries = live?.entries ?? diagnostics?.entries ?? [];
    const requests = live?.requests ?? diagnostics?.requests ?? [];
    const progress = live?.active ?? garminProgress;
    const lines = [
      `# 健康口袋 · Garmin 诊断信息`,
      `导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      ``,
      `账号区域：${current.region === "cn" ? "中国区（garmin.cn）" : "全球区（garmin.com）"}`,
      `登录邮箱：${current.email || "（未填写）"}`,
      `已登录：${current.authenticated ? "是" : "否"}`,
      `当前档案：${activeProfileId || "（未选择）"}`,
      `上次同步：${formatStamp(current.last_sync_at)}`,
      `上次同步错误：${current.last_sync_error || "无"}`,
      `等待验证码：${(state ?? garmin).mfa?.required ? `是（发送至 ${(state ?? garmin).mfa?.target || "账号绑定邮箱或手机"}）` : "否"}`,
      `后端正在执行：${progress ? `${progress.action} · ${progress.stage} · 本步 ${Math.round((progress.stage_elapsed_ms ?? progress.elapsed_ms) / 1000)} 秒 / 共 ${Math.round(progress.elapsed_ms / 1000)} 秒` : "无"}`,
      `请求通道：${live?.queue ? `进行中 ${live.queue.garmin_active} 个 · 等待 ${live.queue.waiting} 个 · 停滞放行 ${live.queue.garmin_stalls} 次` : "（未读取到）"}`,
      ``,
    ];
    if (garminFailure) {
      lines.push(`## 最近一次失败`, `操作：${garminFailure.action}`, `阶段：${garminFailure.stage || "未知"}`,
        `HTTP：${garminFailure.status ?? "无响应"}`, `时间：${formatStamp(garminFailure.at)}`,
        `消息：${garminFailure.message}`, `建议：${garminFailure.hint || "无"}`, ``);
    }
    lines.push(`## 请求记录（最新在上）`);
    if (!live && !entries.length) lines.push("（无法读取后端请求记录：本地服务没有响应）");
    else if (!entries.length) lines.push(`（后端没有任何已完成的记录${progress ? `，但仍有请求在执行中：${progress.stage}，本步已 ${Math.round((progress.stage_elapsed_ms ?? progress.elapsed_ms) / 1000)} 秒` : ""}）`);
    for (const entry of entries) {
      lines.push(`${formatStamp(entry.at)} · ${entry.action} · ${entry.stage} · ${entry.ok ? "成功" : "失败"} · ${entry.ms}ms${entry.message ? `\n    ${entry.message}` : ""}`);
    }
    // The per-hop timeline is the part that answers "卡在哪一步": an action that
    // failed at 45 s is only explainable if you can see that its first hop took
    // 300 ms and its second never came back.
    lines.push(``, `## 网络明细（最新在上）`);
    if (!requests.length) lines.push(progress ? `（本次请求还在进行中，尚未完成任何一步：${progress.stage}）` : "（无记录）");
    for (const item of requests) {
      lines.push(`${formatStamp(item.at)} · ${item.step} · ${item.status === null ? "无响应" : `HTTP ${item.status}`} · ${item.ok ? "完成" : "失败"} · ${item.ms}ms${item.error ? `\n    ${item.error}` : ""}`);
    }
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard access can be denied inside an embedded webview; hand the user
      // the text instead of silently doing nothing.
      window.prompt("自动复制被拒绝，请手动复制下面的内容：", text);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  };

  /**
   * A timed-out request is not proof of failure: the backend may have finished
   * the login after we stopped waiting, or parked it on the code step. Adopt
   * whatever the server actually reports so the user is never left with a dead
   * form while a usable session is sitting on the other side.
   */
  const adoptGarminState = async (): Promise<"authenticated" | "mfa" | "unknown"> => {
    const current = await readGarminState();
    if (!current) return "unknown";
    if (current.authenticated) {
      setGarminPassword("");
      setMfa(null); setMfaCode(""); setMfaError(""); setMfaNotice("");
      closeMfaDialog();
      setGarmin((previous) => ({ ...current, email: current.email || previous.email, region: current.email ? current.region : previous.region }));
      setMessage("Garmin Connect 已登录（等待时间较长，但已成功）");
      window.dispatchEvent(new Event("healthpocket:garmin-status"));
      return "authenticated";
    }
    if (current.mfa?.required) {
      setGarminPassword("");
      setGarmin((previous) => ({ ...current, email: current.email || previous.email, region: current.email ? current.region : previous.region }));
      openMfa(current.mfa);
      setMfaNotice("上一次请求等待超时，但 Garmin 已经发出验证码，可直接在此输入");
      return "mfa";
    }
    return "unknown";
  };

  // A parked Garmin login expires after a few minutes, so show how long the code
  // stays usable instead of letting the user discover it from a failed attempt.
  useEffect(() => {
    if (!mfa?.expires_at) { setMfaRemaining(""); return; }
    const deadline = new Date(mfa.expires_at).getTime();
    const tick = () => {
      const left = deadline - Date.now();
      if (left <= 0) { setMfaRemaining("验证码会话已过期"); return; }
      const minutes = Math.floor(left / 60_000);
      const seconds = Math.floor((left % 60_000) / 1000);
      setMfaRemaining(`剩余 ${minutes}:${String(seconds).padStart(2, "0")}`);
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [mfa?.expires_at]);

  const saveGarmin = async () => {
    setGarminSaving(true); setGarminBusy("login");
    setGarminFailure(null); setGarminNotice(""); setMessage(""); setError("");
    const startedAt = Date.now();
    try {
      const saved = await apiFetch<GarminSettings>("/garmin/settings", garminRequestInit({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: garmin.email, password: garminPassword, region: garmin.region, profile_id: activeProfileId }) }));
      setGarminPassword("");
      // Garmin asks for a verification code: keep the typed form as it is and
      // collect the code instead of reporting a failure.
      if (saved.mfa?.required) {
        setGarmin(saved);
        setGarminNotice("账号密码已通过，Garmin 已发出验证码，请在下方输入完成登录。");
        openMfa(saved.mfa);
        return;
      }
      setMfa(null); setMfaCode(""); setMfaError(""); setMfaNotice("");
      setGarmin(saved);
      setGarminNotice(`已登录 Garmin Connect${saved.display_name ? `（${saved.display_name}）` : ""}。数据不会自动下载，需要时点「手动同步」。`);
      window.dispatchEvent(new Event("healthpocket:garmin-status"));
      void loadDiagnostics();
    } catch (reason) {
      // A timeout is not proof of failure: ask the backend what actually happened
      // before reporting anything, so a slow-but-successful login is not lost.
      const elapsedMs = Date.now() - startedAt;
      if (isGarminTimeout(reason)) {
        const state = await adoptGarminState();
        if (state === "authenticated") { void loadDiagnostics(); return; }
        if (state === "mfa") { setGarminNotice("请求等待超时，但 Garmin 已经发出验证码，请继续在下方输入。"); void loadDiagnostics(); return; }
        // The client stopped waiting but the backend is still working: name the
        // step it is on. A bare "超时" is useless for reporting a bug, while
        // "卡在提交账号密码" immediately says whether the request even left.
        const progress = await readGarminProgress();
        if (progress) {
          setGarminFailure({
            action: "登录 Garmin", at: new Date().toISOString(), stage: progress.stage, status: null,
            message: `前端已停止等待（${Math.round(elapsedMs / 1000)} 秒），但插件后端仍在执行「${progress.stage}」，已 ${Math.round(progress.elapsed_ms / 1000)} 秒。`,
            hint: "这说明请求确实发出去了，卡在了这一步。请把这份诊断信息发出来；也可以稍后刷新本页看是否已经完成。",
          });
          void loadDiagnostics();
          return;
        }
      }
      setGarminFailure(describeGarminFailure(reason, "登录 Garmin", "Garmin 登录失败", elapsedMs));
      void loadDiagnostics();
    }
    finally { setGarminSaving(false); setGarminBusy(null); }
  };

  /**
   * Downloads Garmin data. Deliberately separate from the login button: signing
   * in and pulling 30 days of history fail for different reasons and take wildly
   * different amounts of time, so they get their own button, ceiling and error.
   */
  const syncGarmin = async () => {
    setGarminSyncing(true); setGarminBusy("sync");
    setGarminFailure(null); setGarminNotice(""); setMessage(""); setError("");
    const startedAt = Date.now();
    try {
      const result = await apiFetch<GarminDashboard & { synced_days: number; synced_activities: number }>(
        "/garmin/sync",
        garminRequestInit({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile_id: activeProfileId }) }, GARMIN_SYNC_TIMEOUT_MS),
      );
      setGarminNotice(`同步完成：${result.synced_days} 天日常数据、${result.synced_activities} 条运动记录。`);
      await refreshGarmin();
      window.dispatchEvent(new Event("healthpocket:garmin-status"));
      void loadDiagnostics();
    } catch (reason) {
      const elapsedMs = Date.now() - startedAt;
      if (isGarminTimeout(reason)) {
        const progress = await readGarminProgress();
        if (progress) {
          setGarminFailure({
            action: "同步 Garmin 数据", at: new Date().toISOString(), stage: progress.stage, status: null,
            message: `前端已停止等待（${Math.round(elapsedMs / 1000)} 秒），但插件后端仍在执行「${progress.stage}」，已 ${Math.round(progress.elapsed_ms / 1000)} 秒。`,
            hint: "首次同步要拉取 30 天数据，耗时较长属正常；若长时间停在同一阶段，请把这份诊断信息发出来。",
          });
          void loadDiagnostics();
          return;
        }
      }
      setGarminFailure(describeGarminFailure(reason, "同步 Garmin 数据", "Garmin 同步失败", elapsedMs));
      // The backend records the failure on the settings row; read it back so the
      // card shows the same message the next time the page is opened.
      await refreshGarmin();
      void loadDiagnostics();
    }
    finally { setGarminSyncing(false); setGarminBusy(null); }
  };

  // An expired parked session cannot be retried, so clear the prompt and send the
  // user back to the login form instead of leaving a dead input box behind.
  const failMfa = (reason: unknown, fallback: string) => {
    const text = garminActionError(reason, fallback);
    // The dialog repeats the message, but the card keeps the full detail (stage,
    // HTTP status, hint) so a failure is still readable after the dialog closes.
    setGarminFailure(describeGarminFailure(reason, "校验验证码", fallback, 0));
    void loadDiagnostics();
    if (text.includes("会话已过期")) {
      closeMfaDialog();
      setMfa(null); setMfaCode(""); setMfaNotice("");
      setError(text);
    } else setMfaError(text);
  };

  const verifyMfa = async (event: React.FormEvent) => {
    event.preventDefault();
    setMfaBusy(true); setMfaError(""); setMfaNotice(""); setGarminFailure(null); setGarminNotice("");
    try {
      const saved = await apiFetch<GarminSettings>("/garmin/settings/mfa", garminRequestInit({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: mfaCode, method: mfaMethod }) }));
      closeMfaDialog();
      setMfa(null); setMfaCode("");
      setGarmin((current) => ({ ...saved, email: saved.email || current.email, region: saved.email ? saved.region : current.region }));
      setGarminNotice("已登录 Garmin Connect。数据不会自动下载，需要时点「手动同步」。");
      window.dispatchEvent(new Event("healthpocket:garmin-status"));
      void loadDiagnostics();
    } catch (reason) {
      if (isGarminTimeout(reason)) {
        const state = await adoptGarminState();
        if (state === "authenticated") return;
        if (state === "mfa") { setMfaError(garminActionError(reason, "验证码校验失败")); return; }
      }
      failMfa(reason, "验证码校验失败");
    }
    finally { setMfaBusy(false); }
  };

  const resendMfa = async () => {
    setMfaBusy(true); setMfaError(""); setMfaNotice(""); setGarminFailure(null);
    try {
      const saved = await apiFetch<GarminSettings>("/garmin/settings/mfa/resend", garminRequestInit({ method: "POST" }));
      if (saved.mfa?.required) { setMfa(saved.mfa); setMfaMethod(saved.mfa.method); setMfaCode(""); setMfaNotice("已请求 Garmin 重新发送验证码，请查收最新一封"); setGarminNotice("已请求 Garmin 重新发送验证码，请查收最新一封邮件。") }
      else { closeMfaDialog(); setMfa(null); setGarmin(saved); setGarminNotice("已登录 Garmin Connect。数据不会自动下载，需要时点「手动同步」。"); window.dispatchEvent(new Event("healthpocket:garmin-status")); }
      void loadDiagnostics();
    } catch (reason) {
      if (isGarminTimeout(reason)) {
        const state = await adoptGarminState();
        if (state === "authenticated") return;
        if (state === "mfa") { setMfaNotice("上一次请求等待超时；若仍未收到新验证码，可再次点击「重新发送验证码」"); return; }
      }
      failMfa(reason, "重新发送验证码失败");
    }
    finally { setMfaBusy(false); }
  };

  /** Abandons the parked login entirely, so no server-side session is left behind. */
  const dismissMfaLogin = () => {
    closeMfaDialog();
    setMfa(null); setMfaCode(""); setMfaError(""); setMfaNotice("");
    void apiFetch<GarminSettings>("/garmin/settings/mfa", { method: "DELETE" }).catch(() => undefined);
  };

  /** Focuses the code box once the login is parked on the verification step. */
  useEffect(() => {
    if (!mfa?.required) return;
    const timer = window.setTimeout(() => {
      if (!mfaDialog.current?.open) mfaInlineInput.current?.focus();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [mfa?.required, mfa?.expires_at]);

  const disconnectGarmin = async () => {
    setGarminSaving(true); setMessage(""); setError("");
    setGarminFailure(null); setGarminNotice("");
    try {
      const saved = await apiFetch<GarminSettings>("/garmin/settings", { method: "DELETE" });
      setGarmin(saved); setGarminPassword(""); setGarminNotice("已断开 Garmin Connect，已同步的本地健康数据仍会保留。");
      window.dispatchEvent(new Event("healthpocket:garmin-status"));
    } catch (reason) {
      setGarminFailure(describeGarminFailure(reason, "断开 Garmin 连接", "断开连接失败", 0));
    }
    finally { setGarminSaving(false); }
  };

  const exportData = async () => {
    try {
      const response = await fetch(apiUrl('/exports'), { method: 'POST' });
      if (!response.ok) { const body = await response.json(); throw new Error(body.detail || '导出失败'); }
      const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'healthpocket-export.zip'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setError(''); setMessage('完整备份已生成');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '导出失败'); }
  };

  const loadModels = async (target: AiSettings = ai) => {
    modelsFor.current = target.provider;
    setLoadingModels(true); setModelWarning("");
    try {
      const result = await apiFetch<AiModelList>("/ai/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: target.provider, base_url: target.base_url, api_key: apiKey }) });
      if (modelsFor.current !== target.provider) return;
      setModels(result.models); setModelWarning(result.warning ?? "");
      setAi((current) => current.provider === target.provider && !current.model ? { ...current, model: result.models[0] ?? "" } : current);
    } catch (reason) {
      if (modelsFor.current === target.provider) setModelWarning(reason instanceof Error ? reason.message : "模型列表获取失败");
    }
    finally { if (modelsFor.current === target.provider) setLoadingModels(false); }
  };

  const saveAi = async () => {
    setSaving(true); setMessage(""); setError("");
    try {
      const saved = await apiFetch<AiSettings>("/ai/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: ai.provider, model: ai.model.trim(), api_key: apiKey, base_url: ai.base_url }) });
      setAi(saved); setApiKey(""); setMessage("AI 模型配置已保存"); return saved;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); throw reason; }
    finally { setSaving(false); }
  };

  const testAi = async () => {
    setTesting(true); setMessage(""); setError("");
    try { await saveAi(); await apiFetch<{ ok: boolean }>("/ai/test", { method: "POST" }); setMessage("连接成功，模型可以正常响应"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "连接测试失败"); }
    finally { setTesting(false); }
  };

  const clearKey = async () => {
    setSaving(true); setError("");
    try {
      const saved = await apiFetch<AiSettings>("/ai/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: ai.provider, model: ai.model.trim(), base_url: ai.base_url, clear_api_key: true }) });
      setAi(saved); setApiKey(""); setMessage("API Key 已从 Obsidian 安全存储中移除");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "移除失败"); }
    finally { setSaving(false); }
  };

  const wipe = async () => {
    if (!window.confirm("永久删除本机中的全部报告、指标和解析结果？请先导出备份。")) return;
    if (!window.confirm("最后确认：此操作无法撤销。")) return;
    try { await apiFetch("/data", { method: "DELETE" }); setMessage("全部健康数据已删除"); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); }
  };

  const providerChanged = (id: AiProvider) => {
    const next = providers.find((item) => item.id === id);
    const target = { ...DEFAULT_SETTINGS, provider: id, name: next?.name ?? id, base_url: next?.base_url ?? "" };
    setAi(target); setApiKey(""); setModels([]); setModelWarning(""); setMessage(""); setError("");
    // Catalog providers list their models without a key; custom endpoints wait for an address.
    if (next && !next.custom_base_url) void loadModels(target);
  };

  const needsKey = provider?.requires_api_key ?? true;
  const needsAddress = ai.provider === "custom";
  const canFetch = !needsAddress || Boolean(ai.base_url.trim());
  const canSave = Boolean(ai.model.trim() && (!needsKey || apiKey || ai.has_api_key) && canFetch);
  const featuredProviders = providers.filter((item) => item.featured);
  const moreProviders = providers.filter((item) => !item.featured);
  const mfaOptions: Array<{ value: "email" | "sms"; label: string }> = [];
  if (mfa?.target) mfaOptions.push({ value: "email", label: `邮箱 ${mfa.target}` });
  if (mfa?.masked_phone) mfaOptions.push({ value: "sms", label: `短信 ${mfa.masked_phone}` });

  return (
    <>
      <header className="page-header"><div><h1 className="page-title">设置</h1><p className="page-subtitle">管理 AI 模型、本地数据、备份和解析版本。</p></div></header>
      {message && <div className="notice">{message}</div>}{error && <div className="error">{error}</div>}
      {garmin.feature_enabled === false ? (
      <section className="ai-settings panel garmin-settings">
        <div className="ai-settings-head"><div><span className="eyebrow"><Watch /> Garmin Connect · 实验性</span><h2>Garmin 同步未开启</h2><p>该功能模拟 Garmin Connect 手机 App 的非公开接口，不是 Garmin 官方产品，可能违反 Garmin 服务条款，接口也可能随时失效。如需使用，请在 Obsidian 设置 → 第三方插件 → HealthPocket 中开启，然后重新打开本页面。</p></div></div>
      </section>
      ) : (
      <section className="ai-settings panel garmin-settings">
        <div className="ai-settings-head"><div><span className="eyebrow"><Watch /> Garmin Connect</span><h2>连接佳明账号</h2><p>登录后可在“日常健康”查看 HRV、睡眠、身体年龄和运动数据。账号密码与 OAuth 令牌保存在 Obsidian 安全存储中，不写入健康数据库或导出文件。</p></div>{garmin.authenticated && <span className="status status-normal"><CheckCircle /> {garmin.display_name || "已登录"}</span>}</div>
        <div className="ai-setup-steps">
          <label className="ai-setup-step"><span className="step-number">1</span><span className="step-label">账号区域</span><select className="select" value={garmin.region} onChange={(event) => setGarmin({ ...garmin, region: event.target.value as "global" | "cn" })}><option value="global">全球区（garmin.com）</option><option value="cn">中国区（garmin.cn）</option></select></label>
          <label className="ai-setup-step"><span className="step-number">2</span><span className="step-label">Garmin 邮箱</span><input className="text-input" type="email" autoComplete="username" value={garmin.email} onChange={(event) => setGarmin({ ...garmin, email: event.target.value })} placeholder="you@example.com" /></label>
          <label className="ai-setup-step"><span className="step-number">3</span><span className="step-label">账号密码 <small>仅用于本次登录，不会保存</small></span><input className="text-input" type="password" autoComplete="current-password" value={garminPassword} onChange={(event) => setGarminPassword(event.target.value)} placeholder="输入 Garmin 密码" /></label>
        </div>
        <div className="ai-form-note">登录只负责登录，不会下载任何数据。需要数据时点「手动同步」：首次同步拉取最近 30 天的日常快照和运动记录，之后每次重叠更新最近 3 天，避免漏掉设备延迟上传的数据。开启了两步验证的账号会在登录后弹出验证码输入框，验证码由 Garmin 发送到账号绑定的邮箱或手机。</div>
        <div className="ai-form-actions">
          {garmin.authenticated && <button className="button button-danger" onClick={() => void disconnectGarmin()} disabled={garminSaving || garminSyncing}><SignOut /> 断开连接</button>}
          <button className="button button-primary" onClick={() => void saveGarmin()} disabled={garminSaving || garminSyncing || !garmin.email || !garminPassword}>
            <PlugsConnected /> {garminSaving ? `正在登录…${garminProgress ? `（${garminProgress.stage}）` : ""}${garminElapsed >= 3 ? ` 已 ${garminElapsed} 秒` : ""}` : garmin.authenticated ? "重新登录" : "登录 Garmin"}
          </button>
          {garmin.authenticated && (
            <button className="button" onClick={() => void syncGarmin()} disabled={garminSyncing || garminSaving}>
              <ArrowClockwise className={garminSyncing ? "batch-spinner" : ""} /> {garminSyncing ? `正在同步…${garminProgress ? `（${garminProgress.stage}）` : ""}${garminElapsed >= 3 ? ` 已 ${garminElapsed} 秒` : ""}` : "手动同步"}
            </button>
          )}
        </div>
        {garminBusy && (
          <div className="garmin-progress" role="status">
            <ArrowClockwise className="batch-spinner" />
            <span>{garminProgress ? `正在执行：${garminProgress.action} · ${garminProgress.stage}` : "已把请求交给本地服务，正在等待它回话…"}</span>
            {garminElapsed >= 1 && <span className="muted">已 {garminElapsed} 秒</span>}
          </div>
        )}
        {garmin.authenticated && (
          <div className="garmin-sync-meta">
            <span>上次同步：{formatStamp(garmin.last_sync_at)}</span>
            {garmin.last_sync_error && <span className="muted">上次同步失败：{garmin.last_sync_error}</span>}
          </div>
        )}
        {garminNotice && <div className="notice garmin-inline-notice"><CheckCircle /> {garminNotice}</div>}
        {garminFailure && (
          <div className="garmin-failure" role="alert">
            <div className="garmin-failure-head">
              <WarningOctagon size={18} />
              <div>
                <strong>{garminFailure.action}失败</strong>
                <p className="garmin-failure-meta">
                  {garminFailure.stage ? <>阶段：<b>{garminFailure.stage}</b> · </> : null}
                  {garminFailure.status ? <>HTTP <b>{garminFailure.status}</b> · </> : <>未收到服务端响应 · </>}
                  {formatStamp(garminFailure.at)}
                </p>
              </div>
            </div>
            <p className="garmin-failure-message">{garminFailure.message}</p>
            {garminFailure.hint && <p className="garmin-failure-hint">建议：{garminFailure.hint}</p>}
            <div className="garmin-failure-actions">
              <button type="button" className="button" onClick={() => void copyGarminDiagnostics()}>
                <ClipboardText /> {copied ? "已复制" : "复制诊断信息"}
              </button>
              <button type="button" className="button" onClick={toggleDiagnostics}>
                {showDiagnostics ? <CaretUp /> : <CaretDown />} {showDiagnostics ? "收起请求记录" : "查看请求记录"}
              </button>
            </div>
          </div>
        )}
        {!garminFailure && (
          <div className="garmin-failure-actions garmin-diagnostics-toggle">
            <button type="button" className="button" onClick={toggleDiagnostics}>
              {showDiagnostics ? <CaretUp /> : <CaretDown />} {showDiagnostics ? "收起请求记录" : "查看 Garmin 请求记录"}
            </button>
          </div>
        )}
        {showDiagnostics && (
          <div className="garmin-diagnostics">
            <div className="garmin-diagnostics-head">
              <strong>Garmin 请求记录</strong>
              <span className="muted">最新在上，最多保留 {diagnostics?.limit || 20} 条；不包含密码或令牌。</span>
              <button type="button" className="button button-icon" aria-label="复制诊断信息" onClick={() => void copyGarminDiagnostics()}><ClipboardText /></button>
              <button type="button" className="button button-icon" aria-label="刷新" onClick={() => void loadDiagnostics()}><ArrowClockwise /></button>
            </div>
            {liveActive && (
              <p className="garmin-diagnostics-active">
                正在执行：<b>{liveActive.action}</b> · {liveActive.stage} · 本步已 {Math.round((liveActive.stage_elapsed_ms ?? liveActive.elapsed_ms) / 1000)} 秒 · 共 {Math.round(liveActive.elapsed_ms / 1000)} 秒
                <span className="muted">（请求已发出，还没有结果）</span>
              </p>
            )}
            {(!diagnostics || diagnostics.entries.length === 0) && (
              <p className="muted">
                {liveActive
                  ? "尚未有任何已完成的结果；上面那一步正在进行中。"
                  : "还没有发起过 Garmin 请求。点击「登录 Garmin」或「手动同步」后，这里会记录每一步的结果。"}
              </p>
            )}
            {diagnostics && diagnostics.entries.length > 0 && (
              <ol className="garmin-diagnostics-list">
                {diagnostics.entries.map((entry, index) => (
                  <li key={`${entry.at}-${index}`} className={entry.ok ? "ok" : "fail"}>
                    <span className="garmin-diagnostics-time">{formatStamp(entry.at)}</span>
                    <span className="garmin-diagnostics-action">{entry.action}</span>
                    <span className="garmin-diagnostics-stage">{entry.stage}</span>
                    <span className="garmin-diagnostics-verdict">{entry.ok ? "成功" : "失败"} · {Math.round(entry.ms / 100) / 10}s</span>
                    {entry.message && <p>{entry.message}</p>}
                  </li>
                ))}
              </ol>
            )}
            {(diagnostics?.requests?.length ?? 0) > 0 && (
              <>
                {/* The action list says a login failed; this says how far it got.
                    A stalled login is only diagnosable from the hop that never
                    came back, so it belongs in the same panel. */}
                <p className="garmin-requests-head">每一步的网络明细（最新在上）</p>
                <ol className="garmin-diagnostics-list garmin-requests-list">
                  {(diagnostics?.requests ?? []).map((item, index) => (
                    <li key={`${item.at}-${item.step}-${index}`} className={item.ok ? "ok" : "fail"}>
                      <span className="garmin-diagnostics-time">{formatStamp(item.at)}</span>
                      <span className="garmin-diagnostics-action">{item.step}</span>
                      <span className="garmin-diagnostics-stage">{item.status === null ? "无响应" : `HTTP ${item.status}`}</span>
                      <span className="garmin-diagnostics-verdict">{item.ok ? "完成" : "失败"} · {Math.round(item.ms / 100) / 10}s</span>
                      {item.error && <p>{item.error}</p>}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        )}
        {mfa?.required && (
          <div className="garmin-mfa-panel" role="status">
            <div className="garmin-mfa-head">
              <ShieldCheck size={18} />
              <div>
                <strong>Garmin 需要验证码才能完成登录</strong>
                <p>
                  {mfa.target
                    ? <>验证码已由 Garmin 发送到 <strong>{mfa.target}</strong>（{mfa.method === "sms" ? "短信" : "邮箱"}）。</>
                    : <>验证码已由 Garmin 发送到账号绑定的邮箱或手机。</>}
                  请在下方输入框填入，验证码一次性有效。
                </p>
              </div>
            </div>
            <form className="garmin-mfa-form" onSubmit={(event) => void verifyMfa(event)}>
              {mfaOptions.length > 1 && (
                <label><span>接收方式</span><select value={mfaMethod} onChange={(event) => setMfaMethod(event.target.value as "email" | "sms")}>{mfaOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              )}
              <label>
                <span>验证码{mfaRemaining && <small>{mfaRemaining}</small>}</span>
                <input
                  ref={mfaInlineInput}
                  className="garmin-mfa-code"
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={8}
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, ""))}
                  placeholder="请输入 Garmin 发来的 4–8 位数字"
                />
              </label>
              {mfaNotice && <p className="muted garmin-mfa-notice">{mfaNotice}</p>}
              {mfaError && <div className="error">{mfaError}</div>}
              <div className="garmin-mfa-actions">
                <button type="button" className="button" disabled={mfaBusy} onClick={() => void resendMfa()}>{mfaBusy ? "正在请求…" : "重新发送验证码"}</button>
                <button type="button" className="button" disabled={mfaBusy} onClick={closeMfaDialog}>换个窗口输入</button>
                <button type="button" className="button" disabled={mfaBusy} onClick={dismissMfaLogin}>取消本次登录</button>
                <button className="button button-primary" disabled={mfaBusy || mfaCode.length < 4}>{mfaBusy ? "正在验证…" : "完成登录"}</button>
              </div>
            </form>
          </div>
        )}
      </section>
      )}
      <section className="ai-settings panel">
        <div className="ai-settings-head"><div><span className="eyebrow">AI 模型</span><h2>三步完成连接</h2><p>供应商和模型列表来自开源的 Models.dev 目录，调用由开源的 Vercel AI SDK 完成。选择供应商，填写密钥，再选择或直接输入模型名称。</p></div>{ai.enabled && <span className="status status-normal"><CheckCircle /> 已配置</span>}</div>
        <div className="ai-setup-steps">
          <div className="ai-setup-step"><span className="step-number">1</span><span className="step-label">选择供应商</span><div className="ai-step-fields">
            <select className="select" aria-label="模型供应商" value={ai.provider} onChange={(event) => providerChanged(event.target.value)}>
              <optgroup label="常用">{featuredProviders.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</optgroup>
              {moreProviders.length > 0 && <optgroup label="更多（Models.dev 目录）">{moreProviders.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</optgroup>}
            </select>
            {provider?.custom_base_url && <input className="text-input mono" aria-label="模型服务地址" value={ai.base_url} onChange={(event) => setAi({ ...ai, base_url: event.target.value })} placeholder={needsAddress ? "服务地址，例如 https://example.com/v1" : "http://127.0.0.1:11434/v1"} />}
          </div></div>
          <label className="ai-setup-step"><span className="step-number">2</span><span className="step-label">填写 API Key {ai.has_api_key && <small>已安全保存</small>}</span><input className="text-input mono" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={needsKey ? (ai.has_api_key ? "留空使用已保存密钥" : `填写 ${provider?.name ?? "供应商"} Key`) : (needsAddress ? "如服务需要密钥请填写，否则留空" : "无需密钥，可留空")} /></label>
          <label className="ai-setup-step"><span className="step-number">3</span><span className="step-label">选择模型</span><div className="input-action"><input className="text-input mono" list="ai-model-options" value={ai.model} onChange={(event) => setAi({ ...ai, model: event.target.value })} placeholder={loadingModels ? "正在读取模型列表…" : "从列表选择，或直接输入模型名称"} /><datalist id="ai-model-options">{models.map((model) => <option value={model} key={model} />)}</datalist><button className="button" onClick={(event) => { event.preventDefault(); void loadModels(); }} disabled={loadingModels || !canFetch}><ArrowClockwise /> {loadingModels ? "读取中" : "刷新列表"}</button></div></label>
        </div>
        {provider && !provider.featured && <div className="ai-form-note">该供应商来自 Models.dev 目录，尚未在 Obsidian 中实测。如果连接失败，可能是它不允许从 Obsidian 直接访问，可以改用常用列表里的供应商或 OpenRouter。</div>}
        {modelWarning && <div className="ai-form-note">{modelWarning}</div>}
        <div className="ai-form-note">获取列表和测试连接不会发送健康数据。开始对话后，才会发送当前档案的去身份化结构化数据和你主动附加的数据文件。</div>
        <div className="ai-form-actions">{ai.has_api_key && <button className="button button-danger" onClick={() => void clearKey()} disabled={saving}>移除密钥</button>}<button className="button" onClick={() => void testAi()} disabled={testing || saving || !canSave}><PlugsConnected /> {testing ? "正在测试…" : "保存并测试"}</button><button className="button button-primary" onClick={() => void saveAi()} disabled={saving || !canSave}><FloppyDisk /> {saving ? "保存中…" : "保存配置"}</button></div>
      </section>
      <section className="settings-list">
        <div className="settings-row"><div><h2>完整数据导出</h2><p>包含原始 PDF、结构化 JSON、Garmin 健康与运动记录、指标字典和规则版本。</p></div><p>AI 密钥、Garmin 密码和 OAuth 令牌不会进入备份文件。</p><button className="button" onClick={() => void exportData()}><DownloadSimple /> 导出备份</button></div>
        <div className="settings-row"><div><h2>永久删除数据</h2><p>删除当前运行库中的 PDF、派生数据、Garmin 记录和 AI 洞察。</p></div><p>操作完成后无法恢复。账号连接设置、旧版迁移前的数据库与报告副本、已导出的备份仍保留在原位置。</p><button className="button button-danger" onClick={() => void wipe()}><Trash /> 删除全部</button></div>
        <UpdateSettingsRow />
      </section>
      <section className="section license-copy"><h2 className="section-title">开源与医学边界</h2><p>健康口袋不提供诊断或个性化医疗建议。AI 输出用于整理报告，必须结合原始证据和专业医生意见理解。</p><p>器官导航采用 Human Atlas 的 BodyParts3D 4.0 浏览器模型，模型数据采用 CC BY 4.0；原始参考体为成年男性。</p><p><a className="link" href={`${BASE_PATH}/licenses/HUMAN_ATLAS_ATTRIBUTION.md`} target="_blank">查看完整模型署名与许可</a></p></section>
      <p className="muted"><a className="link" href={`${BASE_PATH}/licenses/THIRD_PARTY_NOTICES.txt`} target="_blank" rel="noreferrer">查看内嵌软件许可</a></p>
      <dialog
        ref={mfaDialog}
        className={mfaDialogFloating ? "dialog-floating" : undefined}
        onCancel={(event) => { if (mfaBusy) event.preventDefault(); }}
        onClose={() => setMfaDialogFloating(false)}
      >
        <form onSubmit={(event) => void verifyMfa(event)}>
          <div className="dialog-head">
            <div><h2>输入 Garmin 验证码</h2><p>账号开启了两步验证，需要这一步才能完成登录</p></div>
            <button type="button" className="button button-icon" aria-label="关闭" disabled={mfaBusy} onClick={closeMfaDialog}><X /></button>
          </div>
          <div className="dialog-body profile-form">
            <div className="profile-form-intro"><ShieldCheck size={22} /><span>{mfa?.target ? <>验证码已发送到 <strong>{mfa.target}</strong>（{mfa.method === "sms" ? "短信" : "邮箱"}）。</> : <>验证码已由 Garmin 发送到你的账号绑定邮箱或手机。</>}验证码有效期较短，收到后请尽快输入；关掉这个窗口不会中断登录，仍可在设置页的输入框里填写。</span></div>
            {mfaOptions.length > 1 && (
              <label><span>接收方式</span><select value={mfaMethod} onChange={(event) => setMfaMethod(event.target.value as "email" | "sms")}>{mfaOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            )}
            <label><span>验证码{mfaRemaining && <small>{mfaRemaining}</small>}</span><input autoFocus required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={8} value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, ""))} placeholder="请输入 4–8 位数字验证码" /></label>
            {mfaNotice && <p className="muted garmin-mfa-notice">{mfaNotice}</p>}
            {mfaError && <div className="error">{mfaError}</div>}
            <div className="dialog-actions">
              <button type="button" className="button" disabled={mfaBusy} onClick={() => void resendMfa()}>重新发送验证码</button>
              <button type="button" className="button" disabled={mfaBusy} onClick={dismissMfaLogin}>取消本次登录</button>
              <button type="button" className="button" disabled={mfaBusy} onClick={closeMfaDialog}>稍后输入</button>
              <button className="button button-primary" disabled={mfaBusy || mfaCode.length < 4}>{mfaBusy ? "正在验证…" : "完成登录"}</button>
            </div>
          </div>
        </form>
      </dialog>
    </>
  );
}
