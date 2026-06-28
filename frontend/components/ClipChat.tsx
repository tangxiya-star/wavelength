"use client";
// Screen 1 middle column — a two-way chat about the clip on screen. Opens with
// the model's narration of what it learned (auto, on play), then the user can
// ask follow-ups. Streams from /api/decode, which runs a get_clip_characteristics
// tool-use loop on gpt-5.4-mini. Replaces the old tabs + related-clips grid.
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Video } from "@/lib/types";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export type ClipChatMode = "decode" | "gtm";

const CACHE_PREFIX = "wavelength:clip-chat:v1:";
const memoryReplyCache = new Map<string, string>();

// The opening "Pre-analysis" step — a fixed, content-level read of the clip shown
// the moment it loads (the live LLM decode takes over for follow-up questions).
// Demo-canned so the pop-up text is exact and reliable.
const PRE_ANALYSIS = `Office-humor skit from @cluely. The hook lands early: peak interest is around 2.2s, helped by captions, on-screen text, and quick VO/music cues.

**Read:**
- Fast premise: "can't you read the sign?"
- Tight pacing: 29 cuts in 55s
- Risk: the joke needs escalation after the initial hook`;

export default function ClipChat({
  video,
  peakT,
  mode,
  onModeChange,
}: {
  video?: Video;
  peakT?: number | null;
  mode: ClipChatMode;
  onModeChange: (mode: ClipChatMode) => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clip = video && {
    characteristics: video.characteristics,
    creator: video.metadata.creator,
    duration_ms: video.metadata.duration_ms,
    peak_t: peakT ?? null,
  };
  const localReply = useCallback(
    (history: Msg[]) => localAnalystReply(video, peakT, history.at(-1)?.role === "user" ? history.at(-1)?.content : undefined),
    [video, peakT],
  );

  // stream an assistant reply for the given history (excludes the empty assistant shell)
  const run = useCallback(
    async (history: Msg[]) => {
      if (!clip) return;
      if (mode === "gtm" && history.length === 0) {
        setBusy(false);
        setMessages([{ role: "assistant", content: localGtmOpening(video, peakT) }]);
        return;
      }
      // The pre-analysis step: a fixed opening read of the clip (live LLM decode
      // only kicks in once the user asks a follow-up).
      if (mode === "decode" && history.length === 0) {
        setBusy(false);
        setMessages([{ role: "assistant", content: PRE_ANALYSIS }]);
        return;
      }

      const key = cacheKey(buildClipCachePayload(clip), mode, history);
      const cached = readCachedReply(key);
      if (cached) {
        setBusy(false);
        setMessages([...history, { role: "assistant", content: cached }]);
        return;
      }
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setBusy(true);
      setMessages(history);
      try {
        const res = await fetch("/api/decode", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clip, mode, messages: history.map((m) => ({ role: m.role, content: m.content })) }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const content = localReply(history);
          if (content) writeCachedReply(key, content);
          setMessages(content ? [...history, { role: "assistant", content }] : history);
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let acc = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += dec.decode(value, { stream: true });
          setMessages([...history, { role: "assistant", content: acc }]);
        }
        if (acc && !ctrl.signal.aborted) writeCachedReply(key, acc);
      } catch {
        if (!ctrl.signal.aborted) {
          const content = localReply(history);
          if (content) writeCachedReply(key, content);
          setMessages(content ? [...history, { role: "assistant", content }] : history);
        }
      } finally {
        setBusy(false);
      }
    },
    [clip, localReply, mode],
  );

  // (re)open the conversation whenever the clip OR the mode changes
  useEffect(() => {
    if (!video) return;
    run([]);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.video_id, mode]);

  // keep pinned to the latest message
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const history = [...messages.filter((m) => m.content), { role: "user" as const, content: text }];
    run(history);
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto pr-1">
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-md bg-neutral-100 px-3 py-1.5 text-xs leading-relaxed text-neutral-900">{m.content}</div>
            </div>
          ) : (
            <div key={i} className="space-y-1.5">
              <div className="flex items-center justify-between gap-3 text-[11px] text-neutral-500">
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${mode === "gtm" ? "bg-orange-400" : "bg-[#9fe9ff]"}`} />
                  {mode === "gtm" ? "GTM strategist" : i === 0 ? "Pre-analysis" : "Wavelength Analyst"}
                </div>
                <div className="flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-wide text-white">
                  <span>powered by</span>
                  <img src="/openai-logo.svg" alt="OpenAI" className="h-7 w-7" draggable={false} />
                  {mode === "gtm" && <span className="text-neutral-500">+</span>}
                  {mode === "gtm" && <img src="/orange-slice.svg" alt="Orange Slice" className="h-5 w-10" draggable={false} />}
                </div>
              </div>
              <div className="space-y-1.5 text-xs leading-relaxed text-[#cfeeff]">
                <MarkdownText content={m.content} />
                {busy && i === messages.length - 1 && (
                  <span className="inline-block h-3.5 w-[3px] animate-pulse bg-[#9fe9ff] align-middle" />
                )}
              </div>
            </div>
          ),
        )}
      </div>

      {/* composer */}
      <div className="mt-3 rounded-2xl border border-neutral-700 bg-neutral-900/60 p-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          aria-label={mode === "gtm" ? "Ask about go-to-market" : "Ask about this clip"}
          placeholder={mode === "gtm" ? "Ask about go-to-market…" : "Ask about this clip…"}
          className="w-full bg-transparent px-2 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
        />
        <div className="flex items-center justify-between px-1 pt-1">
          <div className="flex items-center rounded-full border border-neutral-700 p-0.5 text-[10px]" role="tablist" aria-label="Chat mode">
            <button
              type="button"
              onClick={() => onModeChange("decode")}
              className={`rounded-full px-2.5 py-0.5 transition-colors ${mode === "decode" ? "bg-[#2f8fd6] text-white" : "text-neutral-400 hover:text-neutral-200"}`}
            >
              Wavelength Analyst
            </button>
            <button
              type="button"
              onClick={() => onModeChange("gtm")}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 transition-colors ${mode === "gtm" ? "bg-orange-500 text-white" : "text-neutral-400 hover:text-neutral-200"}`}
            >
              <span>GTM</span>
              <img src="/orange-slice.svg" alt="" className="h-3.5 w-7" draggable={false} />
            </button>
          </div>
          <button
            type="button"
            onClick={send}
            disabled={!input.trim() || busy}
            aria-label="Send"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2f8fd6] text-white transition-opacity disabled:opacity-30"
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}

