/**
 * Token estimation and brief assembly utilities for preflight briefs.
 */

export interface BriefSection {
  label: string;
  items: string[];
  priority: number;
}

/**
 * Estimate token count for a text string.
 * Uses word count * 1.3 as a rough approximation.
 */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return Math.ceil(words * 1.3);
}

/**
 * Assemble a brief from prioritized sections within a token budget.
 * Sections are sorted by priority descending, items added until budget exhausted.
 * Returns formatted markdown with **Label:** headers and bullet items.
 */
export function assembleBrief(sections: BriefSection[], tokenBudget: number): string {
  if (sections.length === 0) return "";

  // Sort by priority descending
  const sorted = [...sections].sort((a, b) => b.priority - a.priority);

  // Filter out sections with no items
  const nonEmpty = sorted.filter((s) => s.items.length > 0);
  if (nonEmpty.length === 0) return "";

  let remainingBudget = tokenBudget;
  const parts: string[] = [];

  for (const section of nonEmpty) {
    // Header cost
    const header = `**${section.label}:**`;
    const headerCost = estimateTokens(header);

    if (remainingBudget <= headerCost) break;

    const sectionItems: string[] = [];
    let sectionBudget = remainingBudget - headerCost;

    for (const item of section.items) {
      const itemLine = `- ${item}`;
      const itemCost = estimateTokens(itemLine);

      if (itemCost > sectionBudget) break;

      sectionItems.push(itemLine);
      sectionBudget -= itemCost;
    }

    if (sectionItems.length > 0) {
      parts.push(header + "\n" + sectionItems.join("\n"));
      remainingBudget = sectionBudget;
    }
  }

  return parts.join("\n\n");
}
