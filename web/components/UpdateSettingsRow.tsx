"use client";

import { ArrowClockwise, DownloadSimple, Power } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { UpdateInfo, UpdateStatus } from "@/lib/types";

const POLL_MS = 400;

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The "检查更新" row: shows the running version, checks for a newer release on
 * mount, downloads it with a progress bar, then waits for the user to restart.
 */
export function UpdateSettingsRow() {
  const [current, setCurrent] = useState<string | null>(null);
  const [canUpdate, setCanUpdate] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState("");
  const poll = useRef<number | null>(null);

  const stopPolling = () => {
    if (poll.current !== null) window.clearInterval(poll.current);
    poll.current = null;
  };

  const startPolling = () => {
    stopPolling();
    poll.current = window.setInterval(async () => {
      try {
        const next = await apiFetch<UpdateStatus>("/update-install");
        setStatus(next);
        if (next.phase !== "downloading") stopPolling();
      } catch { /* the next tick retries */ }
    }, POLL_MS);
  };

  const check = async () => {
    setChecking(true); setError("");
    try { setUpdate(await apiFetch<UpdateInfo>("/update-check")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "检查更新失败"); }
    finally { setChecking(false); }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await apiFetch<{ version: string | null; can_update: boolean }>("/app-info");
        if (cancelled) return;
        setCurrent(info.version); setCanUpdate(info.can_update);
        if (!info.can_update) return;
        // Pick up a download that was started before the page was left.
        const existing = await apiFetch<UpdateStatus>("/update-install");
        if (cancelled) return;
        setStatus(existing);
        if (existing.phase === "downloading") startPolling();
      } catch { /* the check below reports its own error */ }
      if (!cancelled) await check();
    })();
    return () => { cancelled = true; stopPolling(); };
  }, []);

  const download = async () => {
    setError("");
    try {
      setStatus(await apiFetch<UpdateStatus>("/update-install", { method: "POST" }));
      startPolling();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "下载失败"); }
  };

  const restart = async () => {
    setRestarting(true); setError("");
    try { await apiFetch("/update-restart", { method: "POST" }); }
    catch (reason) { setRestarting(false); setError(reason instanceof Error ? reason.message : "重启失败"); }
  };

  const phase = status?.phase ?? "idle";
  const hasUpdate = Boolean(update?.hasUpdate) || phase === "ready";
  const percent = status && status.total > 0 ? Math.min(100, Math.round((status.received / status.total) * 100)) : 0;
  const failure = error || (phase === "error" ? status?.error ?? "下载失败" : "");

  let detail: React.ReactNode;
  if (restarting) detail = "正在重启健康口袋…";
  else if (phase === "downloading") {
    detail = (
      <span className="update-progress">
        <span className="update-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></span>
        <span>正在下载 {status?.version} · {percent}%{status && status.total > 0 ? `（${megabytes(status.received)} / ${megabytes(status.total)}）` : ""}</span>
      </span>
    );
  } else if (phase === "ready") detail = `${status?.version} 已下载完成，点击“重启生效”后启用；也可以稍后重启 Obsidian。`;
  else if (failure) detail = <>{failure}{update?.hasUpdate && <> · <a className="link" href={update.releasesPage} target="_blank" rel="noreferrer">手动下载</a></>}</>;
  else if (checking) detail = "正在检查最新版本…";
  else if (update) detail = update.hasUpdate ? `发现新版本 ${update.latest}，下载后覆盖本地插件文件。` : `已是最新版本 ${update.latest}。`;
  else detail = canUpdate || current === null ? "检查 GitHub 发布页上的最新版本。" : "当前运行环境不支持检查更新。";

  let action: React.ReactNode;
  if (phase === "ready" || restarting) {
    action = <button className="button button-primary" disabled={restarting} onClick={() => void restart()}><Power /> {restarting ? "重启中…" : "重启生效"}</button>;
  } else if (phase === "downloading") {
    action = <button className="button" disabled><DownloadSimple /> 下载中…</button>;
  } else if (update?.hasUpdate && canUpdate) {
    action = <button className="button button-primary" onClick={() => void download()}><DownloadSimple /> {phase === "error" ? "重新下载" : "下载并更新"}</button>;
  } else {
    action = <button className="button" disabled={checking || !canUpdate} onClick={() => void check()}><ArrowClockwise /> {checking ? "检查中…" : "检查更新"}</button>;
  }

  return (
    <div className="settings-row">
      <div>
        <h2 className="update-title">检查更新{hasUpdate && <span className="update-dot" aria-label="有新版本" />}</h2>
        <p>当前版本 {current ?? "—"}{update?.hasUpdate ? ` · 最新版本 ${update.latest}` : ""}</p>
      </div>
      <p>{detail}</p>
      {action}
    </div>
  );
}
