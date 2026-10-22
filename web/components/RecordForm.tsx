"use client";

import { CheckCircle, FileImage, FilePdf, Paperclip, Sparkle, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CategoryIcon } from "@/components/RecordCategory";
import { apiFetch } from "@/lib/api";
import {
  MAX_RECORD_FILE_BYTES, RECORD_CATEGORIES, RECORD_FILE_ACCEPT, dateFromFilename, formatBytes, isImageFile, isRecordFile,
  localDateKey, uploadRecordFile,
} from "@/lib/records";
import type { AiCapabilities, MedicalRecord, RecordCategory } from "@/lib/types";

type FileStatus = "waiting" | "uploading" | "done" | "skipped" | "failed";
interface PendingFile { id: string; file: File; status: FileStatus; message: string }

const MAX_FILES = 60;

function pending(files: File[]): PendingFile[] {
  return files.map((file, index) => ({ id: `${Date.now()}-${index}-${file.name}-${file.size}`, file, status: "waiting", message: formatBytes(file.size) }));
}

/** Prefill the date from the files: a date in a file name beats the file's own timestamp. */
function suggestDate(files: File[]): { date: string; source: string } | null {
  for (const file of files) {
    const date = dateFromFilename(file.name);
    if (date) return { date, source: `已按文件名「${file.name}」推测日期，请核对` };
  }
  const modified = files.map((file) => file.lastModified).filter((value) => value > 0);
  return modified.length ? { date: localDateKey(new Date(Math.min(...modified))), source: "已按文件修改时间预填，请核对" } : null;
}

/**
 * Creates a medical record and uploads its files, or edits an existing record's
 * details (files are then managed on the record page). A record without files
 * is fine: a visit can be logged with notes alone, so a failed upload never
 * loses the record itself.
 */
