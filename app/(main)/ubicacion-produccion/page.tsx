"use client";

import { useRef, useState, useCallback } from "react";
import * as XLSX from "xlsx";
import { getBrowserClient } from "@/lib/supabase/browser";
import type { AssignedLine } from "@/app/api/plan-ubicacion/route";
import { crearLineas } from "@/app/actions/ordenes";

const db = getBrowserClient();

// ── Types ─────────────────────────────────────────────────────────────────────
interface LogLine { msg: string; cls: "" | "ok" | "err" | "warn"; }

// ── Column normalization ──────────────────────────────────────────────────────
const norm = (v: unknown) =>
  String(v).trim().toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// ── Main component ────────────────────────────────────────────────────────────
export default function UbicacionProduccionPage() {
  const fileRef   = useRef<HTMLInputElement>(null);
  const logRef    = useRef<HTMLDivElement>(null);

  const [loading,   setLoading]   = useState(false);
  const [progress,  setProgress]  = useState(0);
  const [progLabel, setProgLabel] = useState("");
  const [log,       setLog]       = useState<LogLine[]>([]);
  const [plan,      setPlan]      = useState<AssignedLine[]>([]);
  const [stats,     setStats]     = useState<{ total: number; asignados: number; sinEspacio: number; fragmentos: number } | null>(null);
  const [dragging,  setDragging]  = useState(false);
  const [flash,     setFlash]     = useState<{ msg: string; ok: boolean } | null>(null);
  const [creating,  setCreating]  = useState(false);
  const [editDest,  setEditDest]  = useState<Map<number, string>>(new Map());

  const addLog = useCallback((msg: string, cls: LogLine["cls"] = "") => {
    setLog(p => [...p, { msg, cls }]);
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, []);

  const showFlash = (msg: string, ok = true) => {
    setFlash({ msg, ok });
    setTimeout(() => setFlash(null), 4000);
  };

  // ── Excel parsing ─────────────────────────────────────────────────────────
  async function processFile(file: File) {
    setLoading(true);
    setProgress(0);
    setProgLabel("");
    setLog([]);
    setPlan([]);
    setStats(null);

    try {
      addLog(`📖 Leyendo "${file.name}"…`);
      setProgress(5);

      const buf = await file.arrayBuffer();
      const wb  = XLSX.read(buf, { type: "array" });
      addLog(`✓ Hojas: ${wb.SheetNames.join(", ")}`);

      // Find PRODUCCION sheet
      const sheetName =
        wb.SheetNames.find(n => n.toUpperCase().includes("PRODUCCION")) ??
        wb.SheetNames.find(n => n.toUpperCase().includes("PROD")) ??
        wb.SheetNames[0];
      const ws   = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
      addLog(`✓ Procesando hoja "${sheetName}" · ${rows.length} filas`);
      setProgress(10);

      // Detect header row
      let headerRow = -1;
      const col: Record<string, number> = {};

      for (let i = 0; i < Math.min(20, rows.length); i++) {
        const r = (rows[i] as unknown[]).map(norm);
        if (!r.some(c => c.includes("DESCRIP"))) continue;
        headerRow = i;
        r.forEach((c, idx) => {
          if      (c.includes("COD") && (c.includes("ORG") || (c.includes("INV") && c.length > 8))) col.cod_org_inv = col.cod_org_inv ?? idx;
          else if (c === "CODIGO" || (c.startsWith("COD") && c.length <= 6))                        col.codigo      = col.codigo ?? idx;
          else if (c.includes("DESCRIP"))                                                            col.descripcion = col.descripcion ?? idx;
          else if (c.includes("SUBIN") && c.includes("ORIG"))                                       col.subinventario_origen = col.subinventario_origen ?? idx;
          else if (c.includes("LOCAL") && c.includes("ORIG"))                                       col.localizador_origen = col.localizador_origen ?? idx;
          else if (c === "LOTE")                                                                     col.lote = col.lote ?? idx;
          else if ((c.includes("CAN") || c.includes("CANT")) && c.includes("FIS"))                  col.cantidad_fisica = col.cantidad_fisica ?? idx;
          else if (c === "PALLETS" || c === "TARIMAS" || c === "PLT" || c.startsWith("PALLET"))     col.pallets = col.pallets ?? idx;
          else if (c === "CAJAS")                                                                    col.cajas = col.cajas ?? idx;
          else if (c.includes("RESPON"))                                                             col.responsable = col.responsable ?? idx;
          else if (c === "CONTEO" || c.startsWith("CONTEO"))                                        col.conteo = col.conteo ?? idx;
        });
        break;
      }

      if (headerRow < 0) throw new Error("No se encontró fila de encabezados (DESCRIPCION + COD)");
      addLog(`✓ Encabezado en fila ${headerRow + 1} · ${Object.keys(col).length} cols mapeadas`);
      setProgress(18);

      const get = (r: unknown[], k: string) => (col[k] !== undefined ? r[col[k]] : "") ?? "";
      const items = [];
      for (let i = headerRow + 1; i < rows.length; i++) {
        const r    = rows[i] as unknown[];
        const desc = String(get(r, "descripcion")).trim();
        if (!desc || desc.toUpperCase().includes("NOTA")) continue;
        items.push({
          row_idx:              i,
          cod_org_inv:          String(get(r, "cod_org_inv")).trim(),
          codigo:               String(get(r, "codigo")).trim(),
          descripcion:          desc,
          subinventario_origen: String(get(r, "subinventario_origen")).trim() || "PRODUCCION",
          localizador_origen:   String(get(r, "localizador_origen")).trim(),
          lote:                 String(get(r, "lote")).trim(),
          cantidad_fisica:      parseFloat(String(get(r, "cantidad_fisica")).replace(",", ".")) || 0,
          pallets:              parseInt(String(get(r, "pallets"))) || 0,
          cajas:                parseInt(String(get(r, "cajas"))) || 0,
          responsable:          String(get(r, "responsable")).trim(),
          conteo:               col.conteo !== undefined ? (parseInt(String(get(r, "conteo"))) || null) : null,
        });
      }

      if (!items.length) throw new Error("No se encontraron filas con datos");
      addLog(`✓ ${items.length} líneas de producción leídas`);
      setProgress(25);

      // Load warehouse map from Supabase
      addLog("⟳ Cargando mapa de localizadores desde BD…");
      const { data: locs, error: locErr } = await db
        .from("localizadores")
        .select("zona,localizador,formato,capacidad,ocupado,disponible")
        .eq("activo", true);
      if (locErr) throw new Error("BD localizadores: " + locErr.message);
      addLog(`✓ ${(locs ?? []).length} localizadores cargados`);
      setProgress(40);

      // Call planning API
      addLog("⟳ Ejecutando algoritmo de ubicación (greedy + consolidación de lote)…");
      const resp = await fetch("/api/plan-ubicacion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, locations: locs ?? [] }),
      });
      const result = await resp.json();
      if (!result.ok) throw new Error("Plan: " + result.error);

      const p: AssignedLine[] = result.plan;
      const s = result.stats;
      setPlan(p);
      setStats(s);
      setProgress(100);
      setProgLabel(`✅ Plan generado: ${s.asignados} asignadas · ${s.sinEspacio} sin espacio · ${s.fragmentos} fragmentos`);
      addLog(`✅ Plan listo: ${s.asignados}/${s.total} líneas asignadas`, "ok");
      if (s.sinEspacio > 0) addLog(`⚠ ${s.sinEspacio} líneas sin espacio disponible`, "warn");
      if (s.fragmentos > 0) addLog(`⚠ ${s.fragmentos} líneas fragmentadas (lote dividido entre 2+ localizadores)`, "warn");

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog("❌ " + msg, "err");
      setProgLabel("❌ Error al procesar");
    } finally {
      setLoading(false);
    }
  }

  // ── Create orders (insert into lineas_reubicacion) ────────────────────────
  async function crearOrdenes() {
    const toCreate = plan.filter(l => !l.sin_espacio && l.localizador_destino !== "SIN PALLETS");
    if (!toCreate.length) { showFlash("⚠ No hay líneas para crear", false); return; }
    setCreating(true);
    const res = await crearLineas(toCreate.map(l => ({
      cod_org_inv:            l.cod_org_inv || undefined,
      codigo:                 l.codigo || undefined,
      descripcion:            l.descripcion,
      subinventario_origen:   l.subinventario_origen || undefined,
      localizador_origen:     l.localizador_origen || undefined,
      lote:                   l.lote || undefined,
      cantidad_fisica:        l.cantidad_fisica,
      pallets:                l.pallets_efectivos,
      cajas:                  l.cajas,
      subinventario_destino:  l.subinventario_destino || undefined,
      localizador_destino:    (editDest.get(l.row_idx) ?? l.localizador_destino) || undefined,
      responsable:            l.responsable || undefined,
      inv_pe:                 l.inv_pe,
      notas:                  l.is_fragment ? "Fragmento de lote" : undefined,
    })));
    setCreating(false);
    if (res?.error) showFlash(`❌ Error: ${res.error}`, false);
    else showFlash(`✓ ${toCreate.length} órdenes creadas → Órdenes de Producción`);
  }

  // ── Export to Excel ───────────────────────────────────────────────────────
  function exportExcel() {
    const rows = plan.map(l => ({
      "Cod. Org Inv":           l.cod_org_inv,
      "Código":                 l.codigo,
      "Descripción":            l.descripcion,
      "SI Origen":              l.subinventario_origen,
      "Loc Origen":             l.localizador_origen,
      "Lote":                   l.lote,
      "Can Física":             l.cantidad_fisica,
      "Pallets":                l.pallets,
      "Cajas":                  l.cajas,
      "Pallets Efectivos":      l.pallets_efectivos,
      "SI Destino":             l.subinventario_destino,
      "Loc Destino":            editDest.get(l.row_idx) ?? l.localizador_destino,
      "Responsable":            l.responsable,
      "INV-PE":                 l.inv_pe,
      "Conteo":                 l.conteo ?? "",
      "Estado":                 l.sin_espacio ? "SIN ESPACIO" : l.is_fragment ? "FRAGMENTO" : "OK",
    }));
    const ws  = XLSX.utils.json_to_sheet(rows);
    const wb  = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Plan Ubicación");
    XLSX.writeFile(wb, `plan_ubicacion_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={s.root} className="page-root">
      {flash && (
        <div style={{ ...s.flash, borderColor: flash.ok ? "rgba(74,222,128,0.5)" : "rgba(248,113,113,0.5)", color: flash.ok ? "#4ade80" : "#f87171" }}>
          {flash.msg}
        </div>
      )}

      {/* Header */}
      <div style={s.pageHeader}>
        <div style={s.badge}>PLANIFICACIÓN — PRODUCCIÓN · REUBICACIÓN</div>
        <h1 style={s.title}>Ubicación de Producción</h1>
        <p style={s.sub}>Sube el Excel de PRODUCCION · El sistema calcula la ubicación óptima para cada línea</p>
      </div>

      {/* Nota operativa */}
      <div style={s.noteBox}>
        <span style={s.noteIcon}>📋</span>
        <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.7 }}>
          <strong style={{ color: "#fbbf24" }}>INSTRUCCIÓN OPERATIVA:</strong>{" "}
          Respetar las líneas y dejar la etiqueta al lado más ancho del localizador con la altura y condiciones propias de almacenamiento.{" "}
          <strong style={{ color: "#f87171" }}>Limpiar las áreas de donde se mueve el producto — NO se puede dejar basura en las mismas.</strong>
        </div>
      </div>

      {/* Upload zone */}
      <div
        style={{
          ...s.dropZone,
          borderColor: dragging ? "#f97316" : "rgba(249,115,22,0.25)",
          background: dragging ? "rgba(249,115,22,0.04)" : "transparent",
          marginBottom: 20,
        }}
        onClick={() => !loading && fileRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) processFile(f); }}
      >
        <span style={{ fontSize: 36 }}>📂</span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>Arrastra el Excel de Producción aquí</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
            Hoja con nombre <code style={{ color: "#f97316" }}>PRODUCCION</code> · Columnas: Código, Descripción, Lote, Pallets, Cajas, etc.
          </div>
        </div>
        <button
          style={{ ...s.btnUpload, opacity: loading ? 0.6 : 1 }}
          disabled={loading}
          onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}
        >
          {loading ? "Procesando…" : "SELECCIONAR EXCEL →"}
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
          onChange={e => { const f = e.target.files?.[0]; if (f) { processFile(f); e.target.value = ""; } }} />
      </div>

      {/* Progress */}
      {(loading || progLabel) && (
        <div style={{ marginBottom: 16 }}>
          <div style={s.progressTrack}>
            <div style={{ ...s.progressBar, width: `${progress}%`, background: loading ? "#f97316" : "#22c55e" }} />
          </div>
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 5 }}>{progLabel || "Procesando…"}</div>
        </div>
      )}

      {/* Log */}
      {log.length > 0 && (
        <div ref={logRef} style={s.logBox}>
          {log.map((l, i) => (
            <div key={i} style={{ ...s.logLine, color: l.cls === "ok" ? "#4ade80" : l.cls === "err" ? "#f87171" : l.cls === "warn" ? "#fbbf24" : "#9ca3af" }}>
              {l.msg}
            </div>
          ))}
        </div>
      )}

      {/* Stats + action buttons */}
      {stats && plan.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" as const, alignItems: "center" }}>
          {[
            { l: "TOTAL LÍNEAS", v: stats.total, c: "#e2e8f0" },
            { l: "ASIGNADAS", v: stats.asignados, c: "#4ade80" },
            { l: "SIN ESPACIO", v: stats.sinEspacio, c: "#f87171" },
            { l: "FRAGMENTADAS", v: stats.fragmentos, c: "#fbbf24" },
          ].map(st => (
            <div key={st.l} style={s.statChip}>
              <span style={{ fontSize: 18, fontWeight: 700, color: st.c }}>{st.v}</span>
              <span style={{ fontSize: 9, letterSpacing: 1.5, color: "#374151" }}>{st.l}</span>
            </div>
          ))}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button style={s.btnExport} onClick={exportExcel}>⬇ Exportar Excel</button>
            <button
              style={{ ...s.btnCreate, opacity: creating ? 0.6 : 1 }}
              onClick={crearOrdenes}
              disabled={creating}
            >
              {creating ? "Creando…" : `✓ CREAR ${plan.filter(l => !l.sin_espacio && l.localizador_destino !== "SIN PALLETS").length} ÓRDENES →`}
            </button>
          </div>
        </div>
      )}

      {/* Plan table */}
      {plan.length > 0 && (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr style={s.thead}>
                {["ORD.#", "COD.ORG", "CÓDIGO", "DESCRIPCIÓN", "SI ORIGEN", "LOC ORIGEN", "LOTE", "CAN.FÍS.", "PLT", "CAJAS", "PLT.EFEC.", "SI DESTINO", "LOC DESTINO", "RESPONSABLE", "INV-PE", "CONTEO", "EST."].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plan.map((l, i) => {
                const destOverride = editDest.get(l.row_idx);
                const destVal = destOverride ?? l.localizador_destino;
                const rowBg = l.sin_espacio
                  ? "rgba(248,113,113,0.06)"
                  : l.is_fragment
                  ? "rgba(251,191,36,0.04)"
                  : i % 2 === 0 ? "transparent" : "#0d1117";
                const statusColor = l.sin_espacio ? "#f87171" : l.is_fragment ? "#fbbf24" : "#4ade80";
                const statusLabel = l.sin_espacio ? "SIN ESP." : l.is_fragment ? "FRAG." : "OK";

                return (
                  <tr key={`${l.row_idx}-${i}`} style={{ ...s.tr, background: rowBg }}>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 10 }}>{l.row_idx}</td>
                    <td style={{ ...s.td, color: "#6b7280" }}>{l.cod_org_inv || "—"}</td>
                    <td style={{ ...s.td, color: "#f97316", fontWeight: 700 }}>{l.codigo || "—"}</td>
                    <td style={{ ...s.td, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{l.descripcion}</td>
                    <td style={{ ...s.td, color: "#6b7280", fontSize: 10 }}>{l.subinventario_origen || "—"}</td>
                    <td style={{ ...s.td, color: "#64748b", fontFamily: "monospace" }}>{l.localizador_origen || "—"}</td>
                    <td style={{ ...s.td, color: "#64748b", fontFamily: "monospace", fontSize: 11 }}>{l.lote || "—"}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#6b7280" }}>{l.cantidad_fisica.toFixed(2)}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, fontWeight: 700, color: "#fbbf24" }}>{l.pallets}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#9ca3af" }}>{l.cajas}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, fontWeight: 700, color: "#60a5fa" }}>{l.pallets_efectivos}</td>
                    {/* SI Destino */}
                    <td style={{ ...s.td, color: l.sin_espacio ? "#f87171" : "#4ade80", fontWeight: 600 }}>
                      {l.subinventario_destino || "—"}
                    </td>
                    {/* Loc Destino — inline editable */}
                    <td style={s.td}>
                      <input
                        style={{
                          ...s.destInput,
                          borderColor: destOverride ? "#f97316" : l.sin_espacio ? "rgba(248,113,113,0.4)" : "rgba(74,222,128,0.25)",
                          color: l.sin_espacio ? "#f87171" : "#4ade80",
                        }}
                        value={destVal}
                        onChange={e => {
                          const map = new Map(editDest);
                          map.set(l.row_idx, e.target.value);
                          setEditDest(map);
                        }}
                        title="Editable — cambia la ubicación destino si necesitas ajustar"
                      />
                    </td>
                    <td style={{ ...s.td, color: "#6b7280", fontSize: 11 }}>{l.responsable || "—"}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, fontWeight: 700, color: "#1e293b" }}>{l.inv_pe || "—"}</td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#374151" }}>{l.conteo ?? "—"}</td>
                    <td style={s.td}>
                      <span style={{ ...s.badge2, background: l.sin_espacio ? "#2a0f0f" : l.is_fragment ? "#292010" : "#0f2a0f", color: statusColor }}>
                        {statusLabel}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!plan.length && !loading && !progLabel && (
        <div style={s.empty}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 13, color: "#64748b" }}>Sube el Excel de Producción para ver el plan de ubicación</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8, maxWidth: 440, textAlign: "center" as const }}>
            El algoritmo agrupa por código + lote, prioriza localizadores con formato compatible y mantiene la consistencia de zona por producto.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s: { [k: string]: React.CSSProperties } = {
  root:         { padding: "28px 24px", fontFamily: "'Courier New', monospace", color: "#1e293b", minHeight: "100vh", background: "#f1f5f9", position: "relative" },
  flash:        { position: "fixed", top: 20, right: 24, background: "#ffffff", border: "1px solid", padding: "10px 20px", borderRadius: 3, fontSize: 12, letterSpacing: 1, zIndex: 9999 },
  pageHeader:   { marginBottom: 14 },
  badge:        { display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", marginBottom: 10 },
  title:        { margin: "0 0 4px", fontSize: 22, fontWeight: 700, color: "#0f172a", letterSpacing: 1 },
  sub:          { margin: 0, fontSize: 11, color: "#64748b" },
  noteBox:      { display: "flex", gap: 12, alignItems: "flex-start", background: "#ffffff", border: "1px solid rgba(251,191,36,0.2)", borderRadius: 3, padding: "10px 14px", marginBottom: 16 },
  noteIcon:     { fontSize: 16, flexShrink: 0, marginTop: 1 },
  dropZone:     { border: "2px dashed", borderRadius: 4, padding: "28px 24px", display: "flex", flexWrap: "wrap" as const, alignItems: "center", gap: 16, cursor: "pointer", transition: "all 0.2s" },
  btnUpload:    { background: "#f97316", border: "none", color: "#000", fontSize: 11, fontWeight: 700, letterSpacing: 2, padding: "10px 20px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", whiteSpace: "nowrap" as const },
  progressTrack:{ height: 5, background: "#1e2235", borderRadius: 3, overflow: "hidden" },
  progressBar:  { height: "100%", borderRadius: 3, transition: "width 0.3s" },
  logBox:       { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 3, padding: "10px 14px", fontSize: 11, maxHeight: 150, overflowY: "auto" as const, fontFamily: "monospace", marginBottom: 14 },
  logLine:      { lineHeight: 1.6, whiteSpace: "pre-wrap" as const, marginBottom: 2 },
  statChip:     { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 3, padding: "8px 16px", display: "flex", flexDirection: "column" as const, gap: 2, alignItems: "center", minWidth: 90 },
  btnExport:    { background: "transparent", border: "1px solid rgba(96,165,250,0.3)", color: "#60a5fa", fontSize: 10, letterSpacing: 1.5, padding: "8px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", fontWeight: 600 },
  btnCreate:    { background: "#16a34a", border: "none", color: "#fff", fontSize: 10, letterSpacing: 1.5, padding: "8px 16px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", fontWeight: 700 },
  tableWrap:    { overflowX: "auto" as const, border: "1px solid rgba(249,115,22,0.25)", borderRadius: 3 },
  table:        { width: "100%", borderCollapse: "collapse" as const, fontSize: 11 },
  thead:        { borderBottom: "1px solid rgba(249,115,22,0.15)", background: "#f8fafc" },
  th:           { padding: "6px 8px", textAlign: "left" as const, fontSize: 9, letterSpacing: 1.5, color: "#94a3b8", fontWeight: 700, whiteSpace: "nowrap" as const },
  tr:           { borderBottom: "1px solid rgba(249,115,22,0.04)" },
  td:           { padding: "6px 8px", verticalAlign: "middle" as const, whiteSpace: "nowrap" as const },
  destInput:    { background: "#f8fafc", border: "1px solid", borderRadius: 2, color: "#4ade80", fontSize: 11, padding: "3px 6px", fontFamily: "'Courier New', monospace", width: 120, outline: "none" },
  badge2:       { display: "inline-block", fontSize: 9, letterSpacing: 1, fontWeight: 700, padding: "2px 7px", borderRadius: 2 },
  empty:        { textAlign: "center" as const, color: "#94a3b8", padding: "60px 20px", border: "1px dashed rgba(249,115,22,0.1)", borderRadius: 4, display: "flex", flexDirection: "column" as const, alignItems: "center" },
};
