// NeuroViral → Orange Slice (GTM) integration demo.
//
// Flow (matches the team plan):
//   EEG interest spike  ──abstract──▶  virality element
//   { topic, themes[], top_resonating_persona, virality_score, peak_moment_ts }
//        │
//        ├─ services.ai.generateObject → a GTM brief: the hooks that work for
//        │                               this genre + who to target
//        └─ skills.create → store it as an Orange Slice knowledge skill, so when
//                           anyone uses Orange Slice for GTM/social they get
//                           pointed at these hooks for this genre.
//
// Run:  node scripts/orangeslice/gtm.mjs
// Auth: uses ~/.config/orangeslice/config.json (from `npx orangeslice login`).

import { services, skills } from "orangeslice";

// 1) The virality element abstracted from the now-playing clip's EEG spike.
const element = {
  topic: "office-humor / coworker skits (Tech UGC)",
  themes: ["relatable coworker", "no-filter honesty", "tag-a-coworker CTA", "burned-in captions"],
  top_resonating_persona: "B2B SaaS / startup employees, 22–32",
  virality_score: 0.86,
  peak_moment_ts: 2000,
};

console.log("→ virality element:\n", JSON.stringify(element, null, 2), "\n");

// 2) Turn the element into a GTM hook brief via Orange Slice's AI service.
const brief = await services.ai.generateObject({
  prompt:
    "You are a short-form growth strategist. Given this neural-virality element " +
    "(derived from real EEG interest spikes), produce a GTM brief for this genre.\n" +
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

const briefObj = brief?.object ?? brief;
console.log("→ Orange Slice GTM brief:\n", JSON.stringify(briefObj, null, 2), "\n");

// 3) Register the insight as a reusable Orange Slice skill (the "point GTM users
//    at these hooks for this genre" step).
const skill = await skills.create({
  title: `Viral hooks — ${element.topic}`,
  description: `Neural-validated hooks for ${element.topic} (virality ${element.virality_score}).`,
  content: JSON.stringify({ element, brief: briefObj }, null, 2),
});

console.log("→ Orange Slice skill created:\n", JSON.stringify(skill, null, 2));
