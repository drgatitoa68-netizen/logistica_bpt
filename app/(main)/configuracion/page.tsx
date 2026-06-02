"use client";

import { useEffect, useState, useCallback } from "react";
import { getBrowserClient } from "@/lib/supabase/browser";

const db = getBrowserClient();

interface Localizador {
  zona: string;
  localizador: string;
  formato: string;
  capacidad: number;
  ocupado: number;
  disponible: number;
  pct_ocupacion: number;
  activo: boolean;
}

type SortKey = keyof Localizador;
type EditField = "capacidad" | "formato" | "activo";

interface EditState {
  localizador: string;
  zona: string;
  field: EditField;
  value: string | number | boolean;
}

export default function ConfiguracionPage() {
  const [rows, setRows] = useState<Localizador[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<{ msg: string; ok: boolean } | null>(null);
  const [search, setSearch] = useState("");
  const [filterZona, setFilterZona] = useState("all");
  const [filterActivo, setFilterActivo] = useState<"all" | "activo" | "bloqueado">("all");
  const [sortBy, setSortBy] = useState<SortKey>("zona");
  const [sortAsc, setSortAsc] = useState(true);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [bulkZona, setBulkZona] = useState("");
  const [bulkActivo, setBulkActivo] = useState<boolean | null>(null);
  const [bulkCapacidad, setBulkCapacidad] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await db
      .from("localizadores")
      .select("zona,localizador,formato,capacidad,ocupado,disponible,pct_ocupacion,activo")
      .order("zona")
      .order("localizador");
    if (!error && data) setRows(data as Localizador[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const showFlash = (msg: string, ok = true) => {
    setFlash({ msg, ok });
    setTimeout(() => setFlash(null), 3500);
  };

  const zonas = [...new Set(rows.map(r => r.zona))].sort();

  const filtered = rows
    .filter(r => {
      if (filterZona !== "all" && r.zona !== filterZona) return false;
      if (filterActivo === "activo" && !r.activo) return false;
      if (filterActivo === "bloqueado" && r.activo) return false;
      if (search && !r.localizador.toUpperCase().includes(search.toUpperCase()) && !r.zona.toUpperCase().includes(search.toUpperCase())) return false;
      return true;
    })
    .sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      const cmp = typeof av === "string" ? av.localeCompare(String(bv)) : Number(av) - Number(bv);
      return sortAsc ? cmp : -cmp;
    });

  const key = (r: Localizador) => `${r.zona}::${r.localizador}`;

  function toggleSort(col: SortKey) {
    if (sortBy === col) setSortAsc(p => !p);
    else { setSortBy(col); setSortAsc(true); }
  }

  function toggleSelect(r: Localizador) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key(r))) next.delete(key(r));
      else next.add(key(r));
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(key)));
    }
  }

  async function saveEdit() {
    if (!edit) return;
    setSaving(true);
    const { error } = await db
      .from("localizadores")
      .update({ [edit.field]: edit.value })
      .eq("zona", edit.zona)
      .eq("localizador", edit.localizador);
    setSaving(false);
    if (error) { showFlash("❌ " + error.message, false); return; }
    showFlash(`✓ ${edit.localizador} — ${edit.field} actualizado`);
    setEdit(null);
    load();
  }

  async function toggleBlock(r: Localizador) {
    setSaving(true);
    const { error } = await db
      .from("localizadores")
      .update({ activo: !r.activo })
      .eq("zona", r.zona)
      .eq("localizador", r.localizador);
    setSaving(false);
    if (error) { showFlash("❌ " + error.message, false); return; }
    showFlash(`✓ ${r.localizador} ${r.activo ? "bloqueado" : "desbloqueado"}`);
    load();
  }

  async function applyBulk() {
    const targets = filtered.filter(r => selected.has(key(r)));
    if (!targets.length) { showFlash("⚠ Selecciona al menos una fila", false); return; }
    const updates: Partial<Localizador> = {};
    if (bulkActivo !== null) updates.activo = bulkActivo;
    if (bulkCapacidad !== "") updates.capacidad = Number(bulkCapacidad);
    if (!Object.keys(updates).length) { showFlash("⚠ Define al menos un cambio", false); return; }

    setSaving(true);
    let errCount = 0;
    for (const r of targets) {
      const { error } = await db
        .from("localizadores")
        .update(updates)
        .eq("zona", r.zona)
        .eq("localizador", r.localizador);
      if (error) errCount++;
    }
    setSaving(false);
    if (errCount > 0) showFlash(`⚠ ${errCount} errores al actualizar`, false);
    else showFlash(`✓ ${targets.length} ubicaciones actualizadas`);
    setSelected(new Set());
    setBulkActivo(null);
    setBulkCapacidad("");
    setShowBulk(false);
    load();
  }

  const stats = {
    total: rows.length,
    activas: rows.filter(r => r.activo).length,
    bloqueadas: rows.filter(r => !r.activo).length,
    conStock: rows.filter(r => r.ocupado > 0).length,
    libres: rows.reduce((s, r) => s + Math.max(0, r.disponible || 0), 0),
  };

  return (
    <div style={s.root}>
      {flash && (
        <div style={{ ...s.flash, borderColor: flash.ok ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)", color: flash.ok ? "#4ade80" : "#f87171" }}>
          {flash.msg}
        </div>
      )}

      <div style={s.pageHeader}>
        <div style={s.badge}>CONFIGURACIÓN — LOCALIZADORES</div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 12 }}>
          <div>
            <h1 style={s.title}>Gestión de Ubicaciones</h1>
            <p style={s.sub}>Modifica capacidad, formato, o bloquea ubicaciones para que no aparezcan en el mapa</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {selected.size > 0 && (
              <button style={s.btnBulk} onClick={() => setShowBulk(true)}>
                ✎ Editar {selected.size} seleccionadas
              </button>
            )}
            <button style={s.btnRefresh} onClick={load}>↻ Recargar</button>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div style={s.statsRow}>
        {[
          { l: "TOTAL", v: stats.total, c: "#e2e8f0" },
          { l: "ACTIVAS", v: stats.activas, c: "#4ade80" },
          { l: "BLOQUEADAS", v: stats.bloqueadas, c: "#f87171" },
          { l: "CON STOCK", v: stats.conStock, c: "#fbbf24" },
          { l: "PALLETS LIBRES", v: stats.libres, c: "#60a5fa" },
        ].map(st => (
          <div key={st.l} style={s.statCard}>
            <div style={{ fontSize: 22, fontWeight: 700, color: st.c }}>{st.v}</div>
            <div style={s.statLabel}>{st.l}</div>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div style={s.filters}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar localizador…"
          style={s.searchInput}
        />
        <select value={filterZona} onChange={e => setFilterZona(e.target.value)} style={s.select}>
          <option value="all">Todas las zonas</option>
          {zonas.map(z => <option key={z} value={z}>{z}</option>)}
        </select>
        <select value={filterActivo} onChange={e => setFilterActivo(e.target.value as typeof filterActivo)} style={s.select}>
          <option value="all">Activas + Bloqueadas</option>
          <option value="activo">Solo activas</option>
          <option value="bloqueado">Solo bloqueadas</option>
        </select>
        <span style={{ fontSize: 11, color: "#4a5568", marginLeft: "auto" }}>
          {filtered.length} / {rows.length} ubicaciones
        </span>
      </div>

      {/* Tabla */}
      {loading ? (
        <div style={s.loading}>Cargando ubicaciones…</div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr style={s.thead}>
                <th style={{ ...s.th, width: 32 }}>
                  <input
                    type="checkbox"
                    checked={selected.size === filtered.length && filtered.length > 0}
                    onChange={toggleSelectAll}
                    style={{ cursor: "pointer" }}
                  />
                </th>
                {(["zona", "localizador", "formato", "capacidad", "ocupado", "disponible", "pct_ocupacion"] as SortKey[]).map(col => (
                  <th key={col} style={{ ...s.th, cursor: "pointer" }} onClick={() => toggleSort(col)}>
                    {col.replace("_", " ").toUpperCase()}{" "}
                    {sortBy === col ? (sortAsc ? "↑" : "↓") : ""}
                  </th>
                ))}
                <th style={s.th}>ESTADO</th>
                <th style={s.th}>ACCIONES</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const isSelected = selected.has(key(r));
                const pct = (r.pct_ocupacion * 100).toFixed(1);
                const pctColor = r.pct_ocupacion > 1.0 ? "#f87171" : r.pct_ocupacion >= 0.8 ? "#fbbf24" : r.pct_ocupacion > 0 ? "#4ade80" : "#374151";
                return (
                  <tr key={key(r)} style={{ ...s.tr, background: isSelected ? "rgba(37,99,235,0.08)" : (i % 2 === 0 ? "transparent" : "#0d1117"), opacity: r.activo ? 1 : 0.5 }}>
                    <td style={s.td}>
                      <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(r)} style={{ cursor: "pointer" }} />
                    </td>
                    <td style={{ ...s.td, color: "#6b7280" }}>{r.zona}</td>
                    <td style={{ ...s.td, color: "#f97316", fontWeight: 700 }}>{r.localizador}</td>

                    {/* Formato editable */}
                    <td style={s.td}>
                      {edit?.localizador === r.localizador && edit.zona === r.zona && edit.field === "formato" ? (
                        <div style={{ display: "flex", gap: 4 }}>
                          <input
                            style={s.inlineInput}
                            value={String(edit.value)}
                            onChange={e => setEdit(p => p ? { ...p, value: e.target.value } : p)}
                            autoFocus
                          />
                          <button style={s.btnSave} onClick={saveEdit} disabled={saving}>✓</button>
                          <button style={s.btnCancel} onClick={() => setEdit(null)}>✗</button>
                        </div>
                      ) : (
                        <span
                          style={{ color: "#9ca3af", cursor: "pointer", borderBottom: "1px dashed rgba(249,115,22,0.3)" }}
                          onClick={() => setEdit({ localizador: r.localizador, zona: r.zona, field: "formato", value: r.formato || "" })}
                          title="Click para editar"
                        >
                          {r.formato || "—"}
                        </span>
                      )}
                    </td>

                    {/* Capacidad editable */}
                    <td style={{ ...s.td, textAlign: "right" as const }}>
                      {edit?.localizador === r.localizador && edit.zona === r.zona && edit.field === "capacidad" ? (
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                          <input
                            style={{ ...s.inlineInput, width: 70, textAlign: "right" as const }}
                            type="number"
                            value={String(edit.value)}
                            onChange={e => setEdit(p => p ? { ...p, value: Number(e.target.value) } : p)}
                            autoFocus
                          />
                          <button style={s.btnSave} onClick={saveEdit} disabled={saving}>✓</button>
                          <button style={s.btnCancel} onClick={() => setEdit(null)}>✗</button>
                        </div>
                      ) : (
                        <span
                          style={{ color: "#e2e8f0", cursor: "pointer", borderBottom: "1px dashed rgba(249,115,22,0.3)", fontWeight: 700 }}
                          onClick={() => setEdit({ localizador: r.localizador, zona: r.zona, field: "capacidad", value: r.capacidad })}
                          title="Click para editar"
                        >
                          {r.capacidad}
                        </span>
                      )}
                    </td>

                    <td style={{ ...s.td, textAlign: "right" as const, color: r.ocupado > 0 ? "#fbbf24" : "#374151" }}>{r.ocupado}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: r.disponible > 0 ? "#4ade80" : "#f87171" }}>{r.disponible}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: pctColor, fontWeight: 700 }}>{pct}%</td>

                    <td style={s.td}>
                      <span style={{
                        display: "inline-block",
                        fontSize: 9, letterSpacing: 1, fontWeight: 700, padding: "2px 8px", borderRadius: 2,
                        background: r.activo ? "#0f2a0f" : "#2a0f0f",
                        color: r.activo ? "#4ade80" : "#f87171",
                      }}>
                        {r.activo ? "ACTIVA" : "BLOQUEADA"}
                      </span>
                    </td>

                    <td style={s.td}>
                      <button
                        style={{ ...s.actionBtn, borderColor: r.activo ? "rgba(248,113,113,0.4)" : "rgba(74,222,128,0.4)", color: r.activo ? "#f87171" : "#4ade80" }}
                        onClick={() => toggleBlock(r)}
                        disabled={saving}
                        title={r.activo ? "Bloquear ubicación" : "Desbloquear ubicación"}
                      >
                        {r.activo ? "🔒 Bloquear" : "🔓 Activar"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div style={s.empty}>No hay ubicaciones con los filtros actuales</div>
          )}
        </div>
      )}

      {/* Modal edición masiva */}
      {showBulk && (
        <div style={s.overlay} onClick={() => setShowBulk(false)}>
          <div style={s.modalBox} onClick={e => e.stopPropagation()}>
            <div style={s.modalTitle}>✎ EDICIÓN MASIVA — {selected.size} UBICACIONES</div>
            <p style={{ fontSize: 11, color: "#4a5568", margin: "0 0 16px" }}>
              Solo los campos que completes serán actualizados. Deja vacío lo que no quieras cambiar.
            </p>

            <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>
              <div>
                <label style={s.fieldLabel}>ESTADO</label>
                <div style={{ display: "flex", gap: 8 }}>
                  {[
                    { v: null, l: "Sin cambio" },
                    { v: true, l: "Activar todas" },
                    { v: false, l: "Bloquear todas" },
                  ].map(opt => (
                    <button
                      key={String(opt.v)}
                      style={{
                        ...s.toggleOpt,
                        background: bulkActivo === opt.v ? "#f97316" : "transparent",
                        color: bulkActivo === opt.v ? "#000" : "#6b7280",
                      }}
                      onClick={() => setBulkActivo(opt.v)}
                    >
                      {opt.l}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label style={s.fieldLabel}>CAPACIDAD (dejar vacío = sin cambio)</label>
                <input
                  style={s.fieldInput}
                  type="number"
                  placeholder="Ej: 20"
                  value={bulkCapacidad}
                  onChange={e => setBulkCapacidad(e.target.value)}
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button
                style={{ ...s.modalBtn, background: "#c2410c", color: "#fff", opacity: saving ? 0.6 : 1 }}
                onClick={applyBulk}
                disabled={saving}
              >
                {saving ? "Aplicando…" : `APLICAR A ${selected.size} UBICACIONES →`}
              </button>
              <button style={s.modalBtnCancel} onClick={() => setShowBulk(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const s: { [k: string]: React.CSSProperties } = {
  root: { padding: "28px 24px", fontFamily: "'Courier New', monospace", color: "#e2e8f0", minHeight: "100vh", background: "#0a0e17", position: "relative" },
  flash: { position: "fixed", top: 20, right: 24, background: "#0d1117", border: "1px solid", padding: "10px 20px", borderRadius: 3, fontSize: 12, letterSpacing: 1, zIndex: 9999 },
  pageHeader: { marginBottom: 20 },
  badge: { display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", marginBottom: 10 },
  title: { margin: "0 0 4px", fontSize: 22, fontWeight: 700, color: "#fff", letterSpacing: 1 },
  sub: { margin: 0, fontSize: 11, color: "#4a5568" },
  btnBulk: { background: "#1d4ed8", border: "none", color: "#fff", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "8px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  btnRefresh: { background: "transparent", border: "1px solid rgba(249,115,22,0.2)", color: "#4a5568", fontSize: 11, padding: "8px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  statsRow: { display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" as const },
  statCard: { background: "#0d1117", border: "1px solid rgba(249,115,22,0.1)", borderRadius: 3, padding: "10px 18px", flex: 1, minWidth: 100 },
  statLabel: { fontSize: 9, letterSpacing: 2, color: "#374151", marginTop: 3 },
  filters: { display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" as const, alignItems: "center" },
  searchInput: { background: "#0d1117", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 2, color: "#e2e8f0", fontSize: 11, padding: "7px 10px", fontFamily: "'Courier New', monospace", outline: "none", minWidth: 180 },
  select: { background: "#0d1117", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 2, color: "#e2e8f0", fontSize: 11, padding: "7px 10px", fontFamily: "'Courier New', monospace", outline: "none" },
  loading: { textAlign: "center" as const, color: "#4a5568", padding: 40, fontSize: 12 },
  tableWrap: { overflowX: "auto" as const, border: "1px solid rgba(249,115,22,0.1)", borderRadius: 3 },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 11 },
  thead: { borderBottom: "1px solid rgba(249,115,22,0.15)", background: "#080c14" },
  th: { padding: "7px 10px", textAlign: "left" as const, fontSize: 9, letterSpacing: 1.5, color: "#374151", fontWeight: 700, whiteSpace: "nowrap" as const, userSelect: "none" as const },
  tr: { borderBottom: "1px solid rgba(249,115,22,0.04)" },
  td: { padding: "7px 10px", verticalAlign: "middle" as const, whiteSpace: "nowrap" as const },
  inlineInput: { background: "#0a0e17", border: "1px solid rgba(249,115,22,0.4)", borderRadius: 2, color: "#e2e8f0", fontSize: 11, padding: "4px 7px", fontFamily: "'Courier New', monospace", outline: "none", width: 120 },
  btnSave: { background: "transparent", border: "1px solid rgba(74,222,128,0.4)", color: "#4ade80", fontSize: 11, padding: "4px 8px", cursor: "pointer", borderRadius: 2 },
  btnCancel: { background: "transparent", border: "1px solid rgba(248,113,113,0.4)", color: "#f87171", fontSize: 11, padding: "4px 8px", cursor: "pointer", borderRadius: 2 },
  actionBtn: { background: "transparent", border: "1px solid", fontSize: 10, padding: "4px 8px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", letterSpacing: 0.5 },
  empty: { textAlign: "center" as const, color: "#374151", padding: 40, fontSize: 12 },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
  modalBox: { background: "#0d1117", border: "1px solid rgba(249,115,22,0.3)", borderRadius: 4, padding: "24px 28px", width: "100%", maxWidth: 480 },
  modalTitle: { fontSize: 13, fontWeight: 700, letterSpacing: 2, marginBottom: 14, color: "#f97316" },
  fieldLabel: { fontSize: 9, letterSpacing: 2, color: "#f97316", display: "block" as const, marginBottom: 6, fontWeight: 600 },
  fieldInput: { background: "#0a0e17", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 2, color: "#e2e8f0", fontSize: 11, padding: "7px 9px", fontFamily: "'Courier New', monospace", width: "100%", boxSizing: "border-box" as const, outline: "none" },
  toggleOpt: { border: "1px solid rgba(249,115,22,0.3)", fontSize: 10, letterSpacing: 1, padding: "5px 10px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  modalBtn: { border: "none", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "10px 16px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  modalBtnCancel: { background: "transparent", border: "1px solid rgba(249,115,22,0.2)", color: "#6b7280", fontSize: 10, letterSpacing: 1, padding: "10px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
};
