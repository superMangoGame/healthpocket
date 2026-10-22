"use client";

import { ArrowClockwise, ArrowLeft, ArrowSquareOut, CaretLeft, CaretRight, FilePdf, MagnifyingGlassPlus, PencilSimple, Plus, Sparkle, SpinnerGap, Trash, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { CategoryChip } from "@/components/RecordCategory";
import { RecordForm } from "@/components/RecordForm";
import { StatusBadge } from "@/components/StatusBadge";
import { apiFetch } from "@/lib/api";
import { PARSE_STATUS_LABELS, RECORD_FILE_ACCEPT, formatBytes, isParsing, recordFileUrl, recordTitle, uploadRecordFile } from "@/lib/records";
import type { AiCapabilities, MedicalRecordDetail, RecordFile } from "@/lib/types";
import { useProfiles } from "@/components/ProfileProvider";

const isImage = (file: RecordFile) => file.mime_type.startsWith("image/");

function AddFilesButton({ disabled, onFiles, primary = false }: { disabled: boolean; onFiles: (files: File[]) => void; primary?: boolean }) {
  return (
    <label className={`button ${primary ? "button-primary" : ""} ${disabled ? "is-disabled" : ""}`}>
      <Plus weight="bold" /> 添加文件
      <input type="file" hidden multiple accept={RECORD_FILE_ACCEPT} disabled={disabled}
        onChange={(event) => { const files = Array.from(event.target.files || []); event.currentTarget.value = ""; if (files.length) onFiles(files); }} />
    </label>
  );
}

type DetailFile = MedicalRecordDetail["files"][number];

const statusTone = (file: RecordFile) => file.parse_status === "completed" ? "status-normal" : file.parse_status === "failed" ? "status-abnormal"
  : file.parse_status === "needs_ai" ? "status-attention" : "status-insufficient";

/**
 * What was read from one file: the values and diagnoses that now feed trends, the
 * risk atlas and the AI, plus the raw text. Images and scans wait here for the
 * user to send them to the vision model.
 */
function ParsePanel({ record, file, capabilities, onParse }: {
  record: MedicalRecordDetail; file: DetailFile; capabilities: AiCapabilities | null; onParse: (file: RecordFile, mode: "recognize" | "reparse") => void;
}) {
  const measurements = record.measurements.filter((item) => item.file_id === file.id);
  const findings = record.findings.filter((item) => item.file_id === file.id);
  const pdf = file.mime_type === "application/pdf";
  const canRecognize = Boolean(capabilities?.configured) && (pdf ? capabilities?.pdf !== false : capabilities?.images !== false);
  const aiHint = !capabilities ? "" : !capabilities.configured ? "需要先在设置中配置 AI 模型"
    : canRecognize ? `原图会发送给 ${capabilities.name} · ${capabilities.model} 转写文字` : `${capabilities.model} 不支持读取${pdf ? " PDF" : "图片"}，请在设置中换一个支持的模型`;
  const recognizeButton = (label: string) => (
    <button className="button" disabled={!canRecognize} title={aiHint} onClick={() => onParse(file, "recognize")}><Sparkle weight="fill" /> {label}</button>
  );
  return (
    <section className="panel record-parse">
      <div className="record-files-head">
        <h3>识别结果</h3>
        {file.parse_status && <span className={`status status-compact ${statusTone(file)}`}>{PARSE_STATUS_LABELS[file.parse_status]}</span>}
      </div>
      {isParsing(file) ? (
        <p className="record-parse-note"><SpinnerGap className="batch-spinner" /> 正在{file.parse_method === "ai_vision" || !pdf ? "用 AI 识别，约需 10–60 秒" : "读取 PDF 文字"}…</p>
      ) : file.parse_status === "completed" ? (
        <>
          <p className="record-parse-note muted">
            {file.parse_method === "ai_vision" ? "由 AI 从原文件转写，数值请以原件为准" : "本机读取 PDF 文字层"} · {measurements.length} 项指标 · {findings.length} 条诊断 / 结论
          </p>
          {findings.length > 0 && (
            <ul className="record-parse-findings">
              {findings.map((item) => (
                <li key={item.id}><StatusBadge status={item.severity} compact /><span><strong>{item.title}</strong>{item.section && <small>{item.section}</small>}</span></li>
              ))}
            </ul>
          )}
          {measurements.length > 0 && (
            <table className="record-parse-table">
              <tbody>
                {measurements.map((item) => (
                  <tr key={item.id} className={item.confidence < 0.8 ? "low" : ""} title={item.confidence < 0.8 ? "置信度较低，不参与趋势和风险统计" : item.raw_text}>
                    <td>{item.raw_name}</td>
                    <td className="mono"><strong>{item.value_numeric ?? item.value_text ?? "—"}</strong> {item.unit}</td>
                    <td className="mono muted">{item.ref_text || ""}</td>
                    <td><StatusBadge status={item.confidence < 0.8 ? "insufficient" : item.status} compact /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!measurements.length && !findings.length && <p className="record-parse-note muted">文字已读取，但没有找到可识别的检验指标或诊断条目。</p>}
          {file.text && <details className="record-parse-text"><summary>查看识别出的全文</summary><pre>{file.text}</pre></details>}
          <div className="record-parse-actions">
            {pdf && file.parse_method === "pdf_text" && <button className="button" onClick={() => onParse(file, "reparse")}><ArrowClockwise /> 重新解析</button>}
            {recognizeButton(file.parse_method === "ai_vision" ? "重新 AI 识别" : "改用 AI 识别")}
          </div>
        </>
      ) : (
        <>
          <p className={file.parse_status === "failed" ? "record-parse-note error-text" : "record-parse-note"}>
            {file.parse_error || (pdf ? "这份 PDF 还没有解析" : "图片需要用 AI 识别文字")}
          </p>
          <div className="record-parse-actions">
            {pdf && <button className="button" onClick={() => onParse(file, "reparse")}><ArrowClockwise /> 重新解析</button>}
            {recognizeButton(file.parse_status === "failed" ? "重新 AI 识别" : "AI 识别")}
          </div>
          {aiHint && <small className="record-parse-hint">{aiHint}{!capabilities?.configured && <> · <Link className="link" href="/settings">去设置</Link></>}</small>}
        </>
      )}
    </section>
  );
}

function RecordDetailView() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") || "";
  const fileParam = searchParams.get("file");
  const router = useRouter();
  const { activeProfileId, refreshProfiles } = useProfiles();
  const [record, setRecord] = useState<MedicalRecordDetail | null>(null);
  const [capabilities, setCapabilities] = useState<AiCapabilities | null>(null);
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [uploading, setUploading] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const editDialog = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try { setRecord(await apiFetch<MedicalRecordDetail>(`/records/${id}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "加载失败"); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { apiFetch<AiCapabilities>("/ai/capabilities").then(setCapabilities).catch(() => undefined); }, []);
  // Links from trends and the risk atlas open the file a value was read from.
  const openedFile = useRef<string | null>(null);
  useEffect(() => {
    if (!record || !fileParam || openedFile.current === fileParam) return;
    openedFile.current = fileParam;
    const position = record.files.findIndex((file) => file.id === fileParam);
    if (position >= 0) setIndex(position);
  }, [record, fileParam]);
  // Recognition runs in the background; follow it until every file settles.
  const parsing = Boolean(record?.files.some(isParsing));
  useEffect(() => {
    if (!parsing) return;
    const timer = window.setTimeout(() => void load(), 1500);
    return () => window.clearTimeout(timer);
  }, [parsing, record, load]);
  useEffect(() => {
    if (record && activeProfileId && record.profile_id !== activeProfileId) router.replace("/reports");
  }, [record, activeProfileId, router]);

  const files = record?.files ?? [];
  const current = files[Math.min(index, files.length - 1)];
  const canRecognizeImages = Boolean(capabilities?.configured) && capabilities?.images !== false;
  const step = useCallback((delta: number) => {
    setZoomed(false);
    setIndex((value) => Math.max(0, Math.min(files.length - 1, value + delta)));
  }, [files.length]);
  // Arrow keys page through a CT series without reaching for the mouse.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (editing || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, step]);

  const addFiles = async (selected: File[]) => {
    if (!record || uploading) return;
    setError("");
    const problems: string[] = [];
    for (const [position, file] of selected.entries()) {
      setUploading(`正在保存 ${position + 1}/${selected.length}：${file.name}`);
      try { await uploadRecordFile(record.id, file, { recognize: canRecognizeImages }); }
      catch (reason) { problems.push(`${file.name}：${reason instanceof Error ? reason.message : "上传失败"}`); }
    }
    setUploading("");
    if (problems.length) setError(problems.join("\n"));
    await load();
  };

  const parse = async (file: RecordFile, mode: "recognize" | "reparse") => {
    if (!record) return;
    setError("");
    try { await apiFetch(`/records/${record.id}/files/${file.id}/${mode}`, { method: "POST" }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法开始识别"); }
  };

  const removeFile = async (file: RecordFile) => {
    if (!record || !window.confirm(`删除附件「${file.filename}」？原文件会从本机数据目录移除，无法撤销。`)) return;
    try {
      await apiFetch(`/records/${record.id}/files/${file.id}`, { method: "DELETE" });
      setIndex((value) => Math.max(0, Math.min(value, files.length - 2)));
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); }
  };

  const removeRecord = async () => {
    if (!record || !window.confirm(`删除「${recordTitle(record)}」及其 ${record.files.length} 个附件？此操作无法撤销。`)) return;
    try {
      await apiFetch(`/records/${record.id}`, { method: "DELETE" });
      if (activeProfileId) await refreshProfiles(activeProfileId);
      router.push("/reports");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); }
  };

  const openEditor = () => { setEditing(true); editDialog.current?.showModal(); };

  if (!id) return <div className="error">缺少记录 ID，请从报告管理进入。</div>;
  if (!record) return error ? <div className="error">{error}</div> : <div className="skeleton" style={{ height: "80dvh" }} />;
  const place = [record.institution, record.department].filter(Boolean).join(" · ");
  return (
    <>
      <header className="page-header">
        <div>
          <Link href="/reports" className="link" style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, marginBottom: 10 }}><ArrowLeft /> 返回报告管理</Link>
          <h1 className="page-title">{recordTitle(record)}</h1>
          <p className="page-subtitle record-subtitle">
            <CategoryChip category={record.category} />
            <span className="mono">{record.record_date}</span>
            {place && <span>{place}</span>}
            <span>{files.length} 个附件</span>
          </p>
        </div>
        <div className="header-actions">
          <button className="button" onClick={openEditor}><PencilSimple /> 编辑</button>
          <button className="button button-danger" onClick={() => void removeRecord()}><Trash /> 删除</button>
        </div>
      </header>
      {error && <div className="error" style={{ marginBottom: 16 }}>{error}</div>}
      <section className="record-detail-grid">
        <div className="panel record-viewer">
          {current ? (
            <>
              <div className="record-viewer-bar">
                <strong title={current.filename}>{current.filename}</strong>
                <span className="mono muted">{Math.min(index, files.length - 1) + 1} / {files.length}</span>
                <div className="record-viewer-actions">
                  {files.length > 1 && <>
                    <button className="button button-icon" aria-label="上一个" disabled={index === 0} onClick={() => step(-1)}><CaretLeft /></button>
                    <button className="button button-icon" aria-label="下一个" disabled={index >= files.length - 1} onClick={() => step(1)}><CaretRight /></button>
                  </>}
                  {isImage(current) && <button className="button" aria-pressed={zoomed} onClick={() => setZoomed(!zoomed)}><MagnifyingGlassPlus /> {zoomed ? "适应窗口" : "原始大小"}</button>}
                  <a className="button button-icon" href={recordFileUrl(current)} target="_blank" rel="noreferrer" aria-label="新窗口打开"><ArrowSquareOut /></a>
                </div>
              </div>
              <div className={`record-stage ${zoomed ? "zoomed" : ""}`}>
                {isImage(current)
                  ? <img key={current.id} src={recordFileUrl(current)} alt={current.filename} onClick={() => setZoomed(!zoomed)} />
                  : <iframe key={current.id} title={current.filename} src={`${recordFileUrl(current)}#view=FitH`} />}
              </div>
              {files.length > 1 && (
                <div className="record-strip" aria-label="全部附件">
                  {files.map((file, position) => (
                    <button key={file.id} type="button" className="record-thumb" aria-pressed={file.id === current.id} aria-label={file.filename}
                      onClick={() => { setIndex(position); setZoomed(false); }}>
                      {isImage(file) ? <img src={recordFileUrl(file, true)} alt="" loading="lazy" decoding="async" /> : <FilePdf size={20} />}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="record-viewer-empty">
              <FilePdf size={34} weight="thin" />
              <strong>这条记录还没有附件</strong>
              <p>可以补充病历照片、CT 图片或 PDF 报告。</p>
              <AddFilesButton primary disabled={Boolean(uploading)} onFiles={(selected) => void addFiles(selected)} />
              {uploading && <small>{uploading}</small>}
            </div>
          )}
        </div>
        <aside className="record-side">
          <section className="panel record-info">
            <dl>
              <div><dt>类别</dt><dd><CategoryChip category={record.category} /></dd></div>
              <div><dt>日期</dt><dd className="mono">{record.record_date}</dd></div>
              <div><dt>医院</dt><dd>{record.institution || "—"}</dd></div>
              <div><dt>科室</dt><dd>{record.department || "—"}</dd></div>
            </dl>
            <h3>诊断 / 结论 / 备注</h3>
            <p className={record.notes ? "record-notes" : "record-notes muted"}>{record.notes || "未填写，可点「编辑」补充。"}</p>
          </section>
          {current && <ParsePanel record={record} file={current} capabilities={capabilities} onParse={(file, mode) => void parse(file, mode)} />}
          <section className="panel record-files">
            <div className="record-files-head">
              <h3>附件 <span className="mono muted">{files.length}</span></h3>
              <AddFilesButton disabled={Boolean(uploading)} onFiles={(selected) => void addFiles(selected)} />
            </div>
            {uploading && <p className="record-uploading">{uploading}</p>}
            {canRecognizeImages && <small className="record-parse-hint">新添加的图片会发送给 {capabilities?.name} · {capabilities?.model} 识别文字；有文字层的 PDF 在本机解析。</small>}
            {files.length ? (
              <ul>
                {files.map((file, position) => (
                  <li key={file.id} className={file.id === current?.id ? "active" : ""}>
                    <button type="button" className="record-file-open" onClick={() => { setIndex(position); setZoomed(false); }}>
                      <span className="record-thumb">{isImage(file) ? <img src={recordFileUrl(file, true)} alt="" loading="lazy" decoding="async" /> : <FilePdf size={18} />}</span>
                      <span><strong title={file.filename}>{file.filename}</strong><small className="mono">{formatBytes(file.size_bytes)}{file.parse_status && <> · <em className={statusTone(file)}>{PARSE_STATUS_LABELS[file.parse_status]}</em></>}</small></span>
                    </button>
                    <button type="button" className="record-file-remove" aria-label={`删除 ${file.filename}`} onClick={() => void removeFile(file)}><Trash /></button>
                  </li>
                ))}
              </ul>
            ) : <p className="muted record-files-empty">PDF、JPG、PNG、WebP，单个最大 80 MB。</p>}
          </section>
        </aside>
      </section>
      <dialog ref={editDialog} className="upload-dialog" onCancel={(event) => { if (editBusy) event.preventDefault(); }} onClose={() => setEditing(false)}>
        <div className="dialog-head">
          <div><h2>编辑记录</h2><p>附件在详情页右侧管理</p></div>
          <button className="button button-icon" aria-label="关闭" disabled={editBusy} onClick={() => editDialog.current?.close()}><X /></button>
        </div>
        <div className="dialog-body">
          {editing && (
            <RecordForm profileId={record.profile_id} record={record} onBusyChange={setEditBusy}
              onCancel={() => editDialog.current?.close()}
              onSaved={() => { editDialog.current?.close(); void load(); }} />
          )}
        </div>
      </dialog>
    </>
  );
}

export default function RecordDetailPage() {
  return (
    <Suspense fallback={<div className="skeleton" style={{ height: "80dvh" }} />}>
      <RecordDetailView />
    </Suspense>
  );
}
