import { createReadStream, readdirSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { Readable } from "node:stream";

export const runtime = "nodejs";

const repoRoot = join(process.cwd(), "..");
const searchRoots = [
  join(repoRoot, "sponsor-videos"),
  join(repoRoot, "assets", "videos"),
  join(repoRoot, "dist", "assets", "assets", "videos"),
  join(repoRoot, "scripts", "ig-reels-scraper", "ig-data", "selected-downloads"),
];

function findVideo(root: string, key: string): string | null {
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = normalize(join(root, entry.name));
      if (!candidate.startsWith(normalize(root))) continue;
      if (entry.isFile() && entry.name === key) return candidate;
      if (entry.isDirectory()) {
        const nested = findVideo(candidate, key);
        if (nested) return nested;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function contentTypeFor(key: string): string {
  if (key.endsWith(".webm")) return "video/webm";
  if (key.endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
}

export async function GET(req: Request, { params }: { params: { key: string } }) {
  const key = decodeURIComponent(params.key);
  if (!/^[\w.-]+$/.test(key)) return new Response("Not found", { status: 404 });

  const filePath = searchRoots.map((root) => findVideo(root, key)).find((path): path is string => !!path);
  if (!filePath) return new Response("Not found", { status: 404 });

  const size = statSync(filePath).size;
  const baseHeaders = {
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600",
    "content-type": contentTypeFor(key),
  };

  const range = req.headers.get("range");
  const match = range?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2] ? Math.min(Number.parseInt(match[2], 10), size - 1) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      });
    }

    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${size}`,
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new Response(stream, {
    headers: {
      ...baseHeaders,
      "content-length": String(size),
    },
  });
}
