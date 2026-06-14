import { createClient } from "@/lib/supabase/server";

// ── Helpers ────────────────────────────────────────────────────────────────

function startOfDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
}

function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

function startOfNMonthsAgo(n: number, from = new Date()) {
  return new Date(from.getFullYear(), from.getMonth() - n, 1).toISOString();
}

function monthLabel(offset: number, from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth() - offset, 1);
  return d.toLocaleDateString("es-EC", { month: "short", year: "2-digit" }).toUpperCase();
}

function dayLabel(offset: number, from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() - offset);
  return d.toLocaleDateString("es-EC", { weekday: "short", day: "numeric" }).toUpperCase();
}

// ── Data fetching ──────────────────────────────────────────────────────────

async function fetchDashboardData() {
  const db = await createClient();
  const now = new Date();

  const [lineasResp, locResp] = await Promise.all([
    db.from("lineas_reubicacion").select(
      "id,estado,pallets,fin_operador,inicio_operador,duracion_minutos,created_at"
    ),
    db.from("localizadores").select("capacidad,ocupado,disponible,pct_ocupacion,activo").eq("activo", true),
  ]);

  const lineas = lineasResp.data ?? [];
  const locs = locResp.data ?? [];

  // ── Pipeline ────────────────────────────────────────────────────────────
  const pipeline = {
    pendiente: 0, aprobada: 0, en_proceso: 0, completada: 0, rechazada: 0,
  };
  for (const l of lineas) {
    if (l.estado in pipeline) pipeline[l.estado as keyof typeof pipeline]++;
  }

  // ── Pallets completados hoy y este mes ──────────────────────────────────
  const todayStart = startOfDay(now);
  const monthStart = startOfMonth(now);

  let palletsHoy = 0, palletsEstesMes = 0, avgDuracion = 0;
  const duraciones: number[] = [];

  for (const l of lineas) {
    if (l.estado !== "completada" || !l.fin_operador) continue;
    const fin = l.fin_operador as string;
    if (fin >= todayStart) palletsHoy += l.pallets ?? 0;
    if (fin >= monthStart) {
      palletsEstesMes += l.pallets ?? 0;
      if (l.duracion_minutos) duraciones.push(l.duracion_minutos);
    }
  }
  if (duraciones.length) {
    avgDuracion = Math.round((duraciones.reduce((s, d) => s + d, 0) / duraciones.length) * 10) / 10;
  }

  // ── Pallets por día (últimos 7 días) ────────────────────────────────────
  const palletsByDay: { label: string; pallets: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i).toISOString();
    const dayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1).toISOString();
    const total = lineas
      .filter(l => l.estado === "completada" && l.fin_operador >= dayStart && l.fin_operador < dayEnd)
      .reduce((s: number, l) => s + (l.pallets ?? 0), 0);
    palletsByDay.push({ label: dayLabel(i, now), pallets: total });
  }

  // ── Pallets por mes (últimos 6 meses) ───────────────────────────────────
  const palletsByMonth: { label: string; pallets: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const mStart = startOfNMonthsAgo(i, now);
    const mEnd   = startOfNMonthsAgo(i - 1, now);
    const total = lineas
      .filter(l => l.estado === "completada" && l.fin_operador >= mStart && l.fin_operador < mEnd)
      .reduce((s: number, l) => s + (l.pallets ?? 0), 0);
    palletsByMonth.push({ label: monthLabel(i, now), pallets: total });
  }

  // ── Localizadores ───────────────────────────────────────────────────────
  const totalCap  = locs.reduce((s, l) => s + (l.capacidad ?? 0), 0);
  const totalOcup = locs.reduce((s, l) => s + (l.ocupado ?? 0), 0);
  const totalLibre = locs.reduce((s, l) => s + Math.max(0, l.disponible ?? 0), 0);
  const conExceso = locs.filter(l => l.pct_ocupacion > 1.0).length;
  const avgOcupacion = totalCap > 0 ? totalOcup / totalCap : 0;

  return {
    pipeline,
    palletsHoy,
    palletsEstesMes,
    avgDuracion,
    palletsByDay,
    palletsByMonth,
    totalLineas: lineas.length,
    totalLocs: locs.length,
    totalCap,
    totalOcup,
    totalLibre,
    conExceso,
    avgOcupacion,
  };
}

