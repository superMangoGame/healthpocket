"use client";

import {
  CheckCircle,
  ClockCountdown,
  FilePdf,
  SpinnerGap,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useProfiles } from "@/components/ProfileProvider";

interface UploadResult {
  report: { id: string };
  job: { id: string; status: string; progress: number; error: string | null };
}

type BatchStatus =
  | "queued"
  | "uploading"
  | "parsing"
  | "completed"
  | "partial"
  | "skipped"
  | "failed";

interface BatchItem {
  id: string;
  file: File;
  status: BatchStatus;
  progress: number;
  message: string;
}

const CLIENT_CONCURRENCY = 3;
const MAX_BATCH_FILES = 50;
const MAX_PDF_BYTES = 80 * 1024 * 1024;
const terminalStatuses = new Set<BatchStatus>([
  "completed",
  "partial",
  "skipped",
  "failed",
]);

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusIcon(status: BatchStatus) {
  if (status === "completed") return <CheckCircle weight="fill" />;
  if (["partial", "skipped", "failed"].includes(status)) return <WarningCircle weight="fill" />;
  if (["uploading", "parsing"].includes(status)) return <SpinnerGap className="batch-spinner" />;
  return <ClockCountdown />;
}

export function UploadDialog({ onComplete }: { onComplete?: () => void }) {
  const { activeProfile, activeProfileId, refreshProfiles } = useProfiles();
  const dialog = useRef<HTMLDialogElement>(null);
  const [dragging, setDragging] = useState(false);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const updateItem = useCallback((id: string, patch: Partial<BatchItem>) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, []);

  const poll = useCallback(
    async (jobId: string, itemId: string): Promise<"completed" | "partial"> => {
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const job = await apiFetch<{
          status: string;
          progress: number;
          error: string | null;
        }>(`/parse-jobs/${jobId}`);
        const progress = Math.max(10, Math.min(100, job.progress));
        updateItem(itemId, {
          status: "parsing",
          progress,
          message:
            job.status === "processing"
              ? "正在识别报告结构与指标"
              : "等待解析空位",
        });
        if (["completed", "partial"].includes(job.status)) {
          const status = job.status as "completed" | "partial";
          updateItem(itemId, {
            status,
            progress: 100,
            message: status === "completed" ? "解析完成" : "已导入，部分字段可信度不足",
          });
          return status;
        }
        if (job.status === "failed") throw new Error(job.error || "解析失败");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("解析超时，请稍后在报告库查看状态");
    },
    [updateItem],
  );

  const uploadOne = useCallback(
    async (
      item: BatchItem,
      profileId: string,
    ): Promise<"completed" | "partial" | "skipped" | "failed"> => {
      updateItem(item.id, {
        status: "uploading",
        progress: 4,
        message: "正在安全保存原始报告",
      });
      const body = new FormData();
      body.append("file", item.file);
      body.append("profile_id", profileId);
      try {
        const result = await apiFetch<UploadResult>("/reports", {
          method: "POST",
          body,
        });
        updateItem(item.id, {
          status: "parsing",
          progress: 10,
          message: "已保存，等待并发解析",
        });
        return await poll(result.job.id, item.id);
      } catch (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : "导入失败";
        const status = message.includes("已导入") ? "skipped" : "failed";
        updateItem(item.id, {
          status,
          progress: 100,
          message: status === "skipped" ? "报告已存在，已跳过" : message,
        });
        return status;
      }
    },
    [poll, updateItem],
  );

  const processFiles = useCallback(
    async (selected: File[]) => {
      if (busy) return;
      setError("");
      if (!activeProfileId) {
        setError("请先选择健康档案");
        return;
      }

      const unique = new Map<string, File>();
      let invalidCount = 0;
      for (const file of selected.slice(0, MAX_BATCH_FILES)) {
        const isPdf =
          file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
        if (!isPdf || file.size === 0 || file.size > MAX_PDF_BYTES) {
          invalidCount += 1;
          continue;
        }
        unique.set(`${file.name}:${file.size}:${file.lastModified}`, file);
      }
      const files = [...unique.values()];
      const omittedCount = Math.max(0, selected.length - MAX_BATCH_FILES);
      if (!files.length) {
        setError("没有可导入的 PDF；单份文件需小于 80 MB");
        return;
      }
      if (invalidCount || omittedCount) {
        setError(
          `${invalidCount ? `${invalidCount} 份格式或大小不符合要求` : ""}${
            invalidCount && omittedCount ? "；" : ""
          }${omittedCount ? `${omittedCount} 份超出单次 50 份限制` : ""}`,
        );
      }

      const batch = files.map<BatchItem>((file, index) => ({
        id: `${Date.now()}-${index}-${file.name}-${file.size}`,
        file,
        status: "queued",
        progress: 0,
        message: "等待上传",
      }));
      setItems(batch);
      setBusy(true);
      const outcomes: Array<"completed" | "partial" | "skipped" | "failed"> = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < batch.length) {
          const item = batch[cursor++];
          if (item) outcomes.push(await uploadOne(item, activeProfileId));
        }
      };

      try {
        await Promise.all(
          Array.from({ length: Math.min(CLIENT_CONCURRENCY, batch.length) }, worker),
        );
        if (outcomes.some((status) => status === "completed" || status === "partial")) {
          await refreshProfiles(activeProfileId);
          onComplete?.();
        }
      } catch (batchError) {
        setError(batchError instanceof Error ? batchError.message : "批量导入失败");
      } finally {
        setBusy(false);
      }
    },
    [activeProfileId, busy, onComplete, refreshProfiles, uploadOne],
  );

  const overallProgress = useMemo(
    () =>
      items.length
        ? Math.round(items.reduce((total, item) => total + item.progress, 0) / items.length)
        : 0,
    [items],
  );
  const finishedCount = items.filter((item) => terminalStatuses.has(item.status)).length;
  const successCount = items.filter((item) =>
    ["completed", "partial"].includes(item.status),
  ).length;
  const failedCount = items.filter((item) => item.status === "failed").length;
  const skippedCount = items.filter((item) => item.status === "skipped").length;

  const open = () => {
    if (!busy) {
      setItems([]);
      setError("");
    }
    dialog.current?.showModal();
  };

  return (
    <>
      <button className="button button-primary" disabled={!activeProfileId} onClick={open}>
        <UploadSimple size={18} /> 批量导入
      </button>
      <dialog
        ref={dialog}
        className="upload-dialog"
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        onClose={() => {
          if (!busy) setDragging(false);
        }}
      >
        <div className="dialog-head">
          <div>
            <h2>批量导入体检报告</h2>
            <p>报告将保存到「{activeProfile?.name || "当前档案"}」并最多同时解析 3 份</p>
          </div>
          <button
            className="button button-icon"
            aria-label="关闭"
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            <X />
          </button>
        </div>
        <div className="dialog-body">
          <label
            className={`upload-drop ${dragging ? "dragging" : ""} ${busy ? "disabled" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (!busy) void processFiles(Array.from(event.dataTransfer.files));
            }}
          >
            <input
              type="file"
              accept="application/pdf,.pdf"
              multiple
              disabled={busy}
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.currentTarget.value = "";
                if (files.length) void processFiles(files);
              }}
            />
            <span>
              <FilePdf size={34} weight="thin" />
              <strong>{busy ? "正在处理这批报告" : "拖入多个 PDF，或点击批量选择"}</strong>
              <small>
                归属：{activeProfile?.name || "当前档案"} · 单次最多 50 份 · 单份最大 80 MB
              </small>
            </span>
          </label>
          <p className="muted upload-help">
            扫描型 PDF 请先生成可搜索文字层；当前版本不包含 OCR。无法可靠识别的内容不会参与异常状态汇总。
          </p>

          {items.length > 0 && (
            <section className="batch-panel" aria-live="polite">
              <div className="batch-overview">
                <div>
                  <strong>{busy ? `已完成 ${finishedCount}/${items.length}` : `本批次完成 ${successCount} 份`}</strong>
                  <span>
                    {busy
                      ? `正在并发处理，整体进度 ${overallProgress}%`
                      : `${failedCount} 份失败 · ${skippedCount} 份重复跳过`}
                  </span>
                </div>
                <span className="mono">{overallProgress}%</span>
              </div>
              <div className="progress" aria-label={`批量处理总进度 ${overallProgress}%`}>
                <span style={{ width: `${overallProgress}%` }} />
              </div>
              <ul className="batch-list">
                {items.map((item) => (
                  <li className={`batch-item is-${item.status}`} key={item.id}>
                    <span className="batch-status-icon" aria-hidden="true">
                      {statusIcon(item.status)}
                    </span>
                    <span className="batch-file">
                      <strong title={item.file.name}>{item.file.name}</strong>
                      <small>{formatBytes(item.file.size)} · {item.message}</small>
                    </span>
                    <span className="mono batch-item-progress">{item.progress}%</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {error && <div className="error upload-error">{error}</div>}
          {!busy && items.length > 0 && (
            <div className="batch-actions">
              <button className="button" onClick={() => dialog.current?.close()}>完成</button>
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
