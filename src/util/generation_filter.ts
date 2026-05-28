import {JsonFam, JsonGedcomData, JsonIndi} from 'topola';

/**
 * Filters a JsonGedcomData to only include individuals and families within the
 * specified generation range relative to a start individual.
 *
 * For the hourglass chart:
 * - maxAncestorGenerations = 1 → show parents only (no grandparents)
 * - maxDescendantGenerations = 1 → show children only (no grandchildren)
 * - undefined → no limit (include all ancestors / descendants)
 *
 * Cross-references in the returned data are cleaned up so that the topola
 * library does not attempt to follow links to filtered-out entries:
 * - `famc` is cleared when the parent family was filtered out
 * - `fams` entries are removed when the family was filtered out
 * - `children` entries are removed when the child was filtered out
 */
export function filterGenerations(
  data: JsonGedcomData,
  startIndiId: string,
  maxAncestorGenerations: number | undefined,
  maxDescendantGenerations: number | undefined,
): JsonGedcomData {
  const ancestorLimit = maxAncestorGenerations ?? Infinity;
  const descendantLimit = maxDescendantGenerations ?? Infinity;

  // Nothing to filter if both limits are unlimited.
  if (ancestorLimit === Infinity && descendantLimit === Infinity) {
    return data;
  }

  const indiMap = new Map<string, JsonIndi>(data.indis.map((i) => [i.id, i]));
  const famMap = new Map<string, JsonFam>(data.fams.map((f) => [f.id, f]));

  const startIndi = indiMap.get(startIndiId);
  if (!startIndi) return data;

  const allowedIndis = new Set<string>([startIndiId]);
  const allowedFams = new Set<string>();

  // Collect the spouse IDs for the start individual from all families as spouse.
  const spouseIds: string[] = [];
  for (const famId of startIndi.fams ?? []) {
    const fam = famMap.get(famId);
    if (!fam) continue;
    // Always include the start individual's spouse families. The ancestor chart
    // in the hourglass chart initialises itself from the start individual's
    // first family (startFam), so it must be present in the filtered data to
    // avoid a null-dereference in the topola library.
    allowedFams.add(famId);
    const spouseId = fam.husb === startIndiId ? fam.wife : fam.husb;
    if (spouseId) {
      allowedIndis.add(spouseId);
      spouseIds.push(spouseId);
    }
  }

  // ── Ancestor BFS ──────────────────────────────────────────────────────────
  // Walk upward through famc links from the start individual and their
  // spouse(s), stopping once ancestorLimit levels have been traversed.
  const ancestorQueue: Array<{id: string; gen: number}> = [
    {id: startIndiId, gen: 0},
    ...spouseIds.map((id) => ({id, gen: 0})),
  ];
  const visitedAncestors = new Set<string>();

  while (ancestorQueue.length) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const item = ancestorQueue.shift()!;
    if (visitedAncestors.has(item.id)) continue;
    visitedAncestors.add(item.id);
    if (item.gen >= ancestorLimit) continue;

    const indi = indiMap.get(item.id);
    if (!indi?.famc) continue;
    const fam = famMap.get(indi.famc);
    if (!fam) continue;

    allowedFams.add(fam.id);
    for (const parentId of [fam.husb, fam.wife]) {
      if (parentId) {
        allowedIndis.add(parentId);
        ancestorQueue.push({id: parentId, gen: item.gen + 1});
      }
    }
  }

  // ── Descendant BFS ────────────────────────────────────────────────────────
  // Walk downward through fams → children links, stopping once
  // descendantLimit levels have been traversed.
  const descendantQueue: Array<{id: string; gen: number}> = [];
  if (descendantLimit > 0) {
    for (const famId of startIndi.fams ?? []) {
      const fam = famMap.get(famId);
      if (!fam) continue;
      for (const childId of fam.children ?? []) {
        allowedIndis.add(childId);
        descendantQueue.push({id: childId, gen: 1});
      }
    }
  }

  const visitedDescendants = new Set<string>([startIndiId, ...spouseIds]);
  while (descendantQueue.length) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const item = descendantQueue.shift()!;
    if (visitedDescendants.has(item.id)) continue;
    visitedDescendants.add(item.id);
    if (item.gen >= descendantLimit) continue;

    const indi = indiMap.get(item.id);
    for (const famId of indi?.fams ?? []) {
      const fam = famMap.get(famId);
      if (!fam) continue;
      allowedFams.add(famId);
      const spouseId = fam.husb === item.id ? fam.wife : fam.husb;
      if (spouseId) allowedIndis.add(spouseId);
      for (const childId of fam.children ?? []) {
        allowedIndis.add(childId);
        descendantQueue.push({id: childId, gen: item.gen + 1});
      }
    }
  }

  // ── Build filtered data ───────────────────────────────────────────────────
  // Prune cross-references so the topola library never dereferences a missing
  // entry (several code paths do not guard against null returns).
  const filteredIndis = data.indis
    .filter((i) => allowedIndis.has(i.id))
    .map((i) => ({
      ...i,
      // Clear famc when the parent family was excluded.
      famc:
        i.famc !== undefined && allowedFams.has(i.famc) ? i.famc : undefined,
      // Drop fams entries whose families were excluded.
      fams: i.fams?.filter((famId) => allowedFams.has(famId)),
    }));

  const filteredFams = data.fams
    .filter((f) => allowedFams.has(f.id))
    .map((f) => ({
      ...f,
      // Drop children who were excluded (avoids a crash in DescendantChart).
      children: f.children?.filter((childId) => allowedIndis.has(childId)),
    }));

  return {indis: filteredIndis, fams: filteredFams};
}