// ── Sub-components ─────────────────────────────────────────────────────────

function BarChart({
  data,
  color = "#f97316",
  height = 80,
}: {
  data: { label: string; pallets: number }[];
  color?: string;
  height?: number;
}) {
  const max = Math.max(...data.map(d => d.pallets), 1);
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height, width: "100%" }}>
      {data.map((d, i) => {
        const pct = (d.pallets / max) * 100;
        return (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, height: "100%", justifyContent: "flex-end" }}>
            <span style={{ fontSize: 9, color: "#6b7280", letterSpacing: 0.5 }}>{d.pallets > 0 ? d.pallets : ""}</span>
            <div style={{ width: "100%", height: `${Math.max(pct, d.pallets > 0 ? 4 : 1)}%`, background: d.pallets > 0 ? color : "rgba(249,115,22,0.08)", borderRadius: "2px 2px 0 0", transition: "height 0.3s" }} />
            <span style={{ fontSize: 7.5, color: "#374151", letterSpacing: 0.5, whiteSpace: "nowrap", overflow: "hidden", maxWidth: "100%", textAlign: "center" }}>{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function StatCard({ label, value, color = "#e2e8f0", sub }: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <div style={{ background: "#0d1117", border: "1px solid rgba(249,115,22,0.1)", borderRadius: 3, padding: "14px 18px", flex: 1, minWidth: 100 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color, letterSpacing: 0.5 }}>{value}</div>
      <div style={{ fontSize: 9, letterSpacing: 2, color: "#374151", marginTop: 3, fontWeight: 700 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: "#4a5568", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();

  const data = await fetchDashboardData();

  const {
    pipeline, palletsHoy, palletsEstesMes, avgDuracion,
    palletsByDay, palletsByMonth,
    totalLineas, totalLocs, totalCap, totalOcup, totalLibre,
    conExceso, avgOcupacion,
  } = data;


  const pipelineItems = [
    { key: "pendiente",  label: "PENDIENTES",  val: pipeline.pendiente,  color: "#fbbf24" },
    { key: "aprobada",   label: "APROBADAS",   val: pipeline.aprobada,   color: "#4ade80" },
    { key: "en_proceso", label: "EN PROCESO",  val: pipeline.en_proceso, color: "#60a5fa" },
    { key: "completada", label: "COMPLETADAS", val: pipeline.completada, color: "#a78bfa" },
    { key: "rechazada",  label: "RECHAZADAS",  val: pipeline.rechazada,  color: "#f87171" },
  ];
  const maxPipeline = Math.max(...pipelineItems.map(p => p.val), 1);

  return (
    <div style={{ padding: "28px 24px", fontFamily: "'Courier New', monospace", color: "#e2e8f0", background: "#0a0e17", minHeight: "100vh" }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", marginBottom: 10 }}>
          PANEL DE CONTROL
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: "#fff", letterSpacing: 1 }}>Sistema Logístico BPT</h1>
            <p style={{ margin: "4px 0 0", fontSize: 11, color: "#4a5568" }}>{user?.email}</p>
          </div>
        </div>
      </div>

      {/* KPIs principales */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <StatCard label="PALLETS HOY"       value={palletsHoy}       color="#f97316" sub="líneas completadas" />
        <StatCard label="PALLETS ESTE MES"  value={palletsEstesMes}  color="#fbbf24" sub="acumulado del mes" />
        <StatCard label="DURACIÓN MEDIA"    value={avgDuracion > 0 ? `${avgDuracion} min` : "—"} color="#60a5fa" sub="por línea este mes" />
        <StatCard label="TOTAL LÍNEAS"      value={totalLineas}      color="#e2e8f0" sub="historial completo" />
        <StatCard label="LIBRES"            value={totalLibre}       color="#4ade80" sub="pallets disponibles" />
        <StatCard label="OCUPACIÓN GLOBAL"  value={`${(avgOcupacion * 100).toFixed(1)}%`} color={avgOcupacion > 1 ? "#f87171" : avgOcupacion > 0.8 ? "#fbbf24" : "#4ade80"} sub={`${conExceso} loc con exceso`} />
      </div>

      {/* Gráficos */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>

        {/* Pallets por día */}
        <div style={{ background: "#0d1117", border: "1px solid rgba(249,115,22,0.1)", borderRadius: 3, padding: "16px 18px" }}>
          <div style={{ fontSize: 9, letterSpacing: 3, color: "#f97316", fontWeight: 700, marginBottom: 12 }}>PALLETS MOVIDOS — ÚLTIMOS 7 DÍAS</div>
          <BarChart data={palletsByDay} color="#f97316" height={90} />
        </div>

        {/* Pallets por mes */}
        <div style={{ background: "#0d1117", border: "1px solid rgba(249,115,22,0.1)", borderRadius: 3, padding: "16px 18px" }}>
          <div style={{ fontSize: 9, letterSpacing: 3, color: "#fbbf24", fontWeight: 700, marginBottom: 12 }}>PALLETS MOVIDOS — ÚLTIMOS 6 MESES</div>
          <BarChart data={palletsByMonth} color="#fbbf24" height={90} />
        </div>
      </div>

      {/* Pipeline de órdenes */}
      <div style={{ background: "#0d1117", border: "1px solid rgba(249,115,22,0.1)", borderRadius: 3, padding: "16px 18px", marginBottom: 20 }}>
        <div style={{ fontSize: 9, letterSpacing: 3, color: "#e2e8f0", fontWeight: 700, marginBottom: 14 }}>PIPELINE DE ÓRDENES</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {pipelineItems.map(p => (
            <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 90, fontSize: 9, letterSpacing: 1.5, color: p.color, fontWeight: 700, flexShrink: 0 }}>{p.label}</div>
              <div style={{ flex: 1, height: 16, background: "#080c14", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(p.val / maxPipeline) * 100}%`, background: p.color, opacity: 0.7, borderRadius: 2, minWidth: p.val > 0 ? 4 : 0 }} />
              </div>
              <div style={{ width: 28, textAlign: "right", fontSize: 12, fontWeight: 700, color: p.color }}>{p.val}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Localizadores summary */}
      <div style={{ background: "#0d1117", border: "1px solid rgba(249,115,22,0.1)", borderRadius: 3, padding: "16px 18px", marginBottom: 20 }}>
        <div style={{ fontSize: 9, letterSpacing: 3, color: "#e2e8f0", fontWeight: 700, marginBottom: 14 }}>MAPA DE LOCALIZADORES</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          {[
            { l: "LOCALIZADORES", v: totalLocs, c: "#e2e8f0" },
            { l: "CAPACIDAD TOTAL", v: totalCap + " plt", c: "#e2e8f0" },
            { l: "OCUPADO", v: totalOcup + " plt", c: "#fbbf24" },
            { l: "DISPONIBLE", v: totalLibre + " plt", c: "#4ade80" },
            { l: "CON EXCESO", v: conExceso, c: conExceso > 0 ? "#f87171" : "#374151" },
          ].map(({ l, v, c }) => (
            <div key={l} style={{ background: "#080c14", borderRadius: 2, padding: "8px 14px", flex: 1, minWidth: 90 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: c }}>{v}</div>
              <div style={{ fontSize: 8, letterSpacing: 2, color: "#374151", marginTop: 2 }}>{l}</div>
            </div>
          ))}
        </div>
        {/* Barra de ocupación global */}
        <div style={{ marginTop: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#374151", marginBottom: 4 }}>
            <span>OCUPACIÓN GLOBAL</span>
            <span style={{ color: avgOcupacion > 1 ? "#f87171" : "#4ade80", fontWeight: 700 }}>{(avgOcupacion * 100).toFixed(1)}%</span>
          </div>
          <div style={{ height: 8, background: "#080c14", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.min(100, avgOcupacion * 100)}%`, background: avgOcupacion > 1 ? "#f87171" : avgOcupacion > 0.8 ? "#fbbf24" : "#4ade80", borderRadius: 4 }} />
          </div>
        </div>
      </div>

    </div>
  );
}
