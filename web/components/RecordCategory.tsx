"use client";

import { Bed, ClipboardText, Flask, Folder, Pill, Scan, Stethoscope, type Icon, type IconWeight } from "@phosphor-icons/react";
import { CATEGORY_LABELS, CATEGORY_SHORT_LABELS, type TimelineCategory } from "@/lib/records";

const icons: Record<TimelineCategory, Icon> = {
  exam: ClipboardText, outpatient: Stethoscope, inpatient: Bed, imaging: Scan, lab: Flask, prescription: Pill, other: Folder,
};

export function CategoryIcon({ category, size = 16, weight = "regular" }: { category: TimelineCategory; size?: number; weight?: IconWeight }) {
  const Glyph = icons[category];
  return <Glyph size={size} weight={weight} aria-hidden="true" />;
}

/** Colour comes from `data-category`; see the category tokens in globals.css. */
export function CategoryChip({ category, short = false }: { category: TimelineCategory; short?: boolean }) {
  return (
    <span className="category-chip" data-category={category}>
      <CategoryIcon category={category} size={13} weight="bold" />
      {short ? CATEGORY_SHORT_LABELS[category] : CATEGORY_LABELS[category]}
    </span>
  );
}
