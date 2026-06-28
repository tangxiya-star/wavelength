// POST /api/decode — streaming chat about the clip on screen, in one of two modes:
//   • "decode"  — the neuro-marketing analyst narrates what the model learned and
//                 answers follow-ups (tool: get_clip_characteristics).
//   • "gtm"     — a go-to-market strategist that uses Orange Slice to turn the
//                 clip's virality element into a GTM playbook, then advises on how
//                 to take it to market (tool: generate_gtm_playbook -> Orange Slice).
// Text streams back token-by-token.
//
// Chat Completions (not the realtime socket) so image input can be added later.
// Keys stay server-side (frontend/.env.local): OPENAI_API_KEY, ORANGESLICE_API_KEY.
import OpenAI from "openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

const SYSTEM_DECODE = [
  "You are Wavelength's clip analyst. Be brief, concrete, and plain-spoken.",
  "Default to 2-4 short sentences or 3 bullets max. No long intros.",
  "Ground claims in get_clip_characteristics when facts or numbers matter.",
  "A falling theta/beta ratio means rising engagement; prioritize fast hooks, captions, text, cuts, and retention risk.",
  "If asked about GTM, hooks, distribution, or growth, call generate_gtm_playbook and summarize the result tightly.",
  "Use markdown only when it improves scanning.",
].join(" ");

const SYSTEM_GTM = [
  "You are Wavelength's GTM strategist. Be brief, direct, and actionable.",
  "Call generate_gtm_playbook first, then summarize hooks, audience, and channels in 3-5 bullets.",
  "Reference the specific Orange Slice hooks/channels. Use get_clip_characteristics only when clip facts matter.",
  "Keep follow-ups tight: no preamble, no generic growth advice.",
].join(" ");

interface ClipCtx {
  characteristics?: { audio?: string; transcript_summary?: string; cut_count?: number; on_screen_text?: string; subtitles?: boolean };
  creator?: string;
  duration_ms?: number;
  peak_t?: number | null;
  learnedTraits?: string[];
}
interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}
interface Body {
  clip?: ClipCtx;
  messages?: ChatTurn[];
  mode?: "decode" | "gtm";
}

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response("OPENAI_API_KEY not set — add it to frontend/.env.local", { status: 503 });
  }
  const body = (await req.json().catch(() => ({}))) as Body;
  const clip = body.clip ?? {};
  const c = clip.characteristics ?? {};
  const history = Array.isArray(body.messages) ? body.messages : [];
  const mode: "decode" | "gtm" = body.mode === "gtm" ? "gtm" : "decode";

  // the clip's real analyzed characteristics (tool output for get_clip_characteristics)
  const facts = {
    summary: c.transcript_summary ?? "",
    creator: clip.creator ?? "",
    duration_s: clip.duration_ms ? Math.round(clip.duration_ms / 1000) : undefined,
    cut_count: c.cut_count ?? 0,
    audio: c.audio ?? "",
    on_screen_text: c.on_screen_text ?? "",
    subtitles: c.subtitles ?? false,
    model_predicted_peak_interest_at_s: clip.peak_t ?? undefined,
    learned_traits: clip.learnedTraits ?? [],
  };

  // Orange Slice GTM tool: turn the clip's virality element into a GTM playbook.
  // Delegates to the dedicated /api/gtm route (which owns the orangeslice SDK), so
  // the SDK stays out of this streaming handler.
  async function generateGtmPlaybook(): Promise<unknown> {
    try {
      const element = {
        topic: facts.summary || "short-form social clip",
        themes: [facts.audio, facts.subtitles ? "burned-in captions" : "minimal captions", `${facts.cut_count} cuts`, facts.on_screen_text].filter(Boolean),
        top_resonating_persona: "short-form social viewers in this niche",
        virality_score: 0.84,
        peak_moment_ts: Math.round((clip.peak_t ?? 2) * 1000),
      };
      const res = await fetch(new URL("/api/gtm", req.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ element }),
      });
      const data = (await res.json()) as { ok?: boolean; brief?: unknown; skillId?: string | null; error?: string };
      if (!data.ok || !data.brief) throw new Error(data.error || "GTM request failed");
      return { element, brief: data.brief, skillId: data.skillId ?? null };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Orange Slice unavailable", note: "Give general go-to-market advice grounded in the clip's characteristics instead." };
    }
  }

  const toolImpls: Record<string, () => Promise<unknown>> = {
    get_clip_characteristics: async () => facts,
    generate_gtm_playbook: generateGtmPlaybook,
  };

  const clipTool: OpenAI.Chat.ChatCompletionTool = {
    type: "function",
    function: { name: "get_clip_characteristics", description: "Return the analyzed content characteristics of the clip currently on screen.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  };
  const gtmTool: OpenAI.Chat.ChatCompletionTool = {
    type: "function",
    function: { name: "generate_gtm_playbook", description: "Use Orange Slice to turn the clip's virality element into a go-to-market playbook (recommended hooks, target audience, suggested channels). Also saves it as a reusable Orange Slice skill.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  };
  // both tools are always available so the model can reach for Orange Slice
  // whenever go-to-market comes up, regardless of mode.
  const tools = [clipTool, gtmTool];

  const client = new OpenAI({ apiKey });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: mode === "gtm" ? SYSTEM_GTM : SYSTEM_DECODE }];
  if (history.length === 0) {
    messages.push({
      role: "user",
      content:
        mode === "gtm"
          ? "Build a go-to-market playbook for this clip using Orange Slice, and tell me how to take it to market."
          : "Decode the clip currently on screen: what did the model learn, and why does it hold or lose attention?",
    });
  } else {
    for (const m of history) messages.push({ role: m.role, content: m.content });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const push = (s: string) => controller.enqueue(enc.encode(s));
      try {
        for (let hop = 0; hop < 5; hop++) {
          const completion = await client.chat.completions.create({ model: MODEL, messages, tools, tool_choice: "auto", stream: true });
          let content = "";
          const calls: { id: string; name: string; args: string }[] = [];
          for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta;
            if (delta?.content) {
              content += delta.content;
              push(delta.content);
            }
            for (const tc of delta?.tool_calls ?? []) {
              const i = tc.index ?? 0;
              calls[i] = calls[i] ?? { id: "", name: "", args: "" };
              if (tc.id) calls[i].id = tc.id;
              if (tc.function?.name) calls[i].name += tc.function.name;
              if (tc.function?.arguments) calls[i].args += tc.function.arguments;
            }
          }
          if (calls.length === 0) break; // model produced its final answer
          messages.push({
            role: "assistant",
            content: content || null,
            tool_calls: calls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args || "{}" } })),
          });
          for (const call of calls) {
            const impl = toolImpls[call.name];
            const out = impl ? await impl() : { error: "unknown tool" };
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
          }
        }
        controller.close();
      } catch {
        try { push(fallbackDecode(facts)); } catch { /* closed */ }
        try { controller.close(); } catch { /* closed */ }
      }
    },
  });

  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function fallbackDecode(facts: { summary: string; cut_count: number; subtitles: boolean; on_screen_text: string; model_predicted_peak_interest_at_s?: number }) {
  const peak = facts.model_predicted_peak_interest_at_s != null ? `${facts.model_predicted_peak_interest_at_s.toFixed(1)}s` : "the opening seconds";
  return [
    `${facts.summary || "This clip"} has the ingredients the model usually rewards: a fast hook, ${facts.cut_count} cuts, ${facts.subtitles ? "captions" : "sparse captions"}, and visible text "${facts.on_screen_text}".`,
    `The predicted attention peak is around ${peak}, so the opening has to land before the viewer scrolls.`,
  ].join(" ");
}