export function RecordForm({
  profileId, record, initialFiles = [], onSaved, onCancel, onBusyChange,
}: {
  profileId: string;
  record?: MedicalRecord;
  initialFiles?: File[];
  onSaved: (record: MedicalRecord) => void;
  onCancel: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const initialSuggestion = useMemo(() => (record ? null : suggestDate(initialFiles)), [record, initialFiles]);
  const [category, setCategory] = useState<RecordCategory>(record?.category ?? "outpatient");
  const [date, setDate] = useState(record?.record_date ?? initialSuggestion?.date ?? localDateKey(new Date()));
  const [dateHint, setDateHint] = useState(initialSuggestion?.source ?? "");
  const [dateTouched, setDateTouched] = useState(Boolean(record));
  const [title, setTitle] = useState(record?.title ?? "");
  const [institution, setInstitution] = useState(record?.institution ?? "");
  const [department, setDepartment] = useState(record?.department ?? "");
  const [notes, setNotes] = useState(record?.notes ?? "");
  const [files, setFiles] = useState<PendingFile[]>(() => pending(initialFiles));
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Set once the record exists, so a retry uploads the remaining files instead of creating it twice.
  const [saved, setSaved] = useState<MedicalRecord | null>(record ?? null);
  const [capabilities, setCapabilities] = useState<AiCapabilities | null>(null);
  // Sending images to the vision model is the user's call for each batch; on by default once a capable model is set up.
  const [recognize, setRecognize] = useState(true);
  useEffect(() => {
    if (record) return;
    let cancelled = false;
    apiFetch<AiCapabilities>("/ai/capabilities").then((value) => { if (!cancelled) setCapabilities(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [record]);
  const canRecognize = Boolean(capabilities?.configured) && capabilities?.images !== false;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const meta = RECORD_CATEGORIES.find((item) => item.id === category)!;
  const today = localDateKey(new Date());
  const editing = Boolean(record);
  const unfinished = files.filter((item) => item.status === "waiting" || item.status === "failed");
  const settled = Boolean(saved) && !editing && files.length > 0 && files.every((item) => item.status !== "waiting");

  const addFiles = (selected: File[]) => {
    setError("");
    const accepted = selected.filter((file) => isRecordFile(file) && file.size > 0 && file.size <= MAX_RECORD_FILE_BYTES);
    const known = new Set(files.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`));
    const fresh = accepted.filter((file) => !known.has(`${file.name}:${file.size}:${file.lastModified}`)).slice(0, Math.max(0, MAX_FILES - files.length));
    const rejected = selected.length - accepted.length;
    if (rejected) setError(`${rejected} 个文件不是 PDF、JPG、PNG、WebP 或超过 80 MB，已忽略`);
    if (!fresh.length) return;
    setFiles((current) => [...current, ...pending(fresh)]);
    const suggestion = !dateTouched && suggestDate(fresh);
    if (suggestion) { setDate(suggestion.date); setDateHint(suggestion.source); }
  };

  const updateFile = (id: string, patch: Partial<PendingFile>) =>
    setFiles((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (settled && !unfinished.length) { onSaved(saved!); return; }
    setBusy(true);
    setError("");
    try {
      const payload = { category, record_date: date, title, institution, department, notes };
      const json = { "content-type": "application/json" };
      const current = saved
        ? await apiFetch<MedicalRecord>(`/records/${saved.id}`, { method: "PUT", headers: json, body: JSON.stringify(payload) })
        : await apiFetch<MedicalRecord>("/records", { method: "POST", headers: json, body: JSON.stringify({ ...payload, profile_id: profileId }) });
      setSaved(current);
      let problems = 0;
      for (const item of unfinished) {
        updateFile(item.id, { status: "uploading", message: "正在保存" });
        try {
          await uploadRecordFile(current.id, item.file, { recognize: canRecognize && recognize });
          updateFile(item.id, { status: "done", message: "已保存" });
        } catch (uploadError) {
          problems += 1;
          const message = uploadError instanceof Error ? uploadError.message : "上传失败";
          updateFile(item.id, { status: message.startsWith("该文件已在") ? "skipped" : "failed", message });
        }
      }
      if (!problems) { onSaved(current); return; }
      setError(`记录已保存，但有 ${problems} 个文件没有存入。可以重试，或稍后在记录详情里补充。`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const retryable = settled && files.some((item) => item.status === "failed");
  return (
    <form className="record-form" onSubmit={(event) => void submit(event)}>
      <fieldset className="record-category-grid" disabled={busy}>
        <legend>类别</legend>
        {RECORD_CATEGORIES.map((item) => (
          <label key={item.id} className="record-category-option" data-category={item.id}>
            <input type="radio" name="record-category" value={item.id} checked={category === item.id} onChange={() => setCategory(item.id)} />
            <CategoryIcon category={item.id} size={19} weight={category === item.id ? "fill" : "regular"} />
            <span><strong>{item.label}</strong><small>{item.hint}</small></span>
          </label>
        ))}
      </fieldset>

      <div className="record-form-row">
        <label>
          <span>就诊 / 检查日期</span>
          <input className="text-input mono" type="date" required max={today} min="1900-01-01" value={date} disabled={busy}
            onChange={(event) => { setDate(event.target.value); setDateTouched(true); setDateHint(""); }} />
          {dateHint && <small className="record-form-hint">{dateHint}</small>}
        </label>
        <label>
          <span>标题 <small>选填</small></span>
          <input className="text-input" maxLength={60} value={title} placeholder={meta.placeholder} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
        </label>
      </div>
      <div className="record-form-row">
        <label>
          <span>医院 / 机构 <small>选填</small></span>
          <input className="text-input" maxLength={60} value={institution} placeholder="例如：北京协和医院" disabled={busy} onChange={(event) => setInstitution(event.target.value)} />
        </label>
        <label>
          <span>科室 <small>选填</small></span>
          <input className="text-input" maxLength={40} value={department} placeholder="例如：放射科" disabled={busy} onChange={(event) => setDepartment(event.target.value)} />
        </label>
      </div>
      <label className="record-form-wide">
        <span>诊断 / 结论 / 备注 <small>{notes.length}/2000</small></span>
        <textarea className="text-area" rows={3} maxLength={2000} value={notes} disabled={busy}
          placeholder="例如：右肺上叶微小结节 4mm，建议 12 个月后复查" onChange={(event) => setNotes(event.target.value)} />
      </label>

      {!editing && (
        <div className="record-form-wide">
          <span className="record-form-label">附件 <small>PDF、JPG、PNG、WebP · 单个最大 80 MB · 可不传</small></span>
          <label
            className={`upload-drop record-drop ${dragging ? "dragging" : ""} ${busy ? "disabled" : ""}`}
            onDragEnter={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); if (!busy) addFiles(Array.from(event.dataTransfer.files)); }}
          >
            <input type="file" accept={RECORD_FILE_ACCEPT} multiple disabled={busy}
              onChange={(event) => { const selected = Array.from(event.target.files || []); event.currentTarget.value = ""; addFiles(selected); }} />
            <span><Paperclip size={22} /><strong>拖入病历照片、CT 图片或 PDF，或点击选择</strong><small>同一次检查的多张图片放在一条记录里</small></span>
          </label>
          {files.length > 0 && (
            <ul className="batch-list record-file-list">
              {files.map((item) => (
                <li key={item.id} className={`batch-item is-${item.status === "done" ? "completed" : item.status === "uploading" ? "uploading" : item.status}`}>
                  <span className="batch-status-icon" aria-hidden="true">
                    {item.status === "uploading" ? <SpinnerGap className="batch-spinner" /> : item.status === "done" ? <CheckCircle weight="fill" />
                      : item.status === "failed" || item.status === "skipped" ? <WarningCircle weight="fill" /> : isImageFile(item.file) ? <FileImage /> : <FilePdf />}
                  </span>
                  <span className="batch-file"><strong title={item.file.name}>{item.file.name}</strong><small>{item.message}</small></span>
                  {item.status === "waiting" || item.status === "failed" ? (
                    <button type="button" className="record-file-remove" aria-label={`移除 ${item.file.name}`} disabled={busy}
                      onClick={() => setFiles((current) => current.filter((entry) => entry.id !== item.id))}><X /></button>
                  ) : <span />}
                </li>
              ))}
            </ul>
          )}
          {files.length > 0 && capabilities && (
            canRecognize ? (
              <label className="record-ai-option">
                <input type="checkbox" checked={recognize} disabled={busy} onChange={(event) => setRecognize(event.target.checked)} />
                <span>
                  <strong><Sparkle weight="fill" /> 保存后用 AI 识别图片和扫描件</strong>
                  <small>原图会发送给 {capabilities.name} · {capabilities.model} 转写文字，不转写姓名、证件号；有文字层的 PDF 在本机解析，不发送。{capabilities.images === null && "该模型不在模型目录中，无法确认是否支持图片。"}</small>
                </span>
              </label>
            ) : (
              <p className="record-ai-note">
                {capabilities.configured
                  ? <>当前模型 {capabilities.name} · {capabilities.model} 不支持读取图片。图片会先保存，换用支持图片的模型（如通义千问 VL、GPT-4o、Claude、Gemini）后可在记录详情里识别。</>
                  : <>图片和扫描件需要 AI 识别才能提取内容，<Link className="link" href="/settings">配置 AI 模型</Link>后可在记录详情里识别。有文字层的 PDF 会在本机直接解析。</>}
              </p>
            )
          )}
        </div>
      )}

      {error && <div className="error">{error}</div>}
      <div className="dialog-actions record-form-actions">
        <button type="button" className="button" disabled={busy} onClick={() => (settled ? onSaved(saved!) : onCancel())}>{settled ? "完成" : "取消"}</button>
        <button type="submit" className="button button-primary" disabled={busy || (settled && !retryable && !unfinished.length)}>
          {busy ? <><SpinnerGap className="batch-spinner" /> 正在保存</> : retryable ? "重试未保存的文件" : settled && !unfinished.length ? "已保存" : editing ? "保存修改" : files.length ? `保存记录和 ${files.length} 个文件` : "保存记录"}
        </button>
      </div>
    </form>
  );
}
