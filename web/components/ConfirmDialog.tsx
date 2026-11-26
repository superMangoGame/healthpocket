"use client";

import { WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current && !busy) onCancel();
      }}
    >
      <div className="dialog-head">
        <div className="confirm-head-title">
          {danger && <span className="confirm-icon-danger" aria-hidden="true"><WarningCircle size={20} weight="fill" /></span>}
          <div>
            <h2>{title}</h2>
          </div>
        </div>
        <button type="button" className="button button-icon" aria-label="关闭" disabled={busy} onClick={onCancel}>
          <X />
        </button>
      </div>
      <div className="dialog-body">
        <p className="confirm-description">{description}</p>
        <div className="dialog-actions">
          <button type="button" className="button" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
          <button
            type="button"
            className={`button ${danger ? "button-danger-solid" : "button-primary"}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "正在处理…" : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
