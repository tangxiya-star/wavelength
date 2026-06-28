// POST /api/gtm — live Orange Slice call.
// Takes a virality element (abstracted from the EEG spike) and asks Orange Slice
// to (1) generate a GTM hook brief for the genre, and (2) save it as a reusable
// Orange Slice skill. Runs server-side so the API key stays out of the browser.
//
// Auth: orangeslice SDK reads ORANGESLICE_API_KEY or ~/.config/orangeslice/config.json.
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Element = {
  topic: string;
  themes: string[];
  top_resonating_persona: string;
  virality_score: number;
  peak_moment_ts: number;
};

const DEFAULT_ELEMENT: Element = {
  topic: "office-humor / coworker skits (Tech UGC)",
  themes: ["relatable coworker", "no-filter honesty", "tag-a-coworker CTA", "burned-in captions"],
  top_resonating_persona: "B2B SaaS / startup employees, 22–32",
  virality_score: 0.86,
  peak_moment_ts: 2000,
};

// in-memory cache so the same virality element doesn't re-hit Orange Slice (~10s/call)
const gtmCache = new Map<string, { brief: unknown; skillId: string | null }>();

export async function POST(req: Request) {
  let element: Element = DEFAULT_ELEMENT;
  try {
    const body = await req.json();
    if (body?.element) element = { ...DEFAULT_ELEMENT, ...body.element };
  } catch {
    /* use default */
  }

  const cacheKey = JSON.stringify(element);
  const hit = gtmCache.get(cacheKey);
  if (hit) {
    return NextResponse.json({ ok: true, element, brief: hit.brief, skillId: hit.skillId, cached: true });
  }

  try {
    const { services, skills } = await import("orangeslice");

    const brief = await services.ai.generateObject({
      prompt:
        "You are a short-form growth strategist. Given this neural-virality element " +
        "(derived from real EEG interest spikes), produce a concise GTM brief for this genre. " +
        "Return EXACTLY 4 recommended hooks.\n" +
        JSON.stringify(element),
      schema: {
        type: "object",
        properties: {
          genre: { type: "string" },
          recommended_hooks: {
            type: "array",
            items: {
              type: "object",
              properties: { hook: { type: "string" }, why: { type: "string" } },
              required: ["hook", "why"],
            },
          },
          target_audience: { type: "string" },
          suggested_channels: { type: "array", items: { type: "string" } },
        },
        required: ["genre", "recommended_hooks", "target_audience", "suggested_channels"],
      },
    });

    const briefObj = (brief as { object?: unknown })?.object ?? brief;

    let skillId: string | null = null;
    try {
      const skill = await skills.create({
        title: `Viral hooks — ${element.topic}`,
        description: `Neural-validated hooks for ${element.topic} (virality ${element.virality_score}).`,
        content: JSON.stringify({ element, brief: briefObj }, null, 2),
      });
      skillId = (skill as { id?: string })?.id ?? null;
    } catch {
      /* skill save is best-effort */
    }

    gtmCache.set(cacheKey, { brief: briefObj, skillId });
    return NextResponse.json({ ok: true, element, brief: briefObj, skillId });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Orange Slice call failed" },
      { status: 500 },
    );
  }
}
