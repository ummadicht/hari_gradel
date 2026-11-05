import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

// Serve device photos stored under data/uploads (kept out of the public dir).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ file: string }> }
) {
  const { file } = await params;
  // Prevent path traversal.
  if (!/^[a-z0-9._-]+$/i.test(file))
    return NextResponse.json({ error: "bad name" }, { status: 400 });

  const fp = path.join(process.cwd(), "data", "uploads", file);
  if (!fs.existsSync(fp))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const buf = fs.readFileSync(fp);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
