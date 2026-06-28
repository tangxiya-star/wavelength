"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ExposureWaveform, durationFor, samplesUntil, type ReplayItem } from "@/components/ExposureWaveform";

interface ReplaySession {
  shortId: string;
  sessionId: string;
  items: ReplayItem[];
}

export default function LivePage() {
  const [items, setItems] = useState<ReplayItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const startedAtRef = useRef(0);
  const didAdvanceRef = useRef(false);

  useEffect(() => {
    fetch("/mocks/session-replay.json")
      .then((res) => res.json() as Promise<ReplaySession[]>)
      .then((sessions) => {
        const requestedSession = new URLSearchParams(window.location.search).get("session")?.trim();
        const selected = requestedSession
          ? sessions.filter((session) => session.shortId === requestedSession || session.sessionId === requestedSession)
          : sessions;
        setItems(selected.flatMap((session) => session.items));
      })
      .catch((error) => console.warn("[replay] could not load session replay", error));
  }, []);

  const activeItem = items[activeIndex];
  const activeDurationMs = useMemo(() => durationFor(activeItem), [activeItem]);

  useEffect(() => {
    if (!items.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;

        const nextIndex = Number((visible.target as HTMLElement).dataset.index);
        if (Number.isFinite(nextIndex)) setActiveIndex(nextIndex);
      },
      { threshold: [0.7, 0.85, 0.95] },
    );

    itemRefs.current.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [items]);

  useEffect(() => {
    if (!activeItem) return;
    startedAtRef.current = performance.now();
    didAdvanceRef.current = false;
    setElapsedMs(0);
  }, [activeItem?.exposureId]);

  useEffect(() => {
    if (!activeItem) return;

    let frame = 0;
    const tick = () => {
      const nextElapsed = Math.min(performance.now() - startedAtRef.current, activeDurationMs);
      setElapsedMs(nextElapsed);

      if (nextElapsed >= activeDurationMs && !didAdvanceRef.current) {
        didAdvanceRef.current = true;
        window.setTimeout(() => {
          const nextIndex = activeIndex + 1;
          const next = items[nextIndex];
          if (!next) return;
          itemRefs.current.get(next.exposureId)?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }, 140);
        return;
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, activeItem, activeDurationMs, items]);

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <div className="h-screen snap-y snap-mandatory overflow-y-auto scroll-smooth">
        {items.map((item, index) => {
          const active = index === activeIndex;
          return (
            <section
              key={item.exposureId}
              ref={(node) => {
                if (node) itemRefs.current.set(item.exposureId, node);
                else itemRefs.current.delete(item.exposureId);
              }}
              data-index={index}
              className="grid h-screen snap-start place-items-center bg-black px-8"
            >
              <ExposureWaveform
                durationMs={durationFor(item)}
                sourceSamples={item.samples}
                samples={active ? samplesUntil(item.samples, elapsedMs, durationFor(item)) : []}
              />
            </section>
          );
        })}
      </div>
    </div>
  );
}
