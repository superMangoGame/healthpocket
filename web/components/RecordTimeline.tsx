"use client";

import { FilePdf } from "@phosphor-icons/react";
import Link from "next/link";
import { CategoryChip, CategoryIcon } from "@/components/RecordCategory";
import { groupByYear, monthDay, parseSummary, recordFileUrl, type TimelineEntry } from "@/lib/records";

const parseLabels: Record<string, string> = { queued: "等待解析", processing: "解析中", partial: "部分完成", failed: "解析失败" };
const THUMBNAILS = 4;

function Thumbnails({ entry }: { entry: TimelineEntry }) {
  if (!entry.files.length) return null;
  const shown = entry.files.slice(0, THUMBNAILS);
  const more = entry.files.length - shown.length;
  return (
    <div className="record-thumbs" aria-label={`${entry.files.length} 个附件`}>
      {shown.map((file) => (
        <span key={file.id} className="record-thumb">
          {file.mime_type.startsWith("image/")
            ? <img src={recordFileUrl(file, true)} alt="" loading="lazy" decoding="async" />
            : <FilePdf size={20} />}
        </span>
      ))}
      {more > 0 && <span className="record-thumb record-thumb-more mono">+{more}</span>}
    </div>
  );
}

/** Checkups and medical records on one line of time, newest first, grouped by year. */
export function RecordTimeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <div className="record-timeline">
      {groupByYear(entries).map((group) => (
        <section className="record-year" key={group.year ?? "undated"} aria-label={group.year ? `${group.year} 年` : "日期待识别"}>
          <header className="record-year-head">
            <h3 className="mono">{group.year ?? "日期待识别"}</h3>
            <span>{group.entries.length} 份</span>
          </header>
          <ol className="record-entries">
            {group.entries.map((entry) => (
              <li className="record-entry" key={entry.key} data-category={entry.category}>
                <time className="record-entry-date mono" dateTime={entry.date ?? undefined}>{monthDay(entry.date)}</time>
                <span className="record-entry-node" aria-hidden="true"><CategoryIcon category={entry.category} size={15} weight="bold" /></span>
                <Link href={entry.href} className="record-entry-card">
                  <div className="record-entry-body">
                    <div className="record-entry-title">
                      <CategoryChip category={entry.category} />
                      <strong>{entry.title}</strong>
                      {entry.parseStatus && parseLabels[entry.parseStatus] && (
                        <span className={`status status-compact ${entry.parseStatus === "failed" ? "status-abnormal" : "status-attention"}`}>{parseLabels[entry.parseStatus]}</span>
                      )}
                    </div>
                    <p className="record-entry-meta">
                      {[entry.institution, entry.department].filter(Boolean).join(" · ") || (entry.kind === "exam" ? "未识别机构" : "未填写医院")}
                      {entry.files.length > 0 && <span className="mono"> · {entry.files.length} 个附件</span>}
                    </p>
                    {entry.notes && <p className="record-entry-notes">{entry.notes}</p>}
                    {(() => { const summary = parseSummary(entry.files); return summary && <p className={`record-entry-parse tone-${summary.tone}`}>{summary.text}</p>; })()}
                  </div>
                  <Thumbnails entry={entry} />
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
