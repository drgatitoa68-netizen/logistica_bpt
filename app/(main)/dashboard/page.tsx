import { createClient } from "@/lib/supabase/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

async function getKpis(supabase: Awaited<ReturnType<typeof createClient>>) {
  const [pendientes, enProceso, completadasHoy, inventario, localizadores] = await Promise.all([
    supabase
      .from("lineas_reubicacion")
      .select("id", { count: "exact", head: true })
      .eq("estado", "pendiente"),
    supabase
      .from("lineas_reubicacion")
      .select("id", { count: "exact", head: true })
      .eq("estado", "en_proceso"),
    supabase
      .from("lineas_reubicacion")
      .select("id", { count: "exact", head: true })
      .eq("estado", "completada")
      .gte("updated_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
    supabase
      .from("inventario")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("localizadores")
      .select("pct_ocupacion")
      .eq("activo", true),
  ]);

  const locs = (localizadores.data ?? []) as { pct_ocupacion: number }[];
  const locsFull = locs.filter(l => l.pct_ocupacion >= 1.0).length;
  const locsTotal = locs.length;
  const avgOcup = locsTotal > 0
    ? locs.reduce((s, l) => s + l.pct_ocupacion, 0) / locsTotal
    : 0;

  return {
    pendientes:      pendientes.count  ?? 0,
    enProceso:       enProceso.count   ?? 0,
    completadasHoy:  completadasHoy.count ?? 0,
    inventarioTotal: inventario.count  ?? 0,
    locsFull,
    locsTotal,
    avgOcup,
  };
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const kpis = await getKpis(supabase);

  const modules = [
    {
      href: "/analisis-bpt",
      icon: "⬡",
      label: "ANÁLISIS BPT",
      desc: "Sube Excel, visualiza el mapa de planta y envía líneas a revisión",
      color: "#2563eb",
      border: "rgba(37,99,235,0.35)",
    },
    {
      href: "/inventario",
      icon: "📦",
      label: "INVENTARIO",
      desc: "Consulta el stock actual con filtros, ordenación y exportación a Excel",
      color: "#0891b2",
      border: "rgba(8,145,178,0.35)",
    },
    {
      href: "/ordenes-produccion",
      icon: "📋",
      label: "ÓRDENES PRODUCCIÓN",
      desc: "Aprueba, rechaza o fracciona líneas antes de enviarlas a operadores",
      color: "#f97316",
      border: "rgba(249,115,22,0.35)",
      badge: kpis.pendientes > 0 ? kpis.pendientes : undefined,
    },
    {
      href: "/operador",
      icon: "👷",
      label: "TAREAS OPERADOR",
      desc: "Ver tareas aprobadas y actualizar estado en tiempo real",
      color: "#7c3aed",
      border: "rgba(124,58,237,0.35)",
      badge: kpis.enProceso > 0 ? kpis.enProceso : undefined,
    },
    {
      href: "/ubicacion-produccion",
      icon: "🗺",
      label: "UBICACIÓN PRODUCCIÓN",
      desc: "Planifica dónde ubicar cada producto del subinventario PRODUCCION",
      color: "#d97706",
      border: "rgba(217,119,6,0.35)",
    },
    {
      href: "/reportes",
      icon: "📊",
      label: "REPORTES",
      desc: "Historial de operaciones, rendimiento por operador y exportación",
      color: "#059669",
      border: "rgba(5,150,105,0.35)",
    },
    {
      href: "/configuracion",
      icon: "⚙",
      label: "CONFIGURACIÓN",
      desc: "Gestiona capacidades, formatos, zonas y bloqueo de ubicaciones",
      color: "#64748b",
      border: "rgba(100,116,139,0.35)",
    },
  ];

  const pctOcup = Math.round(kpis.avgOcup * 100);

  const kpiCards = [
    {
      label:  "Órdenes Pendientes",
      value:  kpis.pendientes,
      icon:   "⏳",
      color:  kpis.pendientes > 0 ? "#f97316" : "#64748b",
      href:   "/ordenes-produccion",
      sub:    "Esperan aprobación",
    },
    {
      label:  "En Proceso",
      value:  kpis.enProceso,
      icon:   "⚡",
      color:  kpis.enProceso > 0 ? "#60a5fa" : "#64748b",
      href:   "/operador",
      sub:    "Tareas activas ahora",
    },
    {
      label:  "Completadas Hoy",
      value:  kpis.completadasHoy,
      icon:   "✓",
      color:  "#4ade80",
      href:   "/reportes",
      sub:    new Date().toLocaleDateString("es-EC", { weekday: "long", day: "numeric", month: "short" }),
    },
    {
      label:  "Registros Inventario",
      value:  kpis.inventarioTotal.toLocaleString("es"),
      icon:   "📦",
      color:  "#a78bfa",
      href:   "/inventario",
      sub:    "Último import",
    },
    {
      label:  "Ocupación Promedio",
      value:  `${pctOcup}%`,
      icon:   "⬡",
      color:  pctOcup >= 90 ? "#f87171" : pctOcup >= 70 ? "#fbbf24" : "#4ade80",
      href:   "/analisis-bpt",
      sub:    `${kpis.locsFull} locs al 100% de ${kpis.locsTotal}`,
    },
  ];

  return (
    <div style={s.root} className="page-root">
      <div style={s.header}>
        <div style={s.badge}>PANEL DE CONTROL</div>
        <h1 style={s.title}>Sistema Logístico BPT</h1>
        <p style={s.sub}>{user?.email}</p>
      </div>

      {/* KPI Bar */}
      <div style={s.kpiGrid}>
        {kpiCards.map(k => (
          <Link key={k.label} href={k.href} style={{ textDecoration: "none" }}>
            <div style={s.kpiCard}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 20 }}>{k.icon}</span>
                <span style={{ ...s.kpiValue, color: k.color }}>{k.value}</span>
              </div>
              <div style={s.kpiLabel}>{k.label}</div>
              <div style={s.kpiSub}>{k.sub}</div>
            </div>
          </Link>
        ))}
      </div>

      {/* Módulos */}
      <div style={s.sectionLabel}>MÓDULOS</div>
      <div style={s.grid}>
        {modules.map((m) => (
          <Link key={m.href} href={m.href} style={{ textDecoration: "none" }}>
            <div style={{ ...s.card, borderColor: m.border }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 28 }}>{m.icon}</span>
                {m.badge != null && (
                  <span style={{ ...s.cardBadge, background: m.color + "33", color: m.color }}>
                    {m.badge > 99 ? "99+" : m.badge}
                  </span>
                )}
              </div>
              <span style={{ ...s.cardLabel, color: m.color }}>{m.label}</span>
              <span style={s.cardDesc}>{m.desc}</span>
              <span style={{ ...s.arrow, color: m.color }}>→</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

const s: { [k: string]: React.CSSProperties } = {
  root:       { padding: "32px 28px", fontFamily: "'Courier New', monospace", color: "#1e293b", maxWidth: 1100, boxSizing: "border-box" },
  header:     { marginBottom: 28, display: "flex", flexDirection: "column", gap: 6 },
  badge:      { display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", width: "fit-content" },
  title:      { margin: 0, fontSize: 26, fontWeight: 700, color: "#0f172a", letterSpacing: 1 },
  sub:        { margin: 0, fontSize: 11, color: "#64748b" },
  kpiGrid:    { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 28 },
  kpiCard:    { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "16px 18px", cursor: "pointer", transition: "box-shadow 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" },
  kpiValue:   { fontSize: 24, fontWeight: 700, letterSpacing: -0.5, lineHeight: 1 },
  kpiLabel:   { fontSize: 11, fontWeight: 600, color: "#374151", letterSpacing: 0.5, marginBottom: 2 },
  kpiSub:     { fontSize: 10, color: "#94a3b8", letterSpacing: 0.3 },
  sectionLabel: { fontSize: 10, letterSpacing: 3, color: "#94a3b8", fontWeight: 600, marginBottom: 10 },
  grid:       { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 },
  card:       { background: "#ffffff", border: "1px solid", borderRadius: 8, padding: "22px 20px", display: "flex", flexDirection: "column", gap: 8, cursor: "pointer", transition: "box-shadow 0.2s", minHeight: 150, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" },
  cardLabel:  { fontSize: 10, letterSpacing: 2, fontWeight: 700 },
  cardDesc:   { fontSize: 11, color: "#64748b", lineHeight: 1.6 },
  cardBadge:  { fontSize: 11, fontWeight: 800, padding: "2px 8px", borderRadius: 20, letterSpacing: 0.5 },
  arrow:      { fontSize: 14, fontWeight: 700, marginTop: "auto" },
};
