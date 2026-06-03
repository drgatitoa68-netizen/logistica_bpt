"use client";

import { useEffect, useState, useCallback } from "react";
import { getBrowserClient } from "@/lib/supabase/browser";
import { debounce } from "@/lib/utils/debounce";
import { Linea } from "@/lib/shared/ordenes";
import { aprobarLineaDirecta, rechazarLinea, fraccionarLinea } from "@/app/actions/ordenes";

const db = getBrowserClient();

type Filtro = "pendiente" | "aprobada" | "rechazada" | "todas";

interface FraccionForm {
  lineaId:    string;
  original:   Linea;
  p1:         number;    // pallets fracción 1
  dest1:      string;    // localizador destino f1
  dest2:      string;    // localizador destino f2
}

function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

// ── Componente ────────────────────────────────────────────────────────────────
export default function OrdenesProduccionPage() {
  const [lineas,  setLineas]  = useState<Linea[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtro,  setFiltro]  = useState<Filtro>("pendiente");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving,   setSaving]   = useState<string | null>(null);
  const [flash,    setFlash]    = useState<{ msg: string; ok: boolean } | null>(null);

  // Reject modal
  const [rejectTarget, setRejectTarget] = useState<string[] | null>(null);
  const [rejectNota,   setRejectNota]   = useState("");

  // Fracción modal
  const [fraccion, setFraccion] = useState<FraccionForm | null>(null);

  // ── Carga ─────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await db
      .from("lineas_reubicacion")
      .select("id,descripcion,subinventario_origen,localizador_origen,lote,pallets,cajas,cantidad_fisica,metraje,localizador_destino,subinventario_destino,estado,notas_supervisor,responsable,created_at,updated_at")
      .in("estado", ["pendiente", "aprobada", "rechazada"])
      .order("created_at", { ascending: false });
    if (data) setLineas(data as Linea[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const dl = debounce(load, 600);
    const ch = db.channel("ordenes_sv")
      .on("postgres_changes", { event: "*", schema: "public", table: "lineas_reubicacion" }, dl)
      .subscribe();
    return () => { db.removeChannel(ch); };
  }, [load]);

  const showFlash = (msg: string, ok = true) => {
    setFlash({ msg, ok });
    setTimeout(() => setFlash(null), 3500);
  };

  // ── Aprobar ───────────────────────────────────────────────────────────────
  async function aprobar(ids: string[]) {
    setSaving(ids.length === 1 ? ids[0] : "bulk");
    const res = await Promise.all(ids.map(id => aprobarLineaDirecta(id)));
    setSaving(null);
    const err = res.filter(r => r?.error).length;
    if (!err) {
      setLineas(prev => prev.map(l => ids.includes(l.id) ? { ...l, estado: "aprobada", updated_at: new Date().toISOString() } : l));
      showFlash(`✓ ${ids.length} línea${ids.length > 1 ? "s" : ""} aprobada${ids.length > 1 ? "s" : ""} → enviadas al operador`);
      setSelected(new Set());
    } else {
      showFlash(`⚠ ${err} errores al aprobar`, false);
    }
  }

  // ── Rechazar ──────────────────────────────────────────────────────────────
  async function confirmarRechazo() {
    if (!rejectTarget?.length || !rejectNota.trim()) return;
    setSaving("bulk");
    const res = await Promise.all(rejectTarget.map(id => rechazarLinea(id, rejectNota.trim())));
    setSaving(null);
    const err = res.filter(r => r?.error).length;
    if (!err) {
      const nota = rejectNota.trim();
      setLineas(prev => prev.map(l =>
        rejectTarget.includes(l.id) ? { ...l, estado: "rechazada", notas_supervisor: nota, updated_at: new Date().toISOString() } : l
      ));
      showFlash(`✓ ${rejectTarget.length} rechazada${rejectTarget.length > 1 ? "s" : ""}`);
      setSelected(new Set());
    } else showFlash(`⚠ ${err} errores`, false);
    setRejectTarget(null);
    setRejectNota("");
  }

  // ── Fraccionar ────────────────────────────────────────────────────────────
  function abrirFraccion(l: Linea) {
    setFraccion({
      lineaId:  l.id,
      original: l,
      p1:       Math.floor((l.pallets || 1) / 2),
      dest1:    l.localizador_destino || "",
      dest2:    "",
    });
  }

  async function confirmarFraccion() {
    if (!fraccion) return;
    const { original, p1, dest1, dest2 } = fraccion;
    const ptotal = original.pallets || 0;
    const p2     = ptotal - p1;
    if (p1 <= 0 || p2 <= 0) { showFlash("Cada fracción debe tener al menos 1 pallet", false); return; }
    if (!dest1.trim())       { showFlash("Ingresa el destino de la fracción 1", false); return; }
    if (!dest2.trim())       { showFlash("Ingresa el destino de la fracción 2", false); return; }

    const metTotal = original.metraje || Math.round(ptotal * 1.2 * 100) / 100;
    const met1 = Math.round((p1 / ptotal) * metTotal * 100) / 100;
    const met2 = Math.round((metTotal - met1) * 100) / 100;

    setSaving("bulk");
    const res = await fraccionarLinea(
      fraccion.lineaId,
      { pallets: p1, cajas: 0, cantidad_fisica: p1, metraje: met1, localizador_destino: dest1.trim().toUpperCase(), subinventario_destino: "ALMACEN" },
      { pallets: p2, cajas: 0, cantidad_fisica: p2, metraje: met2, localizador_destino: dest2.trim().toUpperCase(), subinventario_destino: "ALMACEN" }
    );
    setSaving(null);
    if (res?.error) { showFlash(`❌ ${res.error}`, false); return; }
    showFlash(`✓ Línea fraccionada: F1=${p1} plt (${met1} m²) · F2=${p2} plt (${met2} m²)`);
    setFraccion(null);
    load();
  }

  // ── Selección ─────────────────────────────────────────────────────────────
  function toggleSel(id: string) {
    setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  // ── Datos ─────────────────────────────────────────────────────────────────
  const counts = {
    pendiente: lineas.filter(l => l.estado === "pendiente").length,
    aprobada:  lineas.filter(l => l.estado === "aprobada").length,
    rechazada: lineas.filter(l => l.estado === "rechazada").length,
  };

  const filtradas   = filtro === "todas" ? lineas : lineas.filter(l => l.estado === filtro);
  const pendVista   = filtradas.filter(l => l.estado === "pendiente");
  const selPend     = [...selected].filter(id => pendVista.some(l => l.id === id));
  const allSelPend  = pendVista.length > 0 && pendVista.every(l => selected.has(l.id));

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={s.root} className="page-root">

      {flash && (
        <div style={{ ...s.flash, borderColor: flash.ok ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)", color: flash.ok ? "#4ade80" : "#f87171" }}>
          {flash.msg}
        </div>
      )}

      {/* Header */}
      <div style={s.header}>
        <div style={s.badge}>SUPERVISOR — CONTROL DE CALIDAD</div>
        <h1 style={s.title}>Órdenes de Producción</h1>
        <p style={s.sub}>Verifica físicamente cada línea. Aprueba, fracciona o rechaza antes de enviar al operador.</p>
      </div>

      {/* Stats */}
      <div style={s.statsRow} className="stats-4col">
        {[
          { v: counts.pendiente, l: "POR REVISAR",  c: "#fbbf24" },
          { v: counts.aprobada,  l: "APROBADAS",    c: "#4ade80" },
          { v: counts.rechazada, l: "RECHAZADAS",   c: "#f87171" },
          { v: lineas.length,    l: "TOTAL",         c: "#94a3b8" },
        ].map(st => (
          <div key={st.l} style={s.statCard}>
            <div style={{ fontSize: 26, fontWeight: 700, color: st.c }}>{st.v}</div>
            <div style={s.statLabel}>{st.l}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={s.tabRow}>
        {([
          { k: "pendiente", l: "POR REVISAR",  c: "#fbbf24" },
          { k: "aprobada",  l: "APROBADAS",    c: "#4ade80" },
          { k: "rechazada", l: "RECHAZADAS",   c: "#f87171" },
          { k: "todas",     l: "TODAS",         c: "#94a3b8" },
        ] as { k: Filtro; l: string; c: string }[]).map(f => (
          <button key={f.k} style={{ ...s.tab, color: filtro === f.k ? f.c : "#4a5568", borderColor: filtro === f.k ? f.c : "rgba(249,115,22,0.15)", background: filtro === f.k ? `${f.c}14` : "transparent" }}
            onClick={() => { setFiltro(f.k); setSelected(new Set()); }}>
            {f.l}
            <span style={{ ...s.tabCount, background: filtro === f.k ? `${f.c}22` : "#e2e8f0", color: filtro === f.k ? f.c : "#94a3b8" }}>
              {f.k === "todas" ? lineas.length : counts[f.k as keyof typeof counts]}
            </span>
          </button>
        ))}
        <button style={s.refreshBtn} onClick={load}>↻</button>
      </div>

      {/* Bulk bar */}
      {selPend.length > 0 && (
        <div style={s.bulkBar}>
          <span style={{ fontSize: 12, color: "#e2e8f0" }}>
            <strong style={{ color: "#fbbf24" }}>{selPend.length}</strong> seleccionadas
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ ...s.bulkBtn, background: "#166534", borderColor: "#22c55e", color: "#4ade80" }}
              onClick={() => aprobar(selPend)} disabled={saving === "bulk"}>
              {saving === "bulk" ? "⟳" : `✓ APROBAR ${selPend.length}`}
            </button>
            <button style={{ ...s.bulkBtn, background: "#7f1d1d", borderColor: "#f87171", color: "#fca5a5" }}
              onClick={() => { setRejectTarget(selPend); setRejectNota(""); }} disabled={saving === "bulk"}>
              ✗ RECHAZAR {selPend.length}
            </button>
            <button style={{ ...s.bulkBtn, background: "transparent", borderColor: "#374151", color: "#6b7280" }}
              onClick={() => setSelected(new Set())}>×</button>
          </div>
        </div>
      )}

      {/* Sel-all for pending */}
      {filtro === "pendiente" && pendVista.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <button style={s.selAllBtn} onClick={() => setSelected(allSelPend ? new Set() : new Set(pendVista.map(l => l.id)))}>
            {allSelPend ? "☑" : "☐"} {allSelPend ? "Desmarcar todas" : `Seleccionar todas (${pendVista.length})`}
          </button>
        </div>
      )}

      {/* Lista */}
      {loading ? (
        <div style={s.empty}>Cargando órdenes…</div>
      ) : filtradas.length === 0 ? (
        <div style={s.empty}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>{filtro === "pendiente" ? "✓" : "—"}</div>
          {filtro === "pendiente" ? "No hay líneas pendientes de revisión" : "Sin resultados"}
          {filtro === "pendiente" && (
            <div style={{ fontSize: 11, marginTop: 8, color: "#64748b" }}>
              Procesa un Excel en Análisis BPT para generar líneas
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {filtradas.map(l => <LineaCard key={l.id} l={l} selected={selected.has(l.id)} saving={saving} onToggle={toggleSel} onAprobar={aprobar} onRechazar={ids => { setRejectTarget(ids); setRejectNota(""); }} onFraccionar={abrirFraccion} />)}
        </div>
      )}

      {/* ── MODAL RECHAZAR ────────────────────────────────────────────────── */}
      {rejectTarget && (
        <div style={s.overlay} onClick={() => { setRejectTarget(null); setRejectNota(""); }}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={{ ...s.modalTitle, color: "#f87171" }}>✗ RECHAZAR {rejectTarget.length > 1 ? `${rejectTarget.length} LÍNEAS` : "LÍNEA"}</div>
            <p style={{ fontSize: 11, color: "#64748b", margin: "0 0 14px" }}>El motivo queda registrado. El operador no verá esta línea.</p>
            <label style={s.fieldLabel}>MOTIVO *</label>
            <textarea autoFocus value={rejectNota} onChange={e => setRejectNota(e.target.value)}
              placeholder="Ej: Lote ya reubicado, error en localizador…"
              style={s.textarea} rows={3} />
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button style={{ ...s.modalBtn, background: "#7f1d1d", color: "#fca5a5", opacity: (!rejectNota.trim() || saving === "bulk") ? 0.5 : 1 }}
                onClick={confirmarRechazo} disabled={!rejectNota.trim() || saving === "bulk"}>
                {saving === "bulk" ? "⟳ Rechazando…" : "CONFIRMAR RECHAZO →"}
              </button>
              <button style={s.modalBtnCancel} onClick={() => { setRejectTarget(null); setRejectNota(""); }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL FRACCIONAR ──────────────────────────────────────────────── */}
      {fraccion && (() => {
        const { original, p1, dest1, dest2 } = fraccion;
        const ptotal   = original.pallets || 0;
        const p2       = ptotal - p1;
        const metTotal = original.metraje ?? Math.round(ptotal * 1.2 * 100) / 100;
        const met1     = p1 > 0 ? Math.round((p1 / ptotal) * metTotal * 100) / 100 : 0;
        const met2     = Math.round((metTotal - met1) * 100) / 100;
        const valid    = p1 > 0 && p2 > 0 && dest1.trim() && dest2.trim();

        return (
          <div style={s.overlay} onClick={() => setFraccion(null)}>
            <div style={{ ...s.modal, maxWidth: 520 }} onClick={e => e.stopPropagation()}>
              <div style={{ ...s.modalTitle, color: "#f97316" }}>✂ FRACCIONAR LÍNEA</div>

              {/* Info original */}
              <div style={s.fracOrigBox}>
                <div style={{ fontSize: 10, letterSpacing: 2, color: "#94a3b8", marginBottom: 8 }}>LÍNEA ORIGINAL</div>
                <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                  <div>
                    <div style={s.fracLabel}>ORIGEN</div>
                    <div style={{ fontFamily: "monospace", fontWeight: 700, color: "#f97316", fontSize: 14 }}>{original.localizador_origen || "—"}</div>
                  </div>
                  {original.lote && (
                    <div>
                      <div style={s.fracLabel}>LOTE</div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{original.lote}</div>
                    </div>
                  )}
                  <div>
                    <div style={s.fracLabel}>TOTAL PALLETS</div>
                    <div style={{ fontWeight: 700, fontSize: 22, color: "#fbbf24" }}>{ptotal}</div>
                  </div>
                  <div>
                    <div style={s.fracLabel}>TOTAL METRAJE</div>
                    <div style={{ fontWeight: 700, fontSize: 22, color: "#60a5fa" }}>{metTotal} m²</div>
                  </div>
                </div>
              </div>

              {/* Slider distribución */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, letterSpacing: 1.5, color: "#94a3b8", marginBottom: 6 }}>
                  <span>FRACCIÓN 1</span>
                  <span>FRACCIÓN 2</span>
                </div>
                <input type="range" min={1} max={ptotal - 1} value={p1}
                  onChange={e => setFraccion(f => f ? { ...f, p1: Number(e.target.value) } : f)}
                  style={{ width: "100%", accentColor: "#f97316", cursor: "pointer" }} />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <span style={{ fontSize: 11, color: "#fbbf24" }}>{p1} plt</span>
                  <span style={{ fontSize: 11, color: "#fbbf24" }}>{p2} plt</span>
                </div>
              </div>

              {/* Dos fracciones */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {/* Fracción 1 */}
                <div style={s.fracBox}>
                  <div style={s.fracBoxTitle}>FRACCIÓN 1</div>
                  <div style={s.fracStat}><span style={s.fracStatLbl}>Pallets</span><strong style={{ color: "#fbbf24" }}>{p1}</strong></div>
                  <div style={s.fracStat}><span style={s.fracStatLbl}>Metraje</span><strong style={{ color: "#60a5fa" }}>{met1} m²</strong></div>
                  <label style={{ ...s.fracLabel, display: "block", marginTop: 10 }}>DESTINO *</label>
                  <input
                    value={dest1}
                    onChange={e => setFraccion(f => f ? { ...f, dest1: e.target.value.toUpperCase() } : f)}
                    placeholder="ZONA7.12.01.02"
                    style={s.fracInput}
                  />
                </div>
                {/* Fracción 2 */}
                <div style={s.fracBox}>
                  <div style={s.fracBoxTitle}>FRACCIÓN 2</div>
                  <div style={s.fracStat}><span style={s.fracStatLbl}>Pallets</span><strong style={{ color: "#fbbf24" }}>{p2}</strong></div>
                  <div style={s.fracStat}><span style={s.fracStatLbl}>Metraje</span><strong style={{ color: "#60a5fa" }}>{met2} m²</strong></div>
                  <label style={{ ...s.fracLabel, display: "block", marginTop: 10 }}>DESTINO *</label>
                  <input
                    value={dest2}
                    onChange={e => setFraccion(f => f ? { ...f, dest2: e.target.value.toUpperCase() } : f)}
                    placeholder="ZONA8.03.01.01"
                    style={s.fracInput}
                  />
                </div>
              </div>

              {/* Validación visual */}
              <div style={{ ...s.fracSumBox, borderColor: p1 + p2 === ptotal ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)", background: p1 + p2 === ptotal ? "rgba(74,222,128,0.06)" : "rgba(248,113,113,0.06)" }}>
                <span style={{ color: p1 + p2 === ptotal ? "#4ade80" : "#f87171", fontWeight: 700 }}>
                  {p1 + p2 === ptotal ? `✓ ${p1} + ${p2} = ${ptotal} pallets · ${met1} + ${met2} = ${metTotal} m²` : `⚠ ${p1} + ${p2} ≠ ${ptotal}`}
                </span>
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button
                  style={{ ...s.modalBtn, background: valid ? "#c2410c" : "#374151", color: "#fff", opacity: (!valid || saving === "bulk") ? 0.6 : 1, flex: 1 }}
                  onClick={confirmarFraccion}
                  disabled={!valid || saving === "bulk"}
                >
                  {saving === "bulk" ? "⟳ Fraccionando…" : "CONFIRMAR FRACCIÓN →"}
                </button>
                <button style={s.modalBtnCancel} onClick={() => setFraccion(null)}>Cancelar</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Card de línea ─────────────────────────────────────────────────────────────
function LineaCard({
  l, selected, saving, onToggle, onAprobar, onRechazar, onFraccionar,
}: {
  l:           Linea;
  selected:    boolean;
  saving:      string | null;
  onToggle:    (id: string) => void;
  onAprobar:   (ids: string[]) => void;
  onRechazar:  (ids: string[]) => void;
  onFraccionar:(l: Linea) => void;
}) {
  const isPend   = l.estado === "pendiente";
  const isAprov  = l.estado === "aprobada";
  const isSaving = saving === l.id;

  const [subinv = "", formato = ""] = (l.descripcion || "").split(" · ");

  const metraje  = l.metraje ?? Math.round((l.pallets || 0) * 1.2 * 100) / 100;
  const hasDest  = !!l.localizador_destino;

  const borderColor = isAprov ? "rgba(74,222,128,0.3)"
    : l.estado === "rechazada" ? "rgba(248,113,113,0.2)"
    : selected ? "rgba(249,115,22,0.5)"
    : "rgba(0,0,0,0.08)";

  return (
    <div style={{ ...s.card, borderColor, background: selected ? "#fffbf5" : "#ffffff" }}>

      {/* ── TOP BAR ──────────────────────────────────────────────────────── */}
      <div style={s.cardTop}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {isPend && (
            <input type="checkbox" checked={selected} onChange={() => onToggle(l.id)}
              style={{ width: 15, height: 15, cursor: "pointer", accentColor: "#f97316", flexShrink: 0 }} />
          )}
          <span style={{
            ...s.estadoBadge,
            background: isPend ? "#292010" : isAprov ? "#0f2a0f" : "#2a0f0f",
            color:      isPend ? "#fbbf24" : isAprov ? "#4ade80" : "#f87171",
          }}>
            {isPend ? "● PENDIENTE" : isAprov ? "✓ APROBADA" : "✗ RECHAZADA"}
          </span>
          {l.lote && <span style={s.loteBadge}>LOTE {l.lote}</span>}
          {l.es_fraccion && <span style={{ ...s.loteBadge, background: "rgba(139,92,246,0.1)", color: "#a78bfa", borderColor: "rgba(139,92,246,0.3)" }}>FRACCIÓN</span>}
        </div>
        <span style={{ fontSize: 10, color: "#94a3b8", flexShrink: 0 }}>{timeAgo(l.created_at)}</span>
      </div>

      {/* ── CUERPO PRINCIPAL ─────────────────────────────────────────────── */}
      <div style={s.cardBody}>

        {/* Origen → Destino */}
        <div style={s.routeRow}>
          <div style={s.routeBox}>
            <div style={s.routeLabel}>ORIGEN</div>
            <div style={s.routeLoc}>{l.localizador_origen || "—"}</div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 5 }}>
              {subinv.trim() && <span style={s.subinvChip}>{subinv.trim()}</span>}
              {formato.trim() && <span style={s.formatoChip}>{formato.trim()}</span>}
            </div>
          </div>

          <div style={s.routeArrow}>→</div>

          <div style={{ ...s.routeBox, flex: 1 }}>
            <div style={s.routeLabel}>DESTINO ASIGNADO</div>
            {hasDest ? (
              <>
                <div style={{ ...s.routeLoc, color: "#4ade80" }}>{l.localizador_destino}</div>
                {l.subinventario_destino && (
                  <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>→ {l.subinventario_destino}</div>
                )}
              </>
            ) : (
              <div style={{ ...s.routeLoc, color: "#f87171", fontSize: 13 }}>SIN DESTINO</div>
            )}
          </div>
        </div>

        {/* Métricas */}
        <div style={s.metricsRow}>
          <div style={s.metric}>
            <div style={s.metricLabel}>PALLETS</div>
            <div style={{ ...s.metricVal, color: "#fbbf24" }}>{l.pallets ?? 0}</div>
          </div>
          <div style={s.metric}>
            <div style={s.metricLabel}>METRAJE</div>
            <div style={{ ...s.metricVal, color: "#60a5fa", fontSize: 16 }}>{metraje} m²</div>
          </div>
          {(l.cajas ?? 0) > 0 && (
            <div style={s.metric}>
              <div style={s.metricLabel}>CAJAS</div>
              <div style={s.metricVal}>{l.cajas}</div>
            </div>
          )}
          {l.cantidad_fisica != null && (
            <div style={s.metric}>
              <div style={s.metricLabel}>CANT. FÍSICA</div>
              <div style={{ ...s.metricVal, fontSize: 14 }}>{Number(l.cantidad_fisica).toFixed(0)}</div>
            </div>
          )}
        </div>

      </div>

      {/* Nota de rechazo */}
      {l.notas_supervisor && l.estado === "rechazada" && (
        <div style={s.notaBox}>
          <span style={{ fontSize: 9, letterSpacing: 1.5, color: "#f87171", marginRight: 6 }}>MOTIVO:</span>
          <span style={{ fontSize: 11, color: "#94a3b8" }}>{l.notas_supervisor}</span>
        </div>
      )}

      {/* Acciones */}
      {isPend && (
        <div style={s.actionsRow}>
          <button
            style={{ ...s.btn, ...s.btnAprobar, opacity: isSaving ? 0.6 : 1 }}
            onClick={() => onAprobar([l.id])} disabled={isSaving}>
            {isSaving ? "⟳" : "✓ APROBAR"}
          </button>
          <button
            style={{ ...s.btn, ...s.btnFracc, opacity: isSaving ? 0.6 : 1 }}
            onClick={() => onFraccionar(l)} disabled={isSaving || (l.pallets ?? 0) < 2}>
            ✂ FRACCIONAR
          </button>
          <button
            style={{ ...s.btn, ...s.btnRechazar, opacity: isSaving ? 0.6 : 1 }}
            onClick={() => onRechazar([l.id])} disabled={isSaving}>
            ✗ RECHAZAR
          </button>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s: { [k: string]: React.CSSProperties } = {
  root:       { padding: "28px 24px", fontFamily: "'Courier New', monospace", color: "#1e293b", minHeight: "100vh", background: "#f1f5f9", position: "relative" },
  flash:      { position: "fixed", top: 20, right: 24, background: "#fff", border: "1px solid", padding: "10px 20px", borderRadius: 3, fontSize: 12, letterSpacing: 1, zIndex: 9999 },

  header:     { marginBottom: 20 },
  badge:      { display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", marginBottom: 10 },
  title:      { margin: "0 0 4px", fontSize: 22, fontWeight: 700, color: "#0f172a", letterSpacing: 1 },
  sub:        { margin: 0, fontSize: 11, color: "#64748b" },

  statsRow:   { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 18 },
  statCard:   { background: "#fff", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 4, padding: "12px 16px" },
  statLabel:  { fontSize: 9, letterSpacing: 2, color: "#94a3b8", marginTop: 3, fontWeight: 600 },

  tabRow:     { display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" as const, alignItems: "center" },
  tab:        { border: "1px solid", fontSize: 10, letterSpacing: 1.5, padding: "6px 12px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 },
  tabCount:   { fontSize: 10, padding: "1px 6px", borderRadius: 10, fontWeight: 700, minWidth: 18, textAlign: "center" as const },
  refreshBtn: { marginLeft: "auto", background: "transparent", border: "1px solid rgba(249,115,22,0.2)", color: "#64748b", fontSize: 14, padding: "5px 12px", cursor: "pointer", borderRadius: 2 },

  bulkBar:    { background: "#1e293b", border: "1px solid rgba(249,115,22,0.3)", borderRadius: 4, padding: "10px 16px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 10 },
  bulkBtn:    { border: "1px solid", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "7px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },

  selAllBtn:  { background: "transparent", border: "none", color: "#64748b", fontSize: 11, cursor: "pointer", fontFamily: "'Courier New', monospace", padding: 0 },
  empty:      { textAlign: "center" as const, color: "#94a3b8", padding: 50, fontSize: 13, border: "1px dashed rgba(249,115,22,0.1)", borderRadius: 4 },

  /* Card */
  card:       { border: "1px solid", borderRadius: 6, overflow: "hidden", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" },
  cardTop:    { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px", background: "#f8fafc", borderBottom: "1px solid rgba(0,0,0,0.06)", flexWrap: "wrap" as const, gap: 6 },
  estadoBadge:{ fontSize: 9, letterSpacing: 2, fontWeight: 700, padding: "3px 8px", borderRadius: 2 },
  loteBadge:  { fontSize: 9, letterSpacing: 1, color: "#6366f1", background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.2)", padding: "2px 7px", borderRadius: 2 },

  cardBody:   { padding: "14px 16px", display: "flex", flexDirection: "column" as const, gap: 14 },

  routeRow:   { display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" as const },
  routeBox:   { display: "flex", flexDirection: "column" as const, gap: 2, minWidth: 130 },
  routeLabel: { fontSize: 8, letterSpacing: 2, color: "#94a3b8", fontWeight: 600 },
  routeLoc:   { fontFamily: "monospace", fontSize: 16, fontWeight: 700, color: "#f97316", letterSpacing: 0.5 },
  routeArrow: { fontSize: 20, color: "#cbd5e1", alignSelf: "center", flexShrink: 0, paddingTop: 14 },
  subinvChip: { fontSize: 9, letterSpacing: 1, background: "#dbeafe", color: "#1d4ed8", padding: "2px 7px", borderRadius: 3, fontWeight: 600 },
  formatoChip:{ fontSize: 9, letterSpacing: 1, background: "#dcfce7", color: "#15803d", padding: "2px 7px", borderRadius: 3, fontWeight: 600 },

  metricsRow: { display: "flex", gap: 20, flexWrap: "wrap" as const, paddingTop: 4, borderTop: "1px solid rgba(0,0,0,0.05)" },
  metric:     { display: "flex", flexDirection: "column" as const, gap: 2 },
  metricLabel:{ fontSize: 8, letterSpacing: 2, color: "#94a3b8", fontWeight: 600 },
  metricVal:  { fontSize: 22, fontWeight: 700, color: "#1e293b", lineHeight: 1 },

  notaBox:    { padding: "8px 16px", background: "rgba(248,113,113,0.04)", borderTop: "1px solid rgba(248,113,113,0.08)" },

  actionsRow: { display: "flex", gap: 0, borderTop: "1px solid rgba(0,0,0,0.06)" },
  btn:        { flex: 1, border: "none", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "11px 0", cursor: "pointer", fontFamily: "'Courier New', monospace", textAlign: "center" as const, borderRight: "1px solid rgba(0,0,0,0.06)", transition: "opacity 0.15s" },
  btnAprobar: { background: "#f0fdf4", color: "#166534" },
  btnFracc:   { background: "#fff7ed", color: "#c2410c" },
  btnRechazar:{ background: "#fef2f2", color: "#991b1b", borderRight: "none" },

  /* Modales */
  overlay:        { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
  modal:          { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 6, padding: "24px 28px", width: "100%", maxWidth: 480 },
  modalTitle:     { fontSize: 13, fontWeight: 700, letterSpacing: 2, marginBottom: 14 },
  fieldLabel:     { fontSize: 9, letterSpacing: 2, color: "#f97316", display: "block" as const, marginBottom: 6, fontWeight: 600 },
  textarea:       { width: "100%", background: "#f1f5f9", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 2, color: "#1e293b", fontSize: 12, padding: "10px", fontFamily: "'Courier New', monospace", outline: "none", resize: "vertical" as const, boxSizing: "border-box" as const },
  modalBtn:       { border: "none", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "10px 16px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  modalBtnCancel: { background: "transparent", border: "1px solid rgba(249,115,22,0.2)", color: "#6b7280", fontSize: 10, letterSpacing: 1, padding: "10px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },

  /* Fracción */
  fracOrigBox:  { background: "#f1f5f9", border: "1px solid rgba(249,115,22,0.15)", borderRadius: 4, padding: "12px 16px", marginBottom: 16 },
  fracBox:      { background: "#f1f5f9", border: "1px solid rgba(249,115,22,0.15)", borderRadius: 4, padding: "12px 14px" },
  fracBoxTitle: { fontSize: 9, letterSpacing: 2, fontWeight: 700, color: "#f97316", marginBottom: 10 },
  fracLabel:    { fontSize: 9, letterSpacing: 1.5, color: "#94a3b8", fontWeight: 600 },
  fracStat:     { display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 12, marginBottom: 4 },
  fracStatLbl:  { color: "#64748b", fontSize: 10, letterSpacing: 1 },
  fracInput:    { width: "100%", background: "#fff", border: "1px solid rgba(249,115,22,0.3)", borderRadius: 2, color: "#1e293b", fontSize: 12, padding: "7px 9px", fontFamily: "monospace", outline: "none", boxSizing: "border-box" as const, marginTop: 4 },
  fracSumBox:   { border: "1px solid", borderRadius: 4, padding: "10px 14px", textAlign: "center" as const, marginTop: 14, fontSize: 11, fontFamily: "monospace", letterSpacing: 0.5 },
};
