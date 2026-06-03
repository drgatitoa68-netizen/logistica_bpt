"use client";

import { useEffect, useState, useCallback } from "react";
import { getBrowserClient } from "@/lib/supabase/browser";
import { debounce } from "@/lib/utils/debounce";
import { Linea } from "@/lib/shared/ordenes";
import { aprobarLineaDirecta, rechazarLinea } from "@/app/actions/ordenes";

const db = getBrowserClient();

type Filtro = "pendiente" | "aprobada" | "rechazada" | "todas";

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function parseLoc(desc: string): { subinv: string; formato: string } {
  const [subinv = "", formato = ""] = desc.split(" · ");
  return { subinv: subinv.trim(), formato: formato.trim() };
}

// ── Componente ────────────────────────────────────────────────────────────────
export default function OrdenesProduccionPage() {
  const [lineas, setLineas]   = useState<Linea[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro]   = useState<Filtro>("pendiente");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving]   = useState<string | null>(null);
  const [flash, setFlash]     = useState<{ msg: string; ok: boolean } | null>(null);

  // Reject modal
  const [rejectTarget, setRejectTarget] = useState<string[] | null>(null);
  const [rejectNota, setRejectNota]     = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await db
      .from("lineas_reubicacion")
      .select("id,descripcion,subinventario_origen,localizador_origen,lote,pallets,cajas,cantidad_fisica,estado,notas_supervisor,responsable,created_at,updated_at")
      .in("estado", ["pendiente", "aprobada", "rechazada"])
      .order("created_at", { ascending: false });
    if (!error && data) setLineas(data as Linea[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const dl = debounce(load, 600);
    const ch = db.channel("ordenes_supervisor")
      .on("postgres_changes", { event: "*", schema: "public", table: "lineas_reubicacion" }, dl)
      .subscribe();
    return () => { db.removeChannel(ch); };
  }, [load]);

  const showFlash = (msg: string, ok = true) => {
    setFlash({ msg, ok });
    setTimeout(() => setFlash(null), 3500);
  };

  // ── Approve ───────────────────────────────────────────────────────────────
  async function aprobar(ids: string[]) {
    setSaving(ids.length === 1 ? ids[0] : "bulk");
    const results = await Promise.all(ids.map(id => aprobarLineaDirecta(id)));
    setSaving(null);
    const errors = results.filter(r => r?.error).length;
    if (errors === 0) {
      setLineas(prev => prev.map(l => ids.includes(l.id) ? { ...l, estado: "aprobada", updated_at: new Date().toISOString() } : l));
      showFlash(`✓ ${ids.length} línea${ids.length > 1 ? "s" : ""} aprobada${ids.length > 1 ? "s" : ""}`);
      setSelected(new Set());
    } else {
      showFlash(`⚠ ${errors} errores al aprobar`, false);
    }
  }

  // ── Reject ────────────────────────────────────────────────────────────────
  async function confirmarRechazo() {
    if (!rejectTarget || !rejectNota.trim()) return;
    setSaving("bulk");
    const results = await Promise.all(rejectTarget.map(id => rechazarLinea(id, rejectNota.trim())));
    setSaving(null);
    const errors = results.filter(r => r?.error).length;
    if (errors === 0) {
      const nota = rejectNota.trim();
      setLineas(prev => prev.map(l =>
        rejectTarget.includes(l.id)
          ? { ...l, estado: "rechazada", notas_supervisor: nota, updated_at: new Date().toISOString() }
          : l
      ));
      showFlash(`✓ ${rejectTarget.length} línea${rejectTarget.length > 1 ? "s" : ""} rechazada${rejectTarget.length > 1 ? "s" : ""}`);
      setSelected(new Set());
    } else {
      showFlash(`⚠ ${errors} errores al rechazar`, false);
    }
    setRejectTarget(null);
    setRejectNota("");
  }

  // ── Selection ─────────────────────────────────────────────────────────────
  function toggleSelect(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function toggleAll() {
    const pendientes = filtradas.filter(l => l.estado === "pendiente").map(l => l.id);
    const allSelected = pendientes.every(id => selected.has(id));
    setSelected(allSelected ? new Set() : new Set(pendientes));
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  const counts = {
    pendiente: lineas.filter(l => l.estado === "pendiente").length,
    aprobada:  lineas.filter(l => l.estado === "aprobada").length,
    rechazada: lineas.filter(l => l.estado === "rechazada").length,
  };

  const filtradas = filtro === "todas" ? lineas : lineas.filter(l => l.estado === filtro);
  const pendientesEnVista = filtradas.filter(l => l.estado === "pendiente");
  const selectedPendientes = [...selected].filter(id => pendientesEnVista.some(l => l.id === id));

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={s.root} className="page-root">

      {/* Flash */}
      {flash && (
        <div style={{ ...s.flash, borderColor: flash.ok ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)", color: flash.ok ? "#4ade80" : "#f87171" }}>
          {flash.msg}
        </div>
      )}

      {/* Header */}
      <div style={s.pageHeader}>
        <div style={s.badge}>SUPERVISOR — REVISIÓN DE LÍNEAS</div>
        <h1 style={s.title}>Órdenes de Producción</h1>
        <p style={s.sub}>Revisa cada línea antes de enviarla al operador · Los datos se copiaron del Excel de stock</p>
      </div>

      {/* Stats */}
      <div style={s.statsRow} className="stats-4col">
        <div style={s.statCard}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#fbbf24" }}>{counts.pendiente}</div>
          <div style={s.statLabel}>POR REVISAR</div>
        </div>
        <div style={s.statCard}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#4ade80" }}>{counts.aprobada}</div>
          <div style={s.statLabel}>APROBADAS</div>
        </div>
        <div style={s.statCard}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#f87171" }}>{counts.rechazada}</div>
          <div style={s.statLabel}>RECHAZADAS</div>
        </div>
        <div style={s.statCard}>
          <div style={{ fontSize: 26, fontWeight: 700, color: "#e2e8f0" }}>{lineas.length}</div>
          <div style={s.statLabel}>TOTAL</div>
        </div>
      </div>

      {/* Filter tabs */}
      <div style={s.tabRow}>
        {([
          { k: "pendiente", label: "POR REVISAR", color: "#fbbf24", count: counts.pendiente },
          { k: "aprobada",  label: "APROBADAS",   color: "#4ade80", count: counts.aprobada  },
          { k: "rechazada", label: "RECHAZADAS",  color: "#f87171", count: counts.rechazada },
          { k: "todas",     label: "TODAS",        color: "#e2e8f0", count: lineas.length   },
        ] as { k: Filtro; label: string; color: string; count: number }[]).map(f => (
          <button key={f.k} onClick={() => { setFiltro(f.k); setSelected(new Set()); }}
            style={{ ...s.tab, color: filtro === f.k ? f.color : "#4a5568", borderColor: filtro === f.k ? f.color : "rgba(249,115,22,0.15)", background: filtro === f.k ? `${f.color}14` : "transparent" }}>
            {f.label}
            <span style={{ ...s.tabCount, background: filtro === f.k ? `${f.color}22` : "#1e293b", color: filtro === f.k ? f.color : "#4a5568" }}>{f.count}</span>
          </button>
        ))}
        <button onClick={load} style={s.refreshBtn}>↻</button>
      </div>

      {/* Bulk action bar */}
      {selectedPendientes.length > 0 && (
        <div style={s.bulkBar}>
          <span style={{ fontSize: 12, color: "#e2e8f0" }}>
            <strong style={{ color: "#fbbf24" }}>{selectedPendientes.length}</strong> líneas seleccionadas
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{ ...s.bulkBtn, background: "#166534", borderColor: "#22c55e", color: "#4ade80" }}
              onClick={() => aprobar(selectedPendientes)}
              disabled={saving === "bulk"}
            >
              {saving === "bulk" ? "⟳ Aprobando…" : `✓ APROBAR ${selectedPendientes.length}`}
            </button>
            <button
              style={{ ...s.bulkBtn, background: "#7f1d1d", borderColor: "#f87171", color: "#fca5a5" }}
              onClick={() => { setRejectTarget(selectedPendientes); setRejectNota(""); }}
              disabled={saving === "bulk"}
            >
              ✗ RECHAZAR {selectedPendientes.length}
            </button>
            <button style={{ ...s.bulkBtn, background: "transparent", borderColor: "#374151", color: "#6b7280" }}
              onClick={() => setSelected(new Set())}>
              Limpiar
            </button>
          </div>
        </div>
      )}

      {/* Select-all bar for pending tab */}
      {filtro === "pendiente" && pendientesEnVista.length > 0 && selectedPendientes.length === 0 && (
        <div style={s.selectAllBar}>
          <button style={s.selectAllBtn} onClick={toggleAll}>
            ☐ Seleccionar todas ({pendientesEnVista.length})
          </button>
        </div>
      )}

      {/* Lines */}
      {loading ? (
        <div style={s.loading}>Cargando órdenes…</div>
      ) : filtradas.length === 0 ? (
        <div style={s.empty}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>
            {filtro === "pendiente" ? "✓" : "—"}
          </div>
          <div>{filtro === "pendiente" ? "No hay líneas pendientes" : "Sin resultados"}</div>
          {filtro === "pendiente" && (
            <div style={{ fontSize: 11, marginTop: 8, color: "#374151" }}>
              Cuando se procese un Excel en Análisis BPT, aparecerán aquí para revisión
            </div>
          )}
        </div>
      ) : (
        <div style={s.list}>
          {filtradas.map(l => {
            const isPendiente = l.estado === "pendiente";
            const isAprobada  = l.estado === "aprobada";
            const isSelected  = selected.has(l.id);
            const isSaving    = saving === l.id;
            const { subinv, formato } = parseLoc(l.descripcion || "");

            const borderColor = isAprobada  ? "rgba(74,222,128,0.25)"
                              : l.estado === "rechazada" ? "rgba(248,113,113,0.2)"
                              : isSelected  ? "rgba(251,191,36,0.5)"
                              : "rgba(249,115,22,0.1)";

            return (
              <div key={l.id}
                style={{ ...s.card, borderColor, background: isSelected ? "rgba(251,191,36,0.04)" : "#ffffff" }}
              >
                {/* Card top: status + select */}
                <div style={s.cardTop}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {isPendiente && (
                      <input type="checkbox" checked={isSelected}
                        onChange={() => toggleSelect(l.id)}
                        style={{ width: 15, height: 15, cursor: "pointer", accentColor: "#f97316" }} />
                    )}
                    <span style={{
                      ...s.estadoBadge,
                      background: isPendiente ? "#292010" : isAprobada ? "#0f2a0f" : "#2a0f0f",
                      color:      isPendiente ? "#fbbf24" : isAprobada ? "#4ade80" : "#f87171",
                    }}>
                      {isPendiente ? "● PENDIENTE" : isAprobada ? "✓ APROBADA" : "✗ RECHAZADA"}
                    </span>
                    {l.lote && (
                      <span style={s.loteBadge}>LOTE: {l.lote}</span>
                    )}
                  </div>
                  <span style={s.timeAgo}>{timeAgo(l.created_at)}</span>
                </div>

                {/* Card body: product data */}
                <div style={s.cardBody}>
                  <div style={s.mainInfo}>
                    <div style={s.localizador}>{l.localizador_origen || "—"}</div>
                    <div style={s.subinvRow}>
                      <span style={s.subinvChip}>{subinv || l.subinventario_origen || "—"}</span>
                      {formato && <span style={s.formatoChip}>{formato}</span>}
                    </div>
                  </div>

                  <div style={s.numChips}>
                    <div style={s.numChip}>
                      <div style={s.numLabel}>PALLETS</div>
                      <div style={{ ...s.numVal, color: "#fbbf24" }}>{l.pallets}</div>
                    </div>
                    {(l.cajas ?? 0) > 0 && (
                      <div style={s.numChip}>
                        <div style={s.numLabel}>CAJAS</div>
                        <div style={s.numVal}>{l.cajas}</div>
                      </div>
                    )}
                    {l.cantidad_fisica != null && (
                      <div style={s.numChip}>
                        <div style={s.numLabel}>CANT. FÍSICA</div>
                        <div style={s.numVal}>{Number(l.cantidad_fisica).toFixed(0)}</div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Supervisor notes (if rejected) */}
                {l.notas_supervisor && (
                  <div style={s.notaBox}>
                    <span style={{ fontSize: 9, letterSpacing: 1.5, color: "#f87171" }}>MOTIVO: </span>
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>{l.notas_supervisor}</span>
                  </div>
                )}

                {/* Actions */}
                {isPendiente && (
                  <div style={s.actions}>
                    <button
                      style={{ ...s.actionBtn, borderColor: "rgba(74,222,128,0.4)", color: "#4ade80", background: "#0f2a0f", opacity: isSaving ? 0.6 : 1 }}
                      onClick={() => aprobar([l.id])}
                      disabled={isSaving}
                    >
                      {isSaving ? "⟳" : "✓ APROBAR"}
                    </button>
                    <button
                      style={{ ...s.actionBtn, borderColor: "rgba(248,113,113,0.3)", color: "#f87171", background: "transparent", opacity: isSaving ? 0.6 : 1 }}
                      onClick={() => { setRejectTarget([l.id]); setRejectNota(""); }}
                      disabled={isSaving}
                    >
                      ✗ RECHAZAR
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Reject modal */}
      {rejectTarget && (
        <div style={s.overlay} onClick={() => { setRejectTarget(null); setRejectNota(""); }}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalTitle}>✗ RECHAZAR {rejectTarget.length > 1 ? `${rejectTarget.length} LÍNEAS` : "LÍNEA"}</div>
            <p style={{ fontSize: 11, color: "#64748b", margin: "0 0 16px" }}>
              El motivo quedará registrado. El operador no verá estas líneas.
            </p>
            <label style={s.fieldLabel}>MOTIVO DEL RECHAZO *</label>
            <textarea
              autoFocus
              value={rejectNota}
              onChange={e => setRejectNota(e.target.value)}
              placeholder="Ej: Lote incorrecto, pallets ya reubicados, error en localizador…"
              style={{ ...s.textarea }}
              rows={3}
            />
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button
                style={{ ...s.modalBtn, background: "#7f1d1d", color: "#fca5a5", opacity: (!rejectNota.trim() || saving === "bulk") ? 0.5 : 1 }}
                onClick={confirmarRechazo}
                disabled={!rejectNota.trim() || saving === "bulk"}
              >
                {saving === "bulk" ? "⟳ Rechazando…" : "CONFIRMAR RECHAZO →"}
              </button>
              <button style={s.modalBtnCancel} onClick={() => { setRejectTarget(null); setRejectNota(""); }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s: { [k: string]: React.CSSProperties } = {
  root:         { padding: "28px 24px", fontFamily: "'Courier New', monospace", color: "#1e293b", minHeight: "100vh", background: "#f1f5f9", position: "relative" },
  flash:        { position: "fixed", top: 20, right: 24, background: "#fff", border: "1px solid", padding: "10px 20px", borderRadius: 3, fontSize: 12, letterSpacing: 1, zIndex: 9999 },
  pageHeader:   { marginBottom: 20 },
  badge:        { display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", marginBottom: 10 },
  title:        { margin: "0 0 4px", fontSize: 22, fontWeight: 700, color: "#0f172a", letterSpacing: 1 },
  sub:          { margin: 0, fontSize: 11, color: "#64748b" },

  statsRow:     { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 18 },
  statCard:     { background: "#ffffff", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 3, padding: "12px 16px" },
  statLabel:    { fontSize: 9, letterSpacing: 2, color: "#94a3b8", marginTop: 3, fontWeight: 600 },

  tabRow:       { display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" as const, alignItems: "center" },
  tab:          { border: "1px solid", fontSize: 10, letterSpacing: 1.5, padding: "6px 12px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 },
  tabCount:     { fontSize: 10, padding: "1px 6px", borderRadius: 10, fontWeight: 700, minWidth: 18, textAlign: "center" as const },
  refreshBtn:   { marginLeft: "auto", background: "transparent", border: "1px solid rgba(249,115,22,0.2)", color: "#64748b", fontSize: 14, padding: "6px 12px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },

  bulkBar:      { background: "#1e293b", border: "1px solid rgba(251,191,36,0.3)", borderRadius: 4, padding: "10px 16px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 10 },
  bulkBtn:      { border: "1px solid", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "7px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },

  selectAllBar: { marginBottom: 10 },
  selectAllBtn: { background: "transparent", border: "none", color: "#64748b", fontSize: 11, cursor: "pointer", fontFamily: "'Courier New', monospace", padding: 0, letterSpacing: 0.5 },

  loading:      { textAlign: "center" as const, color: "#64748b", padding: 50, fontSize: 12 },
  empty:        { textAlign: "center" as const, color: "#94a3b8", padding: 50, fontSize: 13, border: "1px dashed rgba(249,115,22,0.1)", borderRadius: 4 },

  list:         { display: "flex", flexDirection: "column" as const, gap: 10 },
  card:         { border: "1px solid", borderRadius: 4, overflow: "hidden", transition: "border-color 0.15s" },

  cardTop:      { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid rgba(249,115,22,0.06)", background: "#f8fafc" },
  estadoBadge:  { fontSize: 9, letterSpacing: 2, fontWeight: 700, padding: "3px 8px", borderRadius: 2 },
  loteBadge:    { fontSize: 9, letterSpacing: 1, color: "#6366f1", background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.2)", padding: "2px 7px", borderRadius: 2 },
  timeAgo:      { fontSize: 10, color: "#94a3b8" },

  cardBody:     { padding: "12px 14px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" as const },
  mainInfo:     { display: "flex", flexDirection: "column" as const, gap: 6, flex: 1, minWidth: 150 },
  localizador:  { fontFamily: "monospace", fontSize: 18, fontWeight: 700, color: "#f97316", letterSpacing: 1 },
  subinvRow:    { display: "flex", gap: 6, flexWrap: "wrap" as const },
  subinvChip:   { fontSize: 10, letterSpacing: 1, background: "#1e3a5f", color: "#93c5fd", padding: "2px 8px", borderRadius: 2 },
  formatoChip:  { fontSize: 10, letterSpacing: 1, background: "#1a2e1a", color: "#86efac", padding: "2px 8px", borderRadius: 2 },

  numChips:     { display: "flex", gap: 14, alignItems: "flex-start", flexShrink: 0 },
  numChip:      { display: "flex", flexDirection: "column" as const, gap: 2, minWidth: 50 },
  numLabel:     { fontSize: 8, letterSpacing: 2, color: "#94a3b8", fontWeight: 600 },
  numVal:       { fontSize: 20, fontWeight: 700, color: "#1e293b", lineHeight: 1 },

  notaBox:      { padding: "8px 14px", background: "rgba(248,113,113,0.04)", borderTop: "1px solid rgba(248,113,113,0.1)" },

  actions:      { padding: "10px 14px", display: "flex", gap: 8, borderTop: "1px solid rgba(249,115,22,0.06)" },
  actionBtn:    { flex: 1, border: "1px solid", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "9px 0", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", textAlign: "center" as const },

  overlay:      { position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
  modal:        { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.3)", borderRadius: 4, padding: "24px 28px", width: "100%", maxWidth: 480 },
  modalTitle:   { fontSize: 13, fontWeight: 700, letterSpacing: 2, marginBottom: 14, color: "#f87171" },
  fieldLabel:   { fontSize: 9, letterSpacing: 2, color: "#f97316", display: "block" as const, marginBottom: 6, fontWeight: 600 },
  textarea:     { width: "100%", background: "#f1f5f9", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 2, color: "#1e293b", fontSize: 12, padding: "10px", fontFamily: "'Courier New', monospace", outline: "none", resize: "vertical" as const, boxSizing: "border-box" as const },
  modalBtn:     { border: "none", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "10px 16px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  modalBtnCancel: { background: "transparent", border: "1px solid rgba(249,115,22,0.2)", color: "#6b7280", fontSize: 10, letterSpacing: 1, padding: "10px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
};
