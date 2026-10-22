"use client";

import Link from "next/link";
import { CategoryIcon } from "@/components/RecordCategory";
import { CATEGORY_LABELS, CATEGORY_SHORT_LABELS, TIMELINE_CATEGORIES, countByCategory, groupByYear, monthDay, type TimelineEntry } from "@/lib/records";

const LISTED = 5;

/** The overview's year-by-year shelf: what was checked, where, and when. */
export function YearArchive({ entries }: { entries: TimelineEntry[] }) {
  const groups = groupByYear(entries).filter((group): group is { year: number; entries: TimelineEntry[] } => group.year !== null);
  if (!groups.length) return null;
  return (
    <section className="section year-archive">
      <div className="section-head">
        <div>
          <h2 className="section-title">年度档案</h2>
          <p className="muted year-archive-subtitle">体检、病历、影像与化验单按年份归档，点击年份查看当年完整时间线。</p>
        </div>
        <Link href="/reports" className="link">报告时间线</Link>
      </div>
      <div className="year-archive-scroll">
        {groups.map(({ year, entries: items }) => {
          const counts = countByCategory(items);
          const present = TIMELINE_CATEGORIES.filter((category) => counts[category]);
          const more = items.length - LISTED;
          return (
            <article className="panel year-card" key={year}>
              <header>
                <Link href={`/reports?year=${year}`} className="year-card-year mono">{year}</Link>
                <span>{items.length} 份</span>
              </header>
              <div className="year-card-bar" aria-hidden="true">
                {present.map((category) => <i key={category} data-category={category} style={{ flexGrow: counts[category] }} />)}
              </div>
              <div className="year-card-tags">
                {present.map((category) => (
                  <Link key={category} href={`/reports?year=${year}&category=${category}`} className="category-count" data-category={category}
                    title={`${year} 年${CATEGORY_LABELS[category]} ${counts[category]} 份`}>
                    <CategoryIcon category={category} size={13} weight="bold" />{CATEGORY_SHORT_LABELS[category]}<b className="mono">{counts[category]}</b>
                  </Link>
                ))}
              </div>
              <ol className="year-card-list">
                {items.slice(0, LISTED).map((entry) => (
                  <li key={entry.key} data-category={entry.category}>
                    <Link href={entry.href}>
                      <time className="mono">{monthDay(entry.date)}</time>
                      <i aria-hidden="true" />
                      <span title={entry.title}>{entry.title}</span>
                    </Link>
                  </li>
                ))}
              </ol>
              {more > 0 && <Link href={`/reports?year=${year}`} className="year-card-more">还有 {more} 份</Link>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
