"use client";

import { useEffect, useState, useCallback } from "react";
import { getBrowserClient } from "@/lib/supabase/browser";
import { Linea, ESTADO_COLOR, viajesPorLinea } from "@/lib/shared/ordenes";
import { aprobarLinea, rechazarLinea, fraccionarLinea, crearLinea } from "@/app/actions/ordenes";

const db = getBrowserClient();

type Modal =
  | { type: "aprobar" | "rechazar"; linea: Linea }
  | { type: "fraccionar"; linea: Linea }
  | { type: "nueva" }
  | null;

const emptyNueva = {
  numero_orden: "", cod_org_inv: "", codigo: "", descripcion: "",
  subinventario_origen: "", localizador_origen: "", lote: "",
  cantidad_fisica: 0, pallets: 0, cajas: 0,
  subinventario_destino: "", localizador_destino: "",
  responsable: "", inv_pe: 0, notas: "",
};

export default function OrdenesPage() {
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtroEstado, setFiltroEstado] = useState("todos");
  const [modal, setModal] = useState<Modal>(null);
  const [notas, setNotas] = useState("");
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState("");
  const [nueva, setNueva] = useState(emptyNueva);

  // Estado para fraccionar
  const [frac1, setFrac1] = useState({ pallets: 0, cajas: 0, cantidad_fisica: 0, localizador_destino: "", subinventario_destino: "" });
  const [frac2, setFrac2] = useState({ pallets: 0, cajas: 0, cantidad_fisica: 0, localizador_destino: "", subinventario_destino: "" });

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await db
      .from("lineas_reubicacion")
      .select("*")
      .order("created_at", { ascending: false });
    if (!error && data) setLineas(data as Linea[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const showFlash = (msg: string) => { setFlash(msg); setTimeout(() => setFlash(""), 3500); };

  async function handleAprobar() {
    if (!modal || modal.type !== "aprobar") return;
    setSaving(true);
    const res = await aprobarLinea(modal.linea.id, notas);
    setSaving(false);
    if (res?.error) { showFlash("❌ " + res.error); return; }
    setModal(null); setNotas("");
    showFlash("✓ Línea aprobada — visible para el operador");
    load();
  }

  async function handleRechazar() {
    if (!modal || modal.type !== "rechazar") return;
    setSaving(true);
    const res = await rechazarLinea(modal.linea.id, notas);
    setSaving(false);
    if (res?.error) { showFlash("❌ " + res.error); return; }
    setModal(null); setNotas("");
    showFlash("✓ Línea rechazada");
    load();
  }

  async function handleFraccionar() {
    if (!modal || modal.type !== "fraccionar") return;
    if (frac1.pallets + frac2.pallets !== modal.linea.pallets) {
      showFlash(`⚠ Los pallets de las fracciones (${frac1.pallets}+${frac2.pallets}) deben sumar ${modal.linea.pallets}`);
      return;
    }
    setSaving(true);
    const res = await fraccionarLinea(modal.linea.id, frac1, frac2);
    setSaving(false);
    if (res?.error) { showFlash("❌ " + res.error); return; }
    setModal(null);
    showFlash("✓ Línea fraccionada en 2 — ambas están aprobadas para el operador");
    load();
  }

  async function handleCrear() {
    if (!nueva.descripcion || nueva.pallets < 1) {
      showFlash("⚠ Descripción y pallets son requeridos");
      return;
    }
    setSaving(true);
    const res = await crearLinea({ ...nueva, cantidad_fisica: Number(nueva.cantidad_fisica), pallets: Number(nueva.pallets), cajas: Number(nueva.cajas), inv_pe: Number(nueva.inv_pe) });
    setSaving(false);
    if (res?.error) { showFlash("❌ " + res.error); return; }
    setModal(null); setNueva(emptyNueva);
    showFlash("✓ Línea creada");
    load();
  }

  function openFraccionar(linea: Linea) {
    const halfPallets = Math.floor(linea.pallets / 2);
    const halfCajas = Math.floor(linea.cajas / 2);
    const halfCant = linea.cantidad_fisica / 2;
    setFrac1({ pallets: halfPallets, cajas: halfCajas, cantidad_fisica: Math.round(halfCant * 100) / 100, localizador_destino: linea.localizador_destino || "", subinventario_destino: linea.subinventario_destino || "" });
    setFrac2({ pallets: linea.pallets - halfPallets, cajas: linea.cajas - halfCajas, cantidad_fisica: Math.round((linea.cantidad_fisica - halfCant) * 100) / 100, localizador_destino: linea.localizador_destino || "", subinventario_destino: linea.subinventario_destino || "" });
    setModal({ type: "fraccionar", linea });
  }

  function autoFrac2(linea: Linea, f1: typeof frac1) {
    const f2 = {
      pallets: Math.max(0, linea.pallets - f1.pallets),
      cajas: Math.max(0, linea.cajas - f1.cajas),
      cantidad_fisica: Math.max(0, Math.round((linea.cantidad_fisica - f1.cantidad_fisica) * 100) / 100),
      localizador_destino: frac2.localizador_destino,
      subinventario_destino: frac2.subinventario_destino,
    };
    setFrac2(f2);
  }

  const filtradas = filtroEstado === "todos" ? lineas : lineas.filter(l => l.estado === filtroEstado);

  const stats = {
    total: lineas.length,
    pendientes: lineas.filter(l => l.estado === "pendiente").length,
    aprobadas: lineas.filter(l => l.estado === "aprobada").length,
    enProceso: lineas.filter(l => l.estado === "en_proceso").length,
    completadas: lineas.filter(l => l.estado === "completada").length,
  };

  return (
    <div style={s.root}>
      {flash && <div style={s.flash}>{flash}</div>}

      <div style={s.pageHeader}>
        <div style={s.badge}>PRODUCCION — REUBICACION</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 12 }}>
          <div>
            <h1 style={s.title}>Órdenes de Reubicación</h1>
            <p style={s.sub}>Supervisor: revisa, aprueba o fracciona cada línea antes de enviar al operador</p>
          </div>
          <button style={s.btnPrimary} onClick={() => setModal({ type: "nueva" })}>+ NUEVA LÍNEA</button>
        </div>
      </div>

      {/* Stats */}
      <div style={s.statsRow}>
        {[
          { label: "TOTAL", val: stats.total, color: "#e2e8f0" },
          { label: "PENDIENTES", val: stats.pendientes, color: "#fbbf24" },
          { label: "APROBADAS", val: stats.aprobadas, color: "#4ade80" },
          { label: "EN PROCESO", val: stats.enProceso, color: "#60a5fa" },
          { label: "COMPLETADAS", val: stats.completadas, color: "#a78bfa" },
        ].map(st => (
          <div key={st.label} style={s.statCard}>
            <div style={{ fontSize: 22, fontWeight: 700, color: st.color }}>{st.val}</div>
            <div style={s.statLabel}>{st.label}</div>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div style={s.filters}>
        {["todos", "pendiente", "aprobada", "rechazada", "en_proceso", "completada"].map(f => (
          <button key={f} onClick={() => setFiltroEstado(f)}
            style={{ ...s.filterBtn, background: filtroEstado === f ? "#f97316" : "transparent", color: filtroEstado === f ? "#000" : "#6b7280" }}>
            {f === "todos" ? "TODOS" : (ESTADO_COLOR[f as keyof typeof ESTADO_COLOR]?.label ?? f.toUpperCase())}
          </button>
        ))}
        <button onClick={load} style={s.refreshBtn}>↻</button>
      </div>

      {/* Tabla */}
      {loading ? (
        <div style={s.loading}>Cargando líneas…</div>
      ) : filtradas.length === 0 ? (
        <div style={s.empty}>No hay líneas{filtroEstado !== "todos" ? ` "${filtroEstado}"` : ""}</div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr style={s.thead}>
                {["ORD", "COD. ORG", "CÓDIGO", "DESCRIPCIÓN", "SI ORIGEN", "LOC ORIGEN", "LOTE", "CANT. FÍS.", "PLT", "CAJAS", "SI DESTINO", "LOC DESTINO", "RESP.", "INV-PE", "CONTEO", "VIAJES", "ESTADO", "ACCIONES"].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtradas.map((l, i) => {
                const est = ESTADO_COLOR[l.estado] ?? ESTADO_COLOR.pendiente;
                const viajes = viajesPorLinea(l.pallets || 0);
                return (
                  <tr key={l.id} style={{ ...s.tr, background: l.es_fraccion ? "rgba(37,99,235,0.04)" : (i % 2 === 0 ? "transparent" : "#0d1117") }}>
                    <td style={s.td}><span style={s.ordenNum}>{l.numero_orden || "—"}{l.es_fraccion && <span style={s.fracTag}>⌥</span>}</span></td>
                    <td style={{ ...s.td, color: "#6b7280" }}>{l.cod_org_inv || "—"}</td>
                    <td style={{ ...s.td, color: "#f97316", fontWeight: 600 }}>{l.codigo || "—"}</td>
                    <td style={{ ...s.td, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{l.descripcion}</td>
                    <td style={{ ...s.td, color: "#6b7280", fontSize: 10 }}>{l.subinventario_origen || "—"}</td>
                    <td style={{ ...s.td, color: "#e2e8f0", fontFamily: "monospace" }}>{l.localizador_origen || "—"}</td>
                    <td style={{ ...s.td, color: "#6b7280", fontFamily: "monospace", fontSize: 11 }}>{l.lote || "—"}</td>
                    <td style={{ ...s.td, textAlign: "right" as const }}>{l.cantidad_fisica?.toFixed(2) || "0.00"}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, fontWeight: 700, color: "#fbbf24" }}>{l.pallets}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#9ca3af" }}>{l.cajas}</td>
                    <td style={{ ...s.td, color: "#6b7280", fontSize: 10 }}>{l.subinventario_destino || "—"}</td>
                    <td style={{ ...s.td, color: "#60a5fa", fontFamily: "monospace" }}>{l.localizador_destino || "—"}</td>
                    <td style={{ ...s.td, color: "#6b7280", fontSize: 11 }}>{l.responsable || "—"}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#6b7280" }}>{l.inv_pe ?? "—"}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#374151" }}>{l.conteo ?? "—"}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#4ade80", fontWeight: 700 }}>{viajes}</td>
                    <td style={s.td}>
                      <span style={{ ...s.badge2, background: est.bg, color: est.color }}>{est.label}</span>
                    </td>
                    <td style={s.td}>
                      {l.estado === "pendiente" && (
                        <div style={{ display: "flex", gap: 4 }}>
                          <button style={s.btnAprobar} onClick={() => { setModal({ type: "aprobar", linea: l }); setNotas(""); }}>✓</button>
                          <button style={s.btnRechazar} onClick={() => { setModal({ type: "rechazar", linea: l }); setNotas(""); }}>✗</button>
                          <button style={s.btnFraccionar} onClick={() => openFraccionar(l)} title="Fraccionar línea">⌥</button>
                        </div>
                      )}
                      {l.estado === "aprobada" && (
                        <button style={s.btnFraccionar} onClick={() => openFraccionar(l)} title="Fraccionar">⌥ Frac.</button>
                      )}
                      {l.duracion_minutos != null && (
                        <span style={{ fontSize: 10, color: "#a78bfa" }}>{l.duracion_minutos.toFixed(1)} min</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal Aprobar / Rechazar */}
      {modal && (modal.type === "aprobar" || modal.type === "rechazar") && (
        <div style={s.overlay} onClick={() => setModal(null)}>
          <div style={s.modalBox} onClick={e => e.stopPropagation()}>
            <div style={{ ...s.modalTitle, color: modal.type === "aprobar" ? "#4ade80" : "#f87171" }}>
              {modal.type === "aprobar" ? "✓ APROBAR LÍNEA" : "✗ RECHAZAR LÍNEA"}
            </div>
            <div style={s.modalInfo}>
              <div style={{ fontWeight: 700, color: "#f97316" }}>{modal.linea.numero_orden || "Sin número"}</div>
              <div>{modal.linea.descripcion}</div>
              <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 11, color: "#6b7280" }}>
                <span>🔢 {modal.linea.pallets} plt · {modal.linea.cajas} cajas</span>
                <span>→ {modal.linea.localizador_destino || "Sin destino"}</span>
                <span>🚌 {viajesPorLinea(modal.linea.pallets || 0)} viajes</span>
              </div>
            </div>
            <label style={s.fieldLabel}>Notas del supervisor (opcional)</label>
            <textarea value={notas} onChange={e => setNotas(e.target.value)}
              placeholder={modal.type === "aprobar" ? "Instrucciones para el operador…" : "Motivo del rechazo…"}
              style={s.textarea} rows={3} />
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button style={{ ...s.modalBtn, background: modal.type === "aprobar" ? "#166534" : "#7f1d1d", color: "#fff", opacity: saving ? 0.6 : 1 }}
                onClick={modal.type === "aprobar" ? handleAprobar : handleRechazar} disabled={saving}>
                {saving ? "Guardando…" : modal.type === "aprobar" ? "CONFIRMAR APROBACIÓN" : "CONFIRMAR RECHAZO"}
              </button>
              <button style={s.modalBtnCancel} onClick={() => setModal(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Fraccionar */}
      {modal && modal.type === "fraccionar" && (
        <div style={s.overlay} onClick={() => setModal(null)}>
          <div style={{ ...s.modalBox, maxWidth: 620 }} onClick={e => e.stopPropagation()}>
            <div style={{ ...s.modalTitle, color: "#fbbf24" }}>⌥ FRACCIONAR LÍNEA</div>
            <div style={s.modalInfo}>
              <div>{modal.linea.descripcion} — <b>{modal.linea.pallets} plt total · {modal.linea.cajas} cajas · {modal.linea.cantidad_fisica} cant. física</b></div>
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>Divide la línea cuando la ubicación destino no tiene suficiente capacidad. Los pallets de ambas fracciones deben sumar {modal.linea.pallets}.</div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
              {/* Fracción 1 */}
              <div style={s.fracBox}>
                <div style={s.fracTitle}>FRACCIÓN 1</div>
                {[
                  { key: "pallets", label: "PALLETS *", type: "number" },
                  { key: "cajas", label: "CAJAS", type: "number" },
                  { key: "cantidad_fisica", label: "CANT. FÍSICA", type: "number" },
                  { key: "localizador_destino", label: "LOC. DESTINO *", type: "text" },
                  { key: "subinventario_destino", label: "SUBINV. DESTINO", type: "text" },
                ].map(f => (
                  <div key={f.key} style={{ marginBottom: 8 }}>
                    <label style={s.fieldLabel}>{f.label}</label>
                    <input style={s.fieldInput} type={f.type}
                      value={String(frac1[f.key as keyof typeof frac1])}
                      onChange={e => {
                        const val = f.type === "number" ? Number(e.target.value) : e.target.value;
                        const updated = { ...frac1, [f.key]: val };
                        setFrac1(updated);
                        if (["pallets", "cajas", "cantidad_fisica"].includes(f.key)) {
                          autoFrac2(modal.linea, updated);
                        }
                      }} />
                  </div>
                ))}
              </div>
              {/* Fracción 2 */}
              <div style={s.fracBox}>
                <div style={{ ...s.fracTitle, color: "#60a5fa" }}>FRACCIÓN 2 (auto)</div>
                {[
                  { key: "pallets", label: "PALLETS", ro: true },
                  { key: "cajas", label: "CAJAS", ro: true },
                  { key: "cantidad_fisica", label: "CANT. FÍSICA", ro: true },
                  { key: "localizador_destino", label: "LOC. DESTINO *", ro: false },
                  { key: "subinventario_destino", label: "SUBINV. DESTINO", ro: false },
                ].map(f => (
                  <div key={f.key} style={{ marginBottom: 8 }}>
                    <label style={s.fieldLabel}>{f.label}</label>
                    <input style={{ ...s.fieldInput, background: f.ro ? "#080c14" : undefined }}
                      type={["pallets", "cajas", "cantidad_fisica"].includes(f.key) ? "number" : "text"}
                      readOnly={f.ro}
                      value={String(frac2[f.key as keyof typeof frac2])}
                      onChange={e => setFrac2(p => ({ ...p, [f.key]: e.target.value }))} />
                  </div>
                ))}
              </div>
            </div>

            {/* Validación visual */}
            <div style={{ fontSize: 11, marginBottom: 12, padding: "8px 12px", borderRadius: 3, background: frac1.pallets + frac2.pallets === modal.linea.pallets ? "#0f2a0f" : "#2a0f0f", color: frac1.pallets + frac2.pallets === modal.linea.pallets ? "#4ade80" : "#f87171" }}>
              {frac1.pallets + frac2.pallets === modal.linea.pallets
                ? `✓ Pallets cuadran: ${frac1.pallets} + ${frac2.pallets} = ${modal.linea.pallets}`
                : `⚠ Pallets no cuadran: ${frac1.pallets} + ${frac2.pallets} ≠ ${modal.linea.pallets}`}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...s.modalBtn, background: "#92400e", color: "#fff", opacity: saving ? 0.6 : 1 }} onClick={handleFraccionar} disabled={saving}>
                {saving ? "Fraccionando…" : "CONFIRMAR FRACCIÓN"}
              </button>
              <button style={s.modalBtnCancel} onClick={() => setModal(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Nueva Línea */}
      {modal && modal.type === "nueva" && (
        <div style={s.overlay} onClick={() => setModal(null)}>
          <div style={{ ...s.modalBox, maxWidth: 600 }} onClick={e => e.stopPropagation()}>
            <div style={s.modalTitle}>+ NUEVA LÍNEA DE REUBICACIÓN</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 14px" }}>
              {[
                { k: "numero_orden", l: "# ORDEN", ph: "OP-2026-001" },
                { k: "cod_org_inv", l: "COD. ORG INV", ph: "GR101" },
                { k: "codigo", l: "CÓDIGO", ph: "231421E" },
                { k: "descripcion", l: "DESCRIPCIÓN *", ph: "GALIA 23.3X41..." },
                { k: "lote", l: "LOTE", ph: "T570A" },
                { k: "responsable", l: "RESPONSABLE", ph: "MARCO_MEJIA" },
                { k: "subinventario_origen", l: "SI ORIGEN", ph: "ZONA09" },
                { k: "localizador_origen", l: "LOC. ORIGEN", ph: "09.21.00.00" },
                { k: "subinventario_destino", l: "SI DESTINO", ph: "ZONA15" },
                { k: "localizador_destino", l: "LOC. DESTINO", ph: "15.53.00.00" },
                { k: "cantidad_fisica", l: "CANT. FÍSICA", ph: "0", num: true },
                { k: "pallets", l: "PALLETS *", ph: "0", num: true },
                { k: "cajas", l: "CAJAS", ph: "0", num: true },
                { k: "inv_pe", l: "INV-PE", ph: "31", num: true },
                { k: "notas", l: "NOTAS", ph: "Observaciones…" },
              ].map(f => (
                <div key={f.k} style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
                  <label style={s.fieldLabel}>{f.l}</label>
                  <input style={s.fieldInput} type={f.num ? "number" : "text"} placeholder={f.ph}
                    value={String(nueva[f.k as keyof typeof nueva])}
                    onChange={e => setNueva(p => ({ ...p, [f.k]: f.num ? Number(e.target.value) : e.target.value }))} />
                </div>
              ))}
            </div>
            {nueva.pallets > 0 && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#4ade80" }}>
                🚌 {viajesPorLinea(nueva.pallets)} viajes calculados (2 pallets por viaje)
              </div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button style={{ ...s.modalBtn, background: "#c2410c", color: "#fff", opacity: saving ? 0.6 : 1 }} onClick={handleCrear} disabled={saving}>
                {saving ? "Creando…" : "CREAR LÍNEA →"}
              </button>
              <button style={s.modalBtnCancel} onClick={() => setModal(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const s: { [k: string]: React.CSSProperties } = {
  root: { padding: "28px 24px", fontFamily: "'Courier New', monospace", color: "#e2e8f0", minHeight: "100vh", background: "#0a0e17", position: "relative" },
  flash: { position: "fixed", top: 20, right: 24, background: "#0d1117", border: "1px solid rgba(249,115,22,0.4)", color: "#f97316", padding: "10px 20px", borderRadius: 3, fontSize: 12, letterSpacing: 1, zIndex: 9999 },
  pageHeader: { marginBottom: 20 },
  badge: { display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", marginBottom: 10 },
  title: { margin: "0 0 4px", fontSize: 22, fontWeight: 700, color: "#fff", letterSpacing: 1 },
  sub: { margin: 0, fontSize: 11, color: "#4a5568" },
  btnPrimary: { background: "#f97316", border: "none", color: "#000", fontSize: 10, fontWeight: 700, letterSpacing: 2, padding: "9px 18px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  statsRow: { display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" as const },
  statCard: { background: "#0d1117", border: "1px solid rgba(249,115,22,0.1)", borderRadius: 3, padding: "10px 18px", flex: 1, minWidth: 90 },
  statLabel: { fontSize: 9, letterSpacing: 2, color: "#374151", marginTop: 3 },
  filters: { display: "flex", gap: 5, marginBottom: 14, flexWrap: "wrap" as const, alignItems: "center" },
  filterBtn: { border: "1px solid rgba(249,115,22,0.2)", fontSize: 9, letterSpacing: 1.5, padding: "5px 10px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", fontWeight: 600 },
  refreshBtn: { background: "transparent", border: "1px solid rgba(249,115,22,0.12)", color: "#4a5568", fontSize: 13, padding: "5px 10px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  loading: { textAlign: "center" as const, color: "#4a5568", padding: 40, fontSize: 12 },
  empty: { textAlign: "center" as const, color: "#374151", padding: 40, fontSize: 12, border: "1px dashed rgba(249,115,22,0.1)", borderRadius: 3 },
  tableWrap: { overflowX: "auto" as const, border: "1px solid rgba(249,115,22,0.1)", borderRadius: 3 },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 11 },
  thead: { borderBottom: "1px solid rgba(249,115,22,0.15)", background: "#080c14" },
  th: { padding: "7px 10px", textAlign: "left" as const, fontSize: 9, letterSpacing: 1.5, color: "#374151", fontWeight: 700, whiteSpace: "nowrap" as const },
  tr: { borderBottom: "1px solid rgba(249,115,22,0.04)" },
  td: { padding: "7px 10px", verticalAlign: "middle" as const, whiteSpace: "nowrap" as const },
  ordenNum: { color: "#f97316", fontWeight: 700, letterSpacing: 0.5, position: "relative" as const },
  fracTag: { fontSize: 9, color: "#60a5fa", marginLeft: 4 },
  badge2: { display: "inline-block", fontSize: 9, letterSpacing: 1, fontWeight: 700, padding: "2px 8px", borderRadius: 2 },
  btnAprobar: { background: "transparent", border: "1px solid rgba(34,197,94,0.3)", color: "#4ade80", fontSize: 10, padding: "4px 8px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  btnRechazar: { background: "transparent", border: "1px solid rgba(248,113,113,0.3)", color: "#f87171", fontSize: 10, padding: "4px 8px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  btnFraccionar: { background: "transparent", border: "1px solid rgba(251,191,36,0.3)", color: "#fbbf24", fontSize: 10, padding: "4px 8px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, overflowY: "auto" as const },
  modalBox: { background: "#0d1117", border: "1px solid rgba(249,115,22,0.3)", borderRadius: 4, padding: "24px 28px", width: "100%", maxWidth: 460 },
  modalTitle: { fontSize: 13, fontWeight: 700, letterSpacing: 2, marginBottom: 14 },
  modalInfo: { fontSize: 12, color: "#e2e8f0", marginBottom: 14, padding: "10px 14px", background: "#0a0e17", borderRadius: 3 },
  fieldLabel: { fontSize: 9, letterSpacing: 2, color: "#f97316", display: "block" as const, marginBottom: 5, fontWeight: 600 },
  textarea: { width: "100%", background: "#0a0e17", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 2, color: "#e2e8f0", fontSize: 11, padding: "8px 10px", fontFamily: "'Courier New', monospace", resize: "vertical" as const, boxSizing: "border-box" as const, outline: "none" },
  modalBtn: { border: "none", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "10px 16px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  modalBtnCancel: { background: "transparent", border: "1px solid rgba(249,115,22,0.2)", color: "#6b7280", fontSize: 10, letterSpacing: 1, padding: "10px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  fieldInput: { background: "#0a0e17", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 2, color: "#e2e8f0", fontSize: 11, padding: "7px 9px", fontFamily: "'Courier New', monospace", width: "100%", boxSizing: "border-box" as const, outline: "none" },
  fracBox: { background: "#080c14", border: "1px solid rgba(249,115,22,0.12)", borderRadius: 3, padding: "14px" },
  fracTitle: { fontSize: 9, letterSpacing: 2, color: "#fbbf24", fontWeight: 700, marginBottom: 12 },
};
