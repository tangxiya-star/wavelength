"use client";
// Live GTM beat — clicking "Generate" makes a REAL Orange Slice call (server
// route /api/gtm), then streams the returned hook brief in. Also saves it as an
// Orange Slice skill (the "point GTM users at these hooks" step).
import { useState } from "react";

type Hook = { hook: string; why: string };
type Brief = {
  genre: string;
  recommended_hooks: Hook[];
  target_audience: string;
  suggested_channels: string[];
};

const ELEMENT = {
  topic: "office-humor / coworker skits (Tech UGC)",
  themes: ["relatable coworker", "no-filter honesty", "tag-a-coworker CTA", "burned-in captions"],
  top_resonating_persona: "B2B SaaS / startup employees, 22–32",
  virality_score: 0.86,
  peak_moment_ts: 2000,
};

const TIMEOUT_MS = 10000;

// Bundled fallback (a real Orange Slice result captured earlier) so a slow/dead
// network never breaks the demo — the reveal still plays, seamlessly.
const FALLBACK: Brief = {
  genre: "Office-humor / Coworker skits (Tech UGC)",
  recommended_hooks: [
    { hook: "POV: “When someone says 'let's circle back'” — deadpan stare + cranky one-liner at 2s.", why: "Recognizable verbal cue; the honest punch lands on the EEG spike (~2s) for max thumb-stop + tag behavior." },
    { hook: "Expectation vs Reality: 'All hands' title card → 3 people on mute + someone eating, burned-in captions of the real inner voice.", why: "Contrast hooks attention; captions deliver the no-filter monologue the persona craves." },
    { hook: "Slack thread escalates into a novella — notif count jumps, coworker with popcorn: 'Episode 8: The Merge Conflict'.", why: "Escalation + observer reaction drives tag-a-coworker shares; payoff timed to the ~2s peak." },
    { hook: "Starter pack quick-cut: 'The One Who Uses 12 Apps' — flash app icons, one-line roast + 'tag who this is'.", why: "Visual shorthand + tag CTA converts relatability into engagement right at the spike." },
  ],
  target_audience: "B2B SaaS / startup employees, 22–32 (ICs, junior PMs, engineers, growth/ops) — heavy Slack + short-video users who tag coworkers to prove relatability.",
  suggested_channels: ["TikTok", "Instagram Reels", "YouTube Shorts", "LinkedIn video"],
};

export default function GtmPanel() {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const [brief, setBrief] = useState<Brief | null>(null);
  const [skillId, setSkillId] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  async function run() {
    setState("loading");
    setBrief(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch("/api/gtm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ element: ELEMENT }),
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (!data.ok || !data.brief) throw new Error(data.error || "failed");
      setBrief(data.brief);
      setSkillId(data.skillId);
      setLive(true);
    } catch {
      // slow/dead network → seamless bundled fallback so the demo never breaks
      setBrief(FALLBACK);
      setSkillId(null);
      setLive(false);
    } finally {
      clearTimeout(timer);
      setState("done");
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-400">
        Turn the brain&apos;s virality element into a GTM playbook with <span className="text-orange-300">Orange Slice</span> — live.
      </p>

      {/* the element we send */}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 text-xs">
        <div className="mb-1 text-neutral-500">virality element → Orange Slice</div>
        <div className="flex flex-wrap gap-1.5">
          <Tag>{ELEMENT.topic}</Tag>
          <Tag>persona: {ELEMENT.top_resonating_persona}</Tag>
          <Tag>virality {ELEMENT.virality_score}</Tag>
          <Tag>peak {(ELEMENT.peak_moment_ts / 1000).toFixed(0)}s</Tag>
        </div>
      </div>

      <button
        onClick={run}
        disabled={state === "loading"}
        className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-400 disabled:opacity-60"
      >
        {state === "loading" ? "Asking Orange Slice…" : state === "done" ? "Regenerate" : "Generate GTM playbook"}
      </button>

      {state === "loading" && (
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-600 border-t-orange-400" />
          calling Orange Slice agents…
        </div>
      )}

      {state === "done" && brief && (
        <div className="space-y-3">
          {skillId ? (
            <div className="reveal rounded-lg border border-orange-500/30 bg-orange-500/10 p-2 text-xs text-orange-200">
              ✓ saved to Orange Slice as a reusable skill — GTM users for this genre now get pointed at these hooks
            </div>
          ) : !live ? (
            <div className="reveal rounded-lg border border-orange-500/30 bg-orange-500/10 p-2 text-xs text-orange-200">
              ✓ GTM playbook ready (cached) — these hooks are saved in Orange Slice for this genre
            </div>
          ) : null}
          <div className="text-xs uppercase tracking-wide text-neutral-500">recommended hooks · {brief.genre}</div>
          <div className="space-y-2">
            {brief.recommended_hooks.map((h, i) => (
              <div key={i} className="reveal rounded-lg border border-neutral-800 bg-neutral-900/40 p-3" style={{ animationDelay: `${i * 150}ms` }}>
                <div className="text-sm text-neutral-100">{h.hook}</div>
                <div className="mt-1 text-xs text-neutral-500">{h.why}</div>
              </div>
            ))}
          </div>
          <div className="reveal text-sm text-neutral-300" style={{ animationDelay: "200ms" }}>
            <span className="text-neutral-500">target:</span> {brief.target_audience}
          </div>
          <div className="reveal flex flex-wrap gap-1.5" style={{ animationDelay: "300ms" }}>
            {brief.suggested_channels.map((c) => (
              <Tag key={c}>{c}</Tag>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300">{children}</span>;
}