function MarkdownText({ content }: { content: string }) {
  const blocks: ReactNode[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const Tag = heading[1].length === 1 ? "h3" : "h4";
      blocks.push(
        <Tag key={i} className="pt-1 text-[12px] font-semibold leading-snug text-neutral-100">
          {renderInlineMarkdown(heading[2])}
        </Tag>,
      );
      continue;
    }

    const bulletItems: string[] = [];
    while (i < lines.length) {
      const match = /^\s*[-*]\s+(.+)$/.exec(lines[i]);
      if (!match) break;
      bulletItems.push(match[1]);
      i++;
    }
    if (bulletItems.length) {
      i--;
      blocks.push(
        <ul key={i} className="ml-3.5 list-disc space-y-0.5 marker:text-neutral-500">
          {bulletItems.map((item, index) => (
            <li key={index} className="pl-0.5">
              {renderInlineMarkdown(item)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    const numberedItems: string[] = [];
    while (i < lines.length) {
      const match = /^\s*\d+\.\s+(.+)$/.exec(lines[i]);
      if (!match) break;
      numberedItems.push(match[1]);
      i++;
    }
    if (numberedItems.length) {
      i--;
      blocks.push(
        <ol key={i} className="ml-3.5 list-decimal space-y-0.5 marker:text-neutral-500">
          {numberedItems.map((item, index) => (
            <li key={index} className="pl-0.5">
              {renderInlineMarkdown(item)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    blocks.push(
      <p key={i} className="my-1">
        {renderInlineMarkdown(line)}
      </p>,
    );
  }

  return <>{blocks}</>;
}

function renderInlineMarkdown(text: string) {
  const nodes: ReactNode[] = [];
  const pattern = /(\[([^\]]+)]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));

    const key = `${match.index}-${match[0]}`;
    if (match[2] && match[3]) {
      nodes.push(
        <a key={key} href={match[3]} target="_blank" rel="noreferrer" className="text-[#9fe9ff] underline decoration-[#9fe9ff]/45 underline-offset-2">
          {match[2]}
        </a>,
      );
    } else if (match[4]) {
      nodes.push(
        <code key={key} className="rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-[#9fe9ff]">
          {match[4]}
        </code>,
      );
    } else if (match[5]) {
      nodes.push(
        <strong key={key} className="font-semibold text-neutral-100">
          {match[5]}
        </strong>,
      );
    } else if (match[6]) {
      nodes.push(
        <em key={key} className="italic text-neutral-100">
          {match[6]}
        </em>,
      );
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>);
}

function cacheKey(clip: NonNullable<ReturnType<typeof buildClipCachePayload>>, mode: ClipChatMode, history: Msg[]) {
  return `${CACHE_PREFIX}${hashStableJson({ clip, mode, history: history.map((m) => ({ role: m.role, content: m.content })) })}`;
}

function buildClipCachePayload(clip: {
  characteristics: Video["characteristics"];
  creator: string;
  duration_ms: number;
  peak_t: number | null;
}) {
  return {
    id: `${clip.creator}:${clip.duration_ms}:${clip.peak_t ?? "none"}`,
    characteristics: clip.characteristics,
  };
}

function readCachedReply(key: string) {
  const inMemory = memoryReplyCache.get(key);
  if (inMemory) return inMemory;
  try {
    const stored = window.sessionStorage.getItem(key);
    if (stored) memoryReplyCache.set(key, stored);
    return stored;
  } catch {
    return null;
  }
}

function writeCachedReply(key: string, content: string) {
  memoryReplyCache.set(key, content);
  try {
    window.sessionStorage.setItem(key, content);
  } catch {
    // The in-memory cache still covers remounts when sessionStorage is unavailable.
  }
}

function hashStableJson(value: unknown) {
  const input = JSON.stringify(value);
  let hash = 5381;
  for (let i = 0; i < input.length; i++) hash = (hash * 33) ^ input.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

function localGtmOpening(video?: Video, peakT?: number | null) {
  const c = video?.characteristics;
  if (!c) return "Orange Slice mode is ready. Ask me who to target, what hook to lead with, or where to distribute this clip.";

  const hook = c.transcript_summary.split("—")[0].trim() || "This clip";
  const peak = peakT != null ? `${peakT.toFixed(1)}s` : "the opening seconds";
  return [
    `**GTM angle:** lead with "${hook}".`,
    `Target people who recognize the situation, and use the ${peak} spike as proof the opener works.`,
    `Ask for channels, ICP, outbound copy, or a full playbook.`,
  ].join("\n");
}

function localAnalystReply(video?: Video, peakT?: number | null, question?: string) {
  const c = video?.characteristics;
  if (!c || !question) return "";

  const peak = peakT != null ? `${peakT.toFixed(1)}s` : "the opening seconds";
  const hook = c.transcript_summary.split("—")[0].trim();
  const base = `${hook} reads as a fast, legible short-form setup: quick cuts, ${c.subtitles ? "captions" : "minimal captions"}, and ${c.audio || "audio"}. The expected attention peak is around ${peak}.`;

  const q = question.toLowerCase();
  if (q.includes("why") || q.includes("win") || q.includes("work")) {
    return `${base} It works because the viewer does not need context: the premise lands immediately, the captions reduce listening effort, and the pacing keeps visual change high enough to prevent drift.`;
  }
  if (q.includes("improve") || q.includes("better") || q.includes("change")) {
    return `The highest-leverage change is to sharpen the first two seconds: make the premise readable in one glance, keep captions on-screen, and avoid slowing the edit before the predicted ${peak} spike.`;
  }
  if (q.includes("cut") || q.includes("pace")) {
    return `${c.cut_count} cuts gives this reel a high-change rhythm. For this format, the model is rewarding quick context shifts more than cinematic continuity.`;
  }
  return base;
}
