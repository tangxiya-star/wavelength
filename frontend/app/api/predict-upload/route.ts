// POST /api/predict-upload — multipart upload of a video file. Runs the model
// pipeline on it (extract_features -> SigLIP/CLAP embeddings -> predict_waveform
// via model/analyze_upload.py) and returns the parsed content characteristics +
// the model's predicted EEG interest curve. ~15-25s; the UI shows progress.
//
// Returns: { video_id, duration_ms, characteristics, curve: { t, interest, peak_t } }
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import cluelyAnalysis from "@/lib/cluely-analysis.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby cap; the cached @cluely path returns instantly anyway

// The @cluely demo reel (public/clips/video.mp4 / demoVideo/Boom1.mp4) is the
// clip we present. Its analysis is pre-saved, so uploading that exact file skips
// the ~15-25s model pipeline and returns instantly. Match by content hash so a
// rename (Boom1.mp4, video.mp4, …) still hits the cache.
const CLUELY_MD5 = "c8d41dbaaeee52d7a7622ed28d0f8a42";

const REPO = join(process.cwd(), ".."); // frontend/ -> repo root
const PY = process.env.PYTHON_BIN || "python3";

function extOf(name: string, type: string): string {
  const m = /\.(mp4|mov|webm|m4v)$/i.exec(name || "");
  if (m) return m[0].toLowerCase();
  if (type.includes("webm")) return ".webm";
  if (type.includes("quicktime")) return ".mov";
  return ".mp4";
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  const file = form.get("video");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "no video file" }, { status: 400 });
  }
  if (file.size > 100 * 1024 * 1024) {
    return Response.json({ error: "video too large (max 100MB)" }, { status: 413 });
  }

  // read the bytes once, up front: we need them to hash (cache check) and to
  // write to disk for the pipeline if it's not the cached clip.
  const buf = Buffer.from(await file.arrayBuffer());

  // fast path: the known @cluely demo clip → return its saved analysis instantly.
  if (createHash("md5").update(buf).digest("hex") === CLUELY_MD5) {
    return Response.json(cluelyAnalysis);
  }

  const id = `upload-${randomUUID().slice(0, 8)}`;
  const dir = join(REPO, "model", "uploads", id);
  const videoPath = join(dir, `${id}${extOf(file.name, file.type)}`);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(videoPath, buf);

    const out = await new Promise<string>((resolve, reject) => {
      const proc = spawn(PY, [join(REPO, "model", "analyze_upload.py"), "--video", videoPath, "--id", id], {
        cwd: REPO,
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d));
      proc.stderr.on("data", (d) => (stderr += d));
      proc.on("error", reject);
      proc.on("close", (code) =>
        code === 0 ? resolve(stdout) : reject(new Error(stderr.split("\n").slice(-6).join("\n") || `exit ${code}`)),
      );
    });

    const result = JSON.parse(out.trim().split("\n").pop() || "{}");
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "analysis failed";
    return Response.json({ error: message }, { status: 500 });
  } finally {
    // keep the features/embeddings (cheap, reusable); drop the uploaded video blob
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
