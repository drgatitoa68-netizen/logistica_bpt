"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { getBrowserClient } from "@/lib/supabase/browser";
import { Linea, viajesPorLinea } from "@/lib/shared/ordenes";
import { debounce } from "@/lib/utils/debounce";
import { iniciarLinea, finalizarLinea } from "@/app/actions/ordenes";

const db = getBrowserClient();

function Timer({ startIso }: { startIso: string }) {
  const [elapsed, setElapsed] = useState(0);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const start = new Date(startIso).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    ref.current = setInterval(tick, 1000);
    return () => { if (ref.current) clearInterval(ref.current); };
  }, [startIso]);

  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  return (
    <span style={{ fontFamily: "monospace", color: "#60a5fa", fontWeight: 700, fontSize: 13 }}>
      {h > 0 ? `${h}:` : ""}{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </span>
  );
}

export default function OperadorPage() {
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro] = useState<"aprobada" | "en_proceso" | "completada" | "todas">("aprobada");
  const [saving, setSaving] = useState<string | null>(null);
  const [flash, setFlash] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await db
      .from("lineas_reubicacion")
      .select("*")
      .in("estado", ["aprobada", "en_proceso", "completada"])
      .order("updated_at", { ascending: false });
    if (!error && data) setLineas(data as Linea[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // Debounced reload — under high write load, batch rapid events into one fetch
    const debouncedLoad = debounce(load, 800);
    const ch = db.channel("op_realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "lineas_reubicacion" }, debouncedLoad)
      .subscribe();
    return () => { db.removeChannel(ch); };
  }, [load]);

  const showFlash = (msg: string) => { setFlash(msg); setTimeout(() => setFlash(""), 3000); };

  async function handleIniciar(id: string) {
    setSaving(id);
    const res = await iniciarLinea(id);
    setSaving(null);
    if (res?.error) { showFlash("❌ " + res.error); return; }
    showFlash("⚙ Tarea iniciada — ¡a trabajar!");
    load();
  }

  async function handleFinalizar(id: string, inicioIso: string) {
    setSaving(id);
    const res = await finalizarLinea(id, inicioIso);
    setSaving(null);
    if (res?.error) { showFlash("❌ " + res.error); return; }
    showFlash(`✓ Tarea completada en ${res.duracion?.toFixed(1)} min`);
    load();
  }

  const filtradas = filtro === "todas" ? lineas : lineas.filter(l => l.estado === filtro);

  const stats = {
    asignadas: lineas.filter(l => l.estado === "aprobada").length,
    enProceso: lineas.filter(l => l.estado === "en_proceso").length,
    completadas: lineas.filter(l => l.estado === "completada").length,
    totalViajes: lineas.filter(l => l.estado !== "completada").reduce((s, l) => s + viajesPorLinea(l.pallets || 0), 0),
  };

  return (
    <div style={s.root}>
      {flash && <div style={s.flash}>{flash}</div>}

      <div style={s.pageHeader}>
        <div style={s.badge}>OPERADOR — REUBICACION</div>
        <h1 style={s.title}>Mis Tareas Asignadas</h1>
        <p style={s.sub}>Solo se muestran las líneas aprobadas por el supervisor · 2 pallets por viaje</p>
      </div>

      {/* Stats */}
      <div style={s.statsRow}>
        <div style={s.statCard}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#4ade80" }}>{stats.asignadas}</div>
          <div style={s.statLabel}>POR INICIAR</div>
        </div>
        <div style={s.statCard}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#60a5fa" }}>{stats.enProceso}</div>
          <div style={s.statLabel}>EN PROCESO</div>
        </div>
        <div style={s.statCard}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#a78bfa" }}>{stats.completadas}</div>
          <div style={s.statLabel}>COMPLETADAS</div>
        </div>
        <div style={s.statCard}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#fbbf24" }}>{stats.totalViajes}</div>
          <div style={s.statLabel}>VIAJES PENDIENTES</div>
        </div>
      </div>

      {/* Filtros */}
      <div style={s.filters}>
        {([
          { k: "aprobada",   label: "POR INICIAR",  color: "#4ade80" },
          { k: "en_proceso", label: "EN PROCESO",   color: "#60a5fa" },
          { k: "completada", label: "COMPLETADAS",  color: "#a78bfa" },
          { k: "todas",      label: "TODAS",        color: "#1e293b" },
        ] as const).map(f => (
          <button key={f.k} onClick={() => setFiltro(f.k)}
            style={{ ...s.filterBtn, borderColor: filtro === f.k ? f.color : "rgba(249,115,22,0.15)", color: filtro === f.k ? f.color : "#4a5568", background: filtro === f.k ? `${f.color}18` : "transparent" }}>
            {f.label}
          </button>
        ))}
        <button onClick={load} style={s.refreshBtn}>↻ Actualizar</button>
      </div>

      {loading ? (
        <div style={s.loading}>Cargando tareas…</div>
      ) : filtradas.length === 0 ? (
        <div style={s.empty}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>✓</div>
          <div>No hay tareas pendientes</div>
          {filtro === "aprobada" && <div style={{ fontSize: 11, marginTop: 8, color: "#374151" }}>Cuando el supervisor apruebe una línea, aparecerá aquí en tiempo real</div>}
        </div>
      ) : (
        <div style={s.cards}>
          {filtradas.map(l => {
            const viajes = viajesPorLinea(l.pallets || 0);
            const isExpanded = expanded === l.id;
            const isEnProceso = l.estado === "en_proceso";
            const isCompletada = l.estado === "completada";

            return (
              <div key={l.id} style={{ ...s.card, borderColor: isEnProceso ? "rgba(96,165,250,0.3)" : isCompletada ? "rgba(167,139,250,0.2)" : "rgba(249,115,22,0.12)" }}>

                {/* Header */}
                <div style={s.cardHeader} onClick={() => setExpanded(isExpanded ? null : l.id)}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 20 }}>{isCompletada ? "✓" : isEnProceso ? "⚙" : "📋"}</span>
                    <div style={{ minWidth: 0 }}>
                      {l.numero_orden && <div style={s.ordenNum}>{l.numero_orden}{l.es_fraccion && <span style={s.fracTag}> ⌥fracción</span>}</div>}
                      <div style={s.producto}>{l.descripcion}</div>
                      {l.codigo && <div style={{ fontSize: 10, color: "#f97316" }}>{l.codigo}</div>}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                    {isEnProceso && l.inicio_operador && <Timer startIso={l.inicio_operador} />}
                    {isCompletada && l.duracion_minutos != null && (
                      <span style={{ color: "#a78bfa", fontSize: 11, fontFamily: "monospace" }}>{l.duracion_minutos.toFixed(1)} min</span>
                    )}
                    <span style={{ color: "#94a3b8", fontSize: 11 }}>{isExpanded ? "▲" : "▼"}</span>
                  </div>
                </div>

                {/* Info rápida — siempre visible */}
                <div style={s.quickRow}>
                  <div style={s.chip}>
                    <span style={s.chipLabel}>PALLETS</span>
                    <span style={{ ...s.chipVal, color: "#fbbf24" }}>{l.pallets}</span>
                  </div>
                  <div style={s.chip}>
                    <span style={s.chipLabel}>CAJAS</span>
                    <span style={s.chipVal}>{l.cajas}</span>
                  </div>
                  <div style={s.chip}>
                    <span style={s.chipLabel}>VIAJES</span>
                    <span style={{ ...s.chipVal, color: "#4ade80", fontSize: 16 }}>{viajes}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 80 }}>
                    <div style={s.chipLabel}>DESTINO</div>
                    <div style={{ color: "#60a5fa", fontFamily: "monospace", fontSize: 13, fontWeight: 700 }}>{l.localizador_destino || "—"}</div>
                    <div style={{ color: "#94a3b8", fontSize: 10 }}>{l.subinventario_destino || ""}</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 80 }}>
                    <div style={s.chipLabel}>ORIGEN</div>
                    <div style={{ color: "#1e293b", fontFamily: "monospace", fontSize: 12 }}>{l.localizador_origen || "—"}</div>
                    <div style={{ color: "#94a3b8", fontSize: 10 }}>{l.subinventario_origen || ""}</div>
                  </div>
                </div>

                {/* Detalle expandible */}
                {isExpanded && (
                  <div style={s.detail}>
                    <div style={s.detailGrid}>
                      {[
                        ["LOTE", l.lote || "—"],
                        ["CANT. FÍSICA", l.cantidad_fisica?.toFixed(2) || "—"],
                        ["RESPONSABLE", l.responsable || "—"],
                        ["INV-PE", String(l.inv_pe ?? "—")],
                        ["CONTEO", String(l.conteo ?? "—")],
                        ["VIAJES NECESARIOS", `${viajes} (2 plt/viaje)`],
                        ...(l.inicio_operador ? [["INICIO", new Date(l.inicio_operador).toLocaleString("es-EC")]] : []),
                        ...(l.fin_operador    ? [["FIN",   new Date(l.fin_operador).toLocaleString("es-EC")]]   : []),
                      ].map(([k, v]) => (
                        <div key={k}>
                          <div style={s.detailKey}>{k}</div>
                          <div style={s.detailVal}>{v}</div>
                        </div>
                      ))}
                    </div>
                    {l.notas_supervisor && (
                      <div style={s.notaBox}>
                        <div style={s.notaLabel}>INSTRUCCIONES DEL SUPERVISOR</div>
                        <div style={s.notaText}>{l.notas_supervisor}</div>
                      </div>
                    )}
                  </div>
                )}

                {/* Acciones del operador */}
                {!isCompletada && (
                  <div style={s.actions}>
                    {l.estado === "aprobada" && (
                      <button
                        style={{ ...s.actionBtn, borderColor: "#60a5fa", color: "#60a5fa", opacity: saving === l.id ? 0.6 : 1 }}
                        onClick={() => handleIniciar(l.id)}
                        disabled={saving === l.id}
                      >
                        {saving === l.id ? "Iniciando…" : `⚙ INICIAR — ${viajes} viaje${viajes !== 1 ? "s" : ""} de 2 plt`}
                      </button>
                    )}
                    {isEnProceso && l.inicio_operador && (
                      <button
                        style={{ ...s.actionBtn, borderColor: "#a78bfa", color: "#a78bfa", opacity: saving === l.id ? 0.6 : 1 }}
                        onClick={() => handleFinalizar(l.id, l.inicio_operador!)}
                        disabled={saving === l.id}
                      >
                        {saving === l.id ? "Guardando…" : "✓ FINALIZAR LÍNEA"}
                      </button>
                    )}
                  </div>
                )}

                {isCompletada && (
                  <div style={s.completedBanner}>
                    ✓ COMPLETADA{l.duracion_minutos != null ? ` en ${l.duracion_minutos.toFixed(1)} min` : ""}
                    {l.fin_operador && <span style={{ color: "#64748b" }}> · {new Date(l.fin_operador).toLocaleTimeString("es-EC")}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const s: { [k: string]: React.CSSProperties } = {
  root: { padding: "28px 24px", fontFamily: "'Courier New', monospace", color: "#1e293b", minHeight: "100vh", background: "#f1f5f9", position: "relative" },
  flash: { position: "fixed", top: 20, right: 24, background: "#ffffff", border: "1px solid rgba(249,115,22,0.4)", color: "#f97316", padding: "10px 20px", borderRadius: 3, fontSize: 12, letterSpacing: 1, zIndex: 9999 },
  pageHeader: { marginBottom: 20 },
  badge: { display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", marginBottom: 10 },
  title: { margin: "0 0 4px", fontSize: 22, fontWeight: 700, color: "#0f172a", letterSpacing: 1 },
  sub: { margin: 0, fontSize: 11, color: "#64748b" },
  statsRow: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 18 },
  statCard: { background: "#ffffff", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 3, padding: "12px 16px" },
  statLabel: { fontSize: 9, letterSpacing: 2, color: "#94a3b8", marginTop: 3, fontWeight: 600 },
  filters: { display: "flex", gap: 7, marginBottom: 18, flexWrap: "wrap" as const, alignItems: "center" },
  filterBtn: { border: "1px solid", fontSize: 10, letterSpacing: 1.5, padding: "6px 13px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", fontWeight: 600 },
  refreshBtn: { background: "transparent", border: "1px solid rgba(249,115,22,0.3)", color: "#64748b", fontSize: 11, padding: "6px 12px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", marginLeft: "auto" },
  loading: { textAlign: "center" as const, color: "#64748b", padding: 50, fontSize: 12 },
  empty: { textAlign: "center" as const, color: "#94a3b8", padding: 50, fontSize: 13, border: "1px dashed rgba(249,115,22,0.1)", borderRadius: 4 },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(360px,1fr))", gap: 12 },
  card: { background: "#ffffff", border: "1px solid", borderRadius: 4, overflow: "hidden" },
  cardHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", cursor: "pointer", borderBottom: "1px solid rgba(249,115,22,0.06)" },
  ordenNum: { fontSize: 11, fontWeight: 700, color: "#f97316", letterSpacing: 1 },
  fracTag: { fontSize: 9, color: "#60a5fa", fontWeight: 400 },
  producto: { fontSize: 13, color: "#1e293b", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  quickRow: { display: "flex", gap: 14, padding: "12px 16px", borderBottom: "1px solid rgba(249,115,22,0.06)", flexWrap: "wrap" as const },
  chip: { display: "flex", flexDirection: "column" as const, gap: 2 },
  chipLabel: { fontSize: 8, letterSpacing: 2, color: "#94a3b8", fontWeight: 600 },
  chipVal: { fontSize: 18, fontWeight: 700, color: "#1e293b" },
  detail: { padding: "12px 16px", borderBottom: "1px solid rgba(249,115,22,0.06)" },
  detailGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", marginBottom: 10 },
  detailKey: { fontSize: 8, letterSpacing: 2, color: "#94a3b8", fontWeight: 600, marginBottom: 2 },
  detailVal: { fontSize: 11, color: "#1e293b" },
  notaBox: { background: "#f1f5f9", border: "1px solid rgba(96,165,250,0.15)", borderRadius: 3, padding: "8px 12px" },
  notaLabel: { fontSize: 8, letterSpacing: 2, color: "#60a5fa", marginBottom: 5, fontWeight: 600 },
  notaText: { fontSize: 11, color: "#64748b", lineHeight: 1.6 },
  actions: { padding: "12px 16px" },
  actionBtn: { width: "100%", background: "transparent", border: "1px solid", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, padding: "11px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  completedBanner: { padding: "10px 16px", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: "#a78bfa", background: "rgba(167,139,250,0.06)", textAlign: "center" as const },
};
