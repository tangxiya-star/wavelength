// Screen 3 — Session report. Precomputed/static for the demo (the "scaled" story).
import { getVideos } from "@/lib/api";
import { demoInterest } from "@/lib/demo";
import InterestBar from "@/components/InterestBar";

export default async function ReportPage() {
  const videos = await getVideos();
  const ranked = videos
    .map((v) => ({ v, score: demoInterest[v.video_id] ?? 0.5 }))
    .sort((a, b) => b.score - a.score);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Session Report</h1>
        <p className="text-sm text-neutral-500">3 viewers · {videos.length} clips · Tech UGC</p>
      </div>

      <section>
        <h2 className="mb-3 text-xs uppercase tracking-wide text-neutral-500">Top performers (by interest)</h2>
        <ol className="space-y-2">
          {ranked.map(({ v, score }, i) => (
            <li key={v.video_id} className="flex items-center gap-3 text-sm">
              <span className="w-4 text-neutral-500">{i + 1}.</span>
              <span className="w-64 truncate">{v.characteristics.transcript_summary.split("—")[0].trim()}</span>
              <span className="w-20 text-neutral-500">{v.metadata.creator}</span>
              <InterestBar value={score} className="w-32" />
              <span className="tabular-nums text-green-400">{score.toFixed(2)}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
          <h2 className="mb-3 text-xs uppercase tracking-wide text-neutral-500">What wins</h2>
          <ul className="space-y-1.5 text-sm text-neutral-300">
            <li>▸ hook in first 2s</li>
            <li>▸ 6–9 cuts</li>
            <li>▸ bold on-screen text</li>
            <li>▸ warm color palette</li>
          </ul>
        </section>
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
          <h2 className="mb-3 text-xs uppercase tracking-wide text-neutral-500">Who wins</h2>
          <ul className="space-y-1.5 text-sm text-neutral-300">
            <li>▸ {ranked[0]?.v.metadata.creator} (avg 0.77)</li>
            <li>▸ best format: fast talking-head + captions</li>
          </ul>
        </section>
      </div>

      <p className="text-lg font-semibold">
        → Stop spraying and praying. <span className="text-green-400">CPM ↓ CAC ↓</span>
      </p>
    </div>
  );
}
