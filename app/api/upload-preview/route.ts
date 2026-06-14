import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

export async function POST(req: NextRequest) {
  const sb = await createClient();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const formData = await req.formData();

  try {
    const backendRes = await fetch(`${BACKEND}/upload/preview`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
      body: formData,
    });
    const data = await backendRes.json();
    return NextResponse.json(data, { status: backendRes.status });
  } catch (e) {
    return NextResponse.json(
      { error: `Backend no disponible: ${String(e)}` },
      { status: 503 },
    );
  }
}
