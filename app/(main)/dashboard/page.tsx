import { createClient } from "@/lib/supabase/server";
import Link from "next/link";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const modules = [
    {
      href: "/analisis-bpt",
      icon: "⬡",
      label: "ANÁLISIS BPT",
      desc: "Mapa de planta y ocupación real de localizadores",
      color: "#2563eb",
      border: "rgba(37,99,235,0.35)",
    },
    {
      href: "/subir-archivo",
      icon: "📂",
      label: "SUBIR ARCHIVO",
      desc: "Carga Excel de stock o mapa de planta (CAL_LOC)",
      color: "#f97316",
      border: "rgba(249,115,22,0.35)",
    },
    {
      href: "/ordenes-produccion",
      icon: "📋",
      label: "ÓRDENES DE PRODUCCIÓN",
      desc: "Revisar y aprobar órdenes para operadores",
      color: "#16a34a",
      border: "rgba(22,163,74,0.35)",
    },
    {
      href: "/operador",
      icon: "👷",
      label: "TAREAS OPERADOR",
      desc: "Ver tareas asignadas y actualizar su estado",
      color: "#7c3aed",
      border: "rgba(124,58,237,0.35)",
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
      href: "/configuracion",
      icon: "⚙",
      label: "CONFIGURACIÓN",
      desc: "Gestiona capacidades, formatos y bloqueo de ubicaciones",
      color: "#0891b2",
      border: "rgba(8,145,178,0.35)",
    },
  ];

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div style={s.badge}>PANEL DE CONTROL</div>
        <h1 style={s.title}>Sistema Logístico</h1>
        <p style={s.sub}>{user?.email}</p>
      </div>

      <div style={s.grid}>
        {modules.map((m) => (
          <Link key={m.href} href={m.href} style={{ textDecoration: "none" }}>
            <div style={{ ...s.card, borderColor: m.border }}>
              <span style={{ fontSize: 32 }}>{m.icon}</span>
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
  root: { padding: "40px 32px", fontFamily: "'Courier New', monospace", color: "#1e293b", maxWidth: 900 },
  header: { marginBottom: 36, display: "flex", flexDirection: "column", gap: 8 },
  badge: { display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", width: "fit-content" },
  title: { margin: 0, fontSize: 28, fontWeight: 700, color: "#0f172a", letterSpacing: 1 },
  sub: { margin: 0, fontSize: 12, color: "#64748b" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 },
  card: { background: "#ffffff", border: "1px solid", borderRadius: 4, padding: "28px 24px", display: "flex", flexDirection: "column", gap: 10, cursor: "pointer", transition: "background 0.2s", minHeight: 160 },
  cardLabel: { fontSize: 11, letterSpacing: 2, fontWeight: 700 },
  cardDesc: { fontSize: 12, color: "#64748b", lineHeight: 1.6 },
  arrow: { fontSize: 16, fontWeight: 700, marginTop: "auto" },
};
