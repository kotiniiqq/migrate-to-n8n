/** Numbers for a corpus run: how much converts, what is missing most, failures and speed. */
import type { ConversionReport, Status } from '../src/types.ts';

export interface CorpusRun {
  report: ConversionReport;
  ms: number;
  checkErrors: number;
  catalogErrors: number;
}

export interface CorpusStats {
  files: number;
  rejected: number;
  steps: number;
  share: Record<Status, number>;
  convertedOrReview: number;
  topUnmapped: Array<[string, number]>;
  topReview: Array<[string, number]>;
  filesWithCheckErrors: number;
  filesWithCatalogErrors: number;
  ms: { p50: number; p95: number; max: number };
}

const pct = (n: number, total: number) => (total ? Math.round((1000 * n) / total) / 10 : 0);

function top(runs: CorpusRun[], status: Status, n: number): Array<[string, number]> {
  const count = new Map<string, number>();
  for (const r of runs) for (const s of r.report.steps) if (s.status === status) count.set(s.sourceKey, (count.get(s.sourceKey) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function computeStats(runs: CorpusRun[], rejected: number): CorpusStats {
  const totals: Record<Status, number> = { converted: 0, review: 0, manual: 0 };
  for (const r of runs) for (const s of r.report.steps) totals[s.status]++;
  const steps = totals.converted + totals.review + totals.manual;
  const times = runs.map((r) => r.ms).sort((a, b) => a - b);
  return {
    files: runs.length,
    rejected,
    steps,
    share: { converted: pct(totals.converted, steps), review: pct(totals.review, steps), manual: pct(totals.manual, steps) },
    convertedOrReview: pct(totals.converted + totals.review, steps),
    topUnmapped: top(runs, 'manual', 40),
    topReview: top(runs, 'review', 20),
    filesWithCheckErrors: runs.filter((r) => r.checkErrors > 0).length,
    filesWithCatalogErrors: runs.filter((r) => r.catalogErrors > 0).length,
    ms: { p50: percentile(times, 50), p95: percentile(times, 95), max: times.at(-1) ?? 0 },
  };
}
