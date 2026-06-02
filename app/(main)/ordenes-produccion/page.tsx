"use client";

import { useEffect, useState, useCallback } from "react";
import { getBrowserClient } from "@/lib/supabase/browser";
import { Linea, ESTADO_COLOR, viajesPorLinea } from "@/lib/shared/ordenes";
import {
  aprobarLinea, rechazarLinea, fraccionarLinea, crearLinea,
  aprobarLineaDirecta, actualizarResponsable,
} from "@/app/actions/ordenes";

const db = getBrowserClient();

interface Operador {
  id: string;
  nombre: string;
  email: string;
  rol: string;
  bodega_cedi: string;
}

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
  const [lineas, setLineas]         = useState<Linea[]>([]);
  const [operadores, setOperadores] = useState<Operador[]>([]);
  const [loading, setLoading]       = useState(true);
  const [filtroEstado, setFiltroEstado] = useState("todos");
  const [modal, setModal]           = useState<Modal>(null);
  const [notas, setNotas]           = useState("");
  const [saving, setSaving]         = useState(false);
  const [flash, setFlash]           = useState("");
  const [nueva, setNueva]           = useState(emptyNueva);

  // Inline responsable editing
  const [editResp, setEditResp]       = useState<{ id: string; value: string } | null>(null);
  const [savingResp, setSavingResp]   = useState<string | null>(null);

  // Quick direct approval
  const [quickSaving, setQuickSaving] = useState<string | null>(null);

  // Fraccionar state
  const [frac1, setFrac1] = useState({ pallets: 0, cajas: 0, cantidad_fisica: 0, localizador_destino: "", subinventario_destino: "" });
  const [frac2, setFrac2] = useState({ pallets: 0, cajas: 0, cantidad_fisica: 0, localizador_destino: "", subinventario_destino: "" });

  // Load lines
  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await db
      .from("lineas_reubicacion")
      .select("*")
      .order("created_at", { ascending: false });
    if (!error && data) setLineas(data as Linea[]);
    setLoading(false);
  }, []);

  // Load operators from usuarios_bodega
  useEffect(() => {
    db.from("usuarios_bodega")
      .select("id,nombre,email,rol,bodega_cedi")
      .order("nombre")
      .then(({ data }) => {
        if (data) setOperadores(data as Operador[]);
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  const showFlash = (msg: string) => { setFlash(msg); setTimeout(() => setFlash(""), 3500); };

  // ── Quick approve (no modal) ──────────────────────────────────────────────
  async function handleAprobarDirecta(linea: Linea) {
    setQuickSaving(linea.id);
    const res = await aprobarLineaDirecta(linea.id, linea.responsable || undefined);
    setQuickSaving(null);
    if (res?.error) { showFlash("❌ " + res.error); return; }
    showFlash(`✓ Línea aprobada → visible para ${linea.responsable || "el operador"}`);
    load();
  }

  // ── Inline responsable save ───────────────────────────────────────────────
  async function saveResp(id: string, value: string) {
    setSavingResp(id);
    const res = await actualizarResponsable(id, value.trim());
    setSavingResp(null);
    setEditResp(null);
    if (res?.error) showFlash("❌ " + res.error);
    else { showFlash("✓ Responsable actualizado"); load(); }
  }

  // ── Modal actions ─────────────────────────────────────────────────────────
  async function handleAprobar() {
    if (!modal || modal.type !== "aprobar") return;
    setSaving(true);
    const res = await aprobarLinea(modal.linea.id, notas);
    setSaving(false);
    if (res?.error) { showFlash("❌ " + res.error); return; }
    setModal(null); setNotas("");
    showFlash("✓ Línea aprobada con notas — visible para el operador");
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
      showFlash(`⚠ Los pallets (${frac1.pallets}+${frac2.pallets}) deben sumar ${modal.linea.pallets}`);
      return;
    }
    setSaving(true);
    const res = await fraccionarLinea(modal.linea.id, frac1, frac2);
    setSaving(false);
    if (res?.error) { showFlash("❌ " + res.error); return; }
    setModal(null);
    showFlash("✓ Línea fraccionada — ambas fracciones aprobadas para el operador");
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
    const halfCajas   = Math.floor(linea.cajas / 2);
    const halfCant    = linea.cantidad_fisica / 2;
    setFrac1({ pallets: halfPallets, cajas: halfCajas, cantidad_fisica: Math.round(halfCant * 100) / 100, localizador_destino: linea.localizador_destino || "", subinventario_destino: linea.subinventario_destino || "" });
    setFrac2({ pallets: linea.pallets - halfPallets, cajas: linea.cajas - halfCajas, cantidad_fisica: Math.round((linea.cantidad_fisica - halfCant) * 100) / 100, localizador_destino: linea.localizador_destino || "", subinventario_destino: linea.subinventario_destino || "" });
    setModal({ type: "fraccionar", linea });
  }

  function autoFrac2(linea: Linea, f1: typeof frac1) {
    setFrac2({
      pallets:           Math.max(0, linea.pallets - f1.pallets),
      cajas:             Math.max(0, linea.cajas - f1.cajas),
      cantidad_fisica:   Math.max(0, Math.round((linea.cantidad_fisica - f1.cantidad_fisica) * 100) / 100),
      localizador_destino:   frac2.localizador_destino,
      subinventario_destino: frac2.subinventario_destino,
    });
  }

  const filtradas = filtroEstado === "todos" ? lineas : lineas.filter(l => l.estado === filtroEstado);

  const stats = {
    total:      lineas.length,
    pendientes: lineas.filter(l => l.estado === "pendiente").length,
    aprobadas:  lineas.filter(l => l.estado === "aprobada").length,
    enProceso:  lineas.filter(l => l.estado === "en_proceso").length,
    completadas:lineas.filter(l => l.estado === "completada").length,
  };

  return (
    <div style={s.root}>
      {flash && <div style={s.flash}>{flash}</div>}

      <div style={s.pageHeader}>
        <div style={s.badge}>PRODUCCION — REUBICACION</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 12 }}>
          <div>
            <h1 style={s.title}>Órdenes de Reubicación</h1>
            <p style={s.sub}>Supervisor: edita el responsable, aprueba o fracciona cada línea</p>
          </div>
          <button style={s.btnPrimary} onClick={() => setModal({ type: "nueva" })}>+ NUEVA LÍNEA</button>
        </div>
      </div>

      {/* Stats */}
      <div style={s.statsRow}>
        {[
          { label: "TOTAL",      val: stats.total,       color: "#1e293b" },
          { label: "PENDIENTES", val: stats.pendientes,  color: "#fbbf24" },
          { label: "APROBADAS",  val: stats.aprobadas,   color: "#4ade80" },
          { label: "EN PROCESO", val: stats.enProceso,   color: "#60a5fa" },
          { label: "COMPLETADAS",val: stats.completadas, color: "#a78bfa" },
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
            style={{ ...s.filterBtn, background: filtroEstado === f ? "#f97316" : "transparent", color: filtroEstado === f ? "#000" : "#9ca3af" }}>
            {f === "todos" ? "TODOS" : (ESTADO_COLOR[f as keyof typeof ESTADO_COLOR]?.label ?? f.toUpperCase())}
          </button>
        ))}
        <button onClick={load} style={s.refreshBtn}>↻</button>
      </div>

      {/* Tabla */}
      {loading ? (
        <div style={s.loading}>Cargando líneas…</div>
      ) : filtradas.length === 0 ? (
        <div style={s.empty}>No hay líneas{filtroEstado !== "todos" ? ` con estado "${filtroEstado}"` : ""}</div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr style={s.thead}>
                {["ORD", "COD. ORG", "CÓDIGO", "DESCRIPCIÓN", "SI ORIGEN", "LOC ORIGEN", "LOTE", "CANT. FÍS.", "PLT", "CAJAS", "SI DESTINO", "LOC DESTINO", "RESPONSABLE ✎", "INV-PE", "CONTEO", "VIAJES", "ESTADO", "ACCIONES"].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtradas.map((l, i) => {
                const est    = ESTADO_COLOR[l.estado] ?? ESTADO_COLOR.pendiente;
                const viajes = viajesPorLinea(l.pallets || 0);
                const isEditingResp = editResp?.id === l.id;

                return (
                  <tr key={l.id} style={{ ...s.tr, background: l.es_fraccion ? "rgba(37,99,235,0.05)" : (i % 2 === 0 ? "transparent" : "#0d1117") }}>

                    <td style={s.td}><span style={s.ordenNum}>{l.numero_orden || "—"}{l.es_fraccion && <span style={s.fracTag}>⌥</span>}</span></td>
                    <td style={{ ...s.td, color: "#9ca3af" }}>{l.cod_org_inv || "—"}</td>
                    <td style={{ ...s.td, color: "#f97316", fontWeight: 600 }}>{l.codigo || "—"}</td>
                    <td style={{ ...s.td, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{l.descripcion}</td>
                    <td style={{ ...s.td, color: "#64748b", fontSize: 10 }}>{l.subinventario_origen || "—"}</td>
                    <td style={{ ...s.td, color: "#1e293b", fontFamily: "monospace" }}>{l.localizador_origen || "—"}</td>
                    <td style={{ ...s.td, color: "#64748b", fontFamily: "monospace", fontSize: 11 }}>{l.lote || "—"}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#374151" }}>{l.cantidad_fisica?.toFixed(2) || "0.00"}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, fontWeight: 700, color: "#fbbf24" }}>{l.pallets}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#9ca3af" }}>{l.cajas}</td>
                    <td style={{ ...s.td, color: "#64748b", fontSize: 10 }}>{l.subinventario_destino || "—"}</td>
                    <td style={{ ...s.td, color: "#60a5fa", fontFamily: "monospace" }}>{l.localizador_destino || "—"}</td>

                    {/* RESPONSABLE — dropdown de operadores */}
                    <td style={{ ...s.td, minWidth: 150 }}>
                      {isEditingResp ? (
                        <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                          <select
                            autoFocus
                            style={s.respSelect}
                            value={editResp.value}
                            onChange={e => setEditResp({ id: l.id, value: e.target.value })}
                            onKeyDown={e => {
                              if (e.key === "Enter") saveResp(l.id, editResp.value);
                              if (e.key === "Escape") setEditResp(null);
                            }}
                          >
                            <option value="">— sin asignar —</option>
                            {operadores.map(op => (
                              <option key={op.id} value={op.nombre || op.email}>
                                {op.nombre || op.email}
                                {op.bodega_cedi ? ` · ${op.bodega_cedi}` : ""}
                              </option>
                            ))}
                          </select>
                          <button style={s.btnSaveSmall} onClick={() => saveResp(l.id, editResp.value)} disabled={savingResp === l.id}>✓</button>
                          <button style={s.btnCancelSmall} onClick={() => setEditResp(null)}>✗</button>
                        </div>
                      ) : (
                        <span
                          style={{ color: l.responsable ? "#e2e8f0" : "#6b7280", cursor: "pointer", borderBottom: "1px dashed rgba(249,115,22,0.35)", paddingBottom: 1, fontSize: 11 }}
                          onClick={() => setEditResp({ id: l.id, value: l.responsable || "" })}
                          title="Clic para asignar operador"
                        >
                          {l.responsable || "— asignar"}
                        </span>
                      )}
                    </td>

                    <td style={{ ...s.td, textAlign: "right" as const, color: "#374151" }}>{l.inv_pe ?? "—"}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#9ca3af" }}>{l.conteo ?? "—"}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#4ade80", fontWeight: 700 }}>{viajes}</td>
                    <td style={s.td}>
                      <span style={{ ...s.badge2, background: est.bg, color: est.color }}>{est.label}</span>
                    </td>

                    {/* ACCIONES */}
                    <td style={{ ...s.td, minWidth: 200 }}>
                      {l.estado === "pendiente" && (
                        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" as const }}>
                          {/* Botón principal: APROBAR LÍNEA */}
                          <button
                            style={{ ...s.btnAprobarDirect, opacity: quickSaving === l.id ? 0.6 : 1 }}
                            disabled={quickSaving === l.id}
                            onClick={() => handleAprobarDirecta(l)}
                            title={`Aprobar y asignar a ${l.responsable || "operador"}`}
                          >
                            {quickSaving === l.id ? "…" : "✓ APROBAR LÍNEA"}
                          </button>
                          {/* Aprobar con notas */}
                          <button style={s.btnAprobar} onClick={() => { setModal({ type: "aprobar", linea: l }); setNotas(""); }} title="Aprobar con notas">📝</button>
                          {/* Rechazar */}
                          <button style={s.btnRechazar} onClick={() => { setModal({ type: "rechazar", linea: l }); setNotas(""); }} title="Rechazar">✗</button>
                          {/* Fraccionar */}
                          <button style={s.btnFraccionar} onClick={() => openFraccionar(l)} title="Fraccionar línea">⌥</button>
                        </div>
                      )}
                      {l.estado === "aprobada" && (
                        <div style={{ display: "flex", gap: 4 }}>
                          <span style={{ fontSize: 10, color: "#4ade80" }}>→ {l.responsable || "operador"}</span>
                          <button style={s.btnFraccionar} onClick={() => openFraccionar(l)} title="Fraccionar">⌥</button>
                        </div>
                      )}
                      {l.estado === "en_proceso" && l.responsable && (
                        <span style={{ fontSize: 10, color: "#60a5fa" }}>⚙ {l.responsable}</span>
                      )}
                      {l.duracion_minutos != null && (
                        <span style={{ fontSize: 10, color: "#a78bfa", display: "block", marginTop: 2 }}>{l.duracion_minutos.toFixed(1)} min</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal Aprobar con notas / Rechazar */}
      {modal && (modal.type === "aprobar" || modal.type === "rechazar") && (
        <div style={s.overlay} onClick={() => setModal(null)}>
          <div style={s.modalBox} onClick={e => e.stopPropagation()}>
            <div style={{ ...s.modalTitle, color: modal.type === "aprobar" ? "#4ade80" : "#f87171" }}>
              {modal.type === "aprobar" ? "✓ APROBAR CON NOTAS" : "✗ RECHAZAR LÍNEA"}
            </div>
            <div style={s.modalInfo}>
              <div style={{ fontWeight: 700, color: "#f97316" }}>{modal.linea.numero_orden || "Sin número"}</div>
              <div style={{ color: "#1e293b" }}>{modal.linea.descripcion}</div>
              <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 11, color: "#9ca3af" }}>
                <span>🔢 {modal.linea.pallets} plt · {modal.linea.cajas} cajas</span>
                <span>→ {modal.linea.localizador_destino || "Sin destino"}</span>
                <span>🚌 {viajesPorLinea(modal.linea.pallets || 0)} viajes</span>
                {modal.linea.responsable && <span>👷 {modal.linea.responsable}</span>}
              </div>
            </div>
            <label style={s.fieldLabel}>{modal.type === "aprobar" ? "Instrucciones para el operador" : "Motivo del rechazo"}</label>
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
              <div style={{ color: "#1e293b" }}>{modal.linea.descripcion} — <b>{modal.linea.pallets} plt · {modal.linea.cajas} cajas</b></div>
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>Los pallets de ambas fracciones deben sumar {modal.linea.pallets}.</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
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
                        if (["pallets", "cajas", "cantidad_fisica"].includes(f.key)) autoFrac2(modal.linea, updated);
                      }} />
                  </div>
                ))}
              </div>
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
                    <input style={{ ...s.fieldInput, background: f.ro ? "#080c14" : undefined, color: f.ro ? "#9ca3af" : "#e2e8f0" }}
                      type={["pallets", "cajas", "cantidad_fisica"].includes(f.key) ? "number" : "text"}
                      readOnly={f.ro}
                      value={String(frac2[f.key as keyof typeof frac2])}
                      onChange={e => setFrac2(p => ({ ...p, [f.key]: e.target.value }))} />
                  </div>
                ))}
              </div>
            </div>
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
                { k: "responsable", l: "RESPONSABLE", ph: "", dropdown: true },
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
                  {f.dropdown ? (
                    <select style={s.fieldInput}
                      value={String(nueva[f.k as keyof typeof nueva])}
                      onChange={e => setNueva(p => ({ ...p, [f.k]: e.target.value }))}>
                      <option value="">— sin asignar —</option>
                      {operadores.map(op => (
                        <option key={op.id} value={op.nombre || op.email}>
                          {op.nombre || op.email}{op.bodega_cedi ? ` · ${op.bodega_cedi}` : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input style={s.fieldInput} type={f.num ? "number" : "text"} placeholder={f.ph}
                      value={String(nueva[f.k as keyof typeof nueva])}
                      onChange={e => setNueva(p => ({ ...p, [f.k]: f.num ? Number(e.target.value) : e.target.value }))} />
                  )}
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
  root:             { padding: "28px 24px", fontFamily: "'Courier New', monospace", color: "#1e293b", minHeight: "100vh", background: "#f1f5f9", position: "relative" },
  flash:            { position: "fixed", top: 20, right: 24, background: "#f8fafc", border: "1px solid rgba(249,115,22,0.5)", color: "#f97316", padding: "10px 20px", borderRadius: 3, fontSize: 12, letterSpacing: 1, zIndex: 9999 },
  pageHeader:       { marginBottom: 20 },
  badge:            { display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", marginBottom: 10 },
  title:            { margin: "0 0 4px", fontSize: 22, fontWeight: 700, color: "#0f172a", letterSpacing: 1 },
  sub:              { margin: 0, fontSize: 11, color: "#9ca3af" },
  btnPrimary:       { background: "#f97316", border: "none", color: "#000", fontSize: 10, fontWeight: 700, letterSpacing: 2, padding: "9px 18px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  statsRow:         { display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" as const },
  statCard:         { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.3)", borderRadius: 3, padding: "10px 18px", flex: 1, minWidth: 90 },
  statLabel:        { fontSize: 9, letterSpacing: 2, color: "#64748b", marginTop: 3 },
  filters:          { display: "flex", gap: 5, marginBottom: 14, flexWrap: "wrap" as const, alignItems: "center" },
  filterBtn:        { border: "1px solid rgba(249,115,22,0.25)", fontSize: 9, letterSpacing: 1.5, padding: "5px 10px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", fontWeight: 600 },
  refreshBtn:       { background: "transparent", border: "1px solid rgba(249,115,22,0.3)", color: "#64748b", fontSize: 13, padding: "5px 10px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  loading:          { textAlign: "center" as const, color: "#64748b", padding: 40, fontSize: 12 },
  empty:            { textAlign: "center" as const, color: "#6b7280", padding: 40, fontSize: 12, border: "1px dashed rgba(249,115,22,0.12)", borderRadius: 3 },
  tableWrap:        { overflowX: "auto" as const, border: "1px solid rgba(249,115,22,0.3)", borderRadius: 3 },
  table:            { width: "100%", borderCollapse: "collapse" as const, fontSize: 11 },
  thead:            { borderBottom: "1px solid rgba(249,115,22,0.2)", background: "#ffffff" },
  th:               { padding: "8px 10px", textAlign: "left" as const, fontSize: 9, letterSpacing: 1.5, color: "#64748b", fontWeight: 700, whiteSpace: "nowrap" as const },
  tr:               { borderBottom: "1px solid rgba(249,115,22,0.06)" },
  td:               { padding: "7px 10px", verticalAlign: "middle" as const, whiteSpace: "nowrap" as const },
  ordenNum:         { color: "#f97316", fontWeight: 700, letterSpacing: 0.5, position: "relative" as const },
  fracTag:          { fontSize: 9, color: "#60a5fa", marginLeft: 4 },
  badge2:           { display: "inline-block", fontSize: 9, letterSpacing: 1, fontWeight: 700, padding: "2px 8px", borderRadius: 2 },
  // Inline responsable dropdown
  respSelect:       { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.4)", borderRadius: 2, color: "#1e293b", fontSize: 11, padding: "3px 5px", fontFamily: "'Courier New', monospace", minWidth: 140, outline: "none", cursor: "pointer" },
  btnSaveSmall:     { background: "transparent", border: "1px solid rgba(74,222,128,0.4)", color: "#4ade80", fontSize: 11, padding: "2px 6px", cursor: "pointer", borderRadius: 2 },
  btnCancelSmall:   { background: "transparent", border: "1px solid rgba(248,113,113,0.3)", color: "#f87171", fontSize: 11, padding: "2px 6px", cursor: "pointer", borderRadius: 2 },
  // Action buttons
  btnAprobarDirect: { background: "#166534", border: "1px solid #16a34a", color: "#4ade80", fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: "5px 10px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", whiteSpace: "nowrap" as const },
  btnAprobar:       { background: "transparent", border: "1px solid rgba(74,222,128,0.35)", color: "#4ade80", fontSize: 11, padding: "4px 7px", cursor: "pointer", borderRadius: 2 },
  btnRechazar:      { background: "transparent", border: "1px solid rgba(248,113,113,0.35)", color: "#f87171", fontSize: 10, padding: "4px 7px", cursor: "pointer", borderRadius: 2 },
  btnFraccionar:    { background: "transparent", border: "1px solid rgba(251,191,36,0.35)", color: "#fbbf24", fontSize: 10, padding: "4px 7px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  overlay:          { position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, overflowY: "auto" as const },
  modalBox:         { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.35)", borderRadius: 4, padding: "24px 28px", width: "100%", maxWidth: 460 },
  modalTitle:       { fontSize: 13, fontWeight: 700, letterSpacing: 2, marginBottom: 14, color: "#f97316" },
  modalInfo:        { fontSize: 12, marginBottom: 14, padding: "10px 14px", background: "#ffffff", borderRadius: 3, border: "1px solid rgba(249,115,22,0.25)" },
  fieldLabel:       { fontSize: 9, letterSpacing: 2, color: "#f97316", display: "block" as const, marginBottom: 5, fontWeight: 600 },
  textarea:         { width: "100%", background: "#f8fafc", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 2, color: "#1e293b", fontSize: 11, padding: "8px 10px", fontFamily: "'Courier New', monospace", resize: "vertical" as const, boxSizing: "border-box" as const, outline: "none" },
  modalBtn:         { border: "none", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "10px 16px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  modalBtnCancel:   { background: "transparent", border: "1px solid rgba(249,115,22,0.25)", color: "#64748b", fontSize: 10, letterSpacing: 1, padding: "10px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  fieldInput:       { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 2, color: "#1e293b", fontSize: 11, padding: "7px 9px", fontFamily: "'Courier New', monospace", width: "100%", boxSizing: "border-box" as const, outline: "none" },
  fracBox:          { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.3)", borderRadius: 3, padding: "14px" },
  fracTitle:        { fontSize: 9, letterSpacing: 2, color: "#fbbf24", fontWeight: 700, marginBottom: 12 },
};
