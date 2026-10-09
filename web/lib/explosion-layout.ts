import type { AtlasPart } from "@/lib/human-atlas";

export interface ExplosionCell {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 将当前可见网格排入互不重叠的二维拆解清单。算法改编自 Human Atlas。 */
export function createExplosionLayout(parts: AtlasPart[], aspect = 1) {
  const cards = parts.map((part) => ({
    id: part.id,
    width: Math.max(0.035, part.bounds[1][0] - part.bounds[0][0]) + 0.04,
    height: Math.max(0.035, part.bounds[1][1] - part.bounds[0][1]) + 0.04,
  }));
  const area = cards.reduce((total, card) => total + card.width * card.height, 0);
  const maxWidth = Math.max(0.3, ...cards.map((card) => card.width));
  const targetWidth = Math.max(
    maxWidth,
    Math.sqrt(area * Math.max(0.5, Math.min(1.5, aspect))) * 1.18,
  );
  cards.sort((a, b) => b.height - a.height || a.id.localeCompare(b.id));

  const cells = new Map<string, ExplosionCell>();
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let usedWidth = 0;
  cards.forEach((card) => {
    if (x > 0 && x + card.width > targetWidth) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    cells.set(card.id, {
      x: x + card.width / 2,
      y: -y - card.height / 2,
      width: card.width,
      height: card.height,
    });
    x += card.width;
    usedWidth = Math.max(usedWidth, x);
    rowHeight = Math.max(rowHeight, card.height);
  });

  const height = y + rowHeight;
  cells.forEach((cell) => {
    cell.x -= usedWidth / 2;
    cell.y += height / 2;
  });
  return { cells, width: usedWidth, height };
}
