"use client";

import { useRef, useState, useCallback } from "react";
import * as XLSX from "xlsx";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/browser";

const db = getBrowserClient();

const CAL_LOC_HEADER_ROW = 7;
const CAL_LOC_COL = { ZONA: 1, LOC: 2, FORMATO: 3, CAPACIDAD: 10, OCUPADO: 14, DISPONIBLE: 17, PCT: 18 };

type LogEntry = { msg: string; cls: string };
type UploadResult = { type: "mapa" | "stock" | "produccion"; count: number; at: string } | null;

export default function SubirArchivoPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [result, setResult] = useState<UploadResult>(null);

  const addLog = useCallback((msg: string, cls = "") => {
    setLog(p => [...p, { msg, cls }]);
  }, []);

  async function processFile(file: File) {
    setImporting(true);
    setProgress(0);
    setProgressLabel("");
    setLog([]);
    setResult(null);

    try {
      addLog(`📖 Leyendo "${file.name}"…`);
      setProgress(5);

      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      addLog(`✓ Hojas: ${wb.SheetNames.join(", ")}`);

      if (wb.SheetNames.includes("CAL_LOC")) {
        await processMapa(wb);
      } else if (wb.SheetNames.some(n => n.toUpperCase().includes("PRODUCCION"))) {
        await processProduccion(wb);
      } else {
        await processStock(wb);
      }
    } catch (e: unknown) {
      addLog("❌ " + (e instanceof Error ? e.message : String(e)), "err");
      setProgressLabel("❌ Error al procesar");
    } finally {
      setImporting(false);
    }
  }

  async function processMapa(wb: XLSX.WorkBook) {
    const ws = wb.Sheets["CAL_LOC"];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
    addLog(`✓ Hoja CAL_LOC · ${rows.length} filas`);
    setProgress(20);

    const records: Record<string, unknown>[] = [];
    for (let i = CAL_LOC_HEADER_ROW + 1; i < rows.length; i++) {
      const r = rows[i] as unknown[];
      const zona = String(r[CAL_LOC_COL.ZONA] || "").trim();
      const loc = String(r[CAL_LOC_COL.LOC] || "").trim();
      if (!zona.startsWith("ZONA") || !loc) continue;
      const cap = parseInt(String(r[CAL_LOC_COL.CAPACIDAD])) || 0;
      const ocup = parseInt(String(r[CAL_LOC_COL.OCUPADO])) || 0;
      const disp = parseInt(String(r[CAL_LOC_COL.DISPONIBLE])) || (cap - ocup);
      let pct = parseFloat(String(r[CAL_LOC_COL.PCT])) || 0;
      if (pct > 5) pct = pct / 100;
      records.push({
        zona, localizador: loc,
        formato: String(r[CAL_LOC_COL.FORMATO] || "Mezcla").trim(),
        capacidad: cap, ocupado: ocup, disponible: disp,
        pct_ocupacion: Math.round(pct * 10000) / 10000, activo: true,
      });
    }

    if (!records.length) throw new Error("CAL_LOC: no se encontraron filas ZONA válidas");
    addLog(`✓ ${records.length} localizadores encontrados`);
    setProgress(35);

    const BATCH = 200;
    let done = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH);
      const { error } = await db.from("localizadores").upsert(batch, { onConflict: "zona,localizador" });
      if (error) throw new Error(`Lote ${Math.ceil(i / BATCH) + 1}: ${error.message}`);
      done += batch.length;
      setProgress(35 + Math.round((done / records.length) * 60));
      setProgressLabel(`Subiendo mapa… ${done}/${records.length}`);
    }

    setProgress(100);
    const ts = new Date().toLocaleTimeString("es-EC");
    setProgressLabel(`✅ Mapa cargado: ${records.length} localizadores`);
    addLog(`✅ Mapa actualizado con ${records.length} localizadores`, "ok");
    setResult({ type: "mapa", count: records.length, at: ts });
  }

  async function processProduccion(wb: XLSX.WorkBook) {
    const sheetName = wb.SheetNames.find(n => n.toUpperCase().includes("PRODUCCION")) ?? wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
    addLog(`✓ Hoja "${sheetName}" · ${rows.length} filas`);
    setProgress(10);

    const norm = (v: unknown) =>
      String(v).trim().toUpperCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

    // Locate header row (scan first 15 rows)
    let headerRowIdx = -1;
    const col: Record<string, number> = {};
    for (let i = 0; i < Math.min(15, rows.length); i++) {
      const r = (rows[i] as unknown[]).map(norm);
      const hasDesc = r.some(c => c.includes("DESCRIP"));
      const hasCod  = r.some(c => c.includes("COD") || c.includes("CODIGO"));
      if (!hasDesc || !hasCod) continue;
      headerRowIdx = i;
      r.forEach((c, idx) => {
        if      (c.includes("COD") && (c.includes("ORG") || (c.includes("INV") && c.length > 8))) col.cod_org_inv         = col.cod_org_inv         ?? idx;
        else if (c === "CODIGO" || (c.startsWith("COD") && c.length <= 6))                        col.codigo              = col.codigo              ?? idx;
        else if (c.includes("DESCRIP"))                                                            col.descripcion         = col.descripcion         ?? idx;
        else if (c.includes("SUBIN") && c.includes("ORIG"))                                       col.subinventario_origen = col.subinventario_origen ?? idx;
        else if (c.includes("LOCAL") && c.includes("ORIG"))                                       col.localizador_origen  = col.localizador_origen  ?? idx;
        else if (c === "LOTE")                                                                     col.lote                = col.lote                ?? idx;
        else if ((c.includes("CAN") || c.includes("CANT")) && c.includes("FIS"))                  col.cantidad_fisica     = col.cantidad_fisica     ?? idx;
        else if (c === "PALLETS" || c === "TARIMAS" || c === "PLT" || c.startsWith("PALLET"))     col.pallets             = col.pallets             ?? idx;
        else if (c === "CAJAS")                                                                    col.cajas               = col.cajas               ?? idx;
        else if (c.includes("SUBIN") && c.includes("DEST"))                                       col.subinventario_destino = col.subinventario_destino ?? idx;
        else if (c.includes("LOCAL") && c.includes("DEST"))                                       col.localizador_destino = col.localizador_destino ?? idx;
        else if (c.includes("RESPON"))                                                             col.responsable         = col.responsable         ?? idx;
        else if (c === "CONTEO" || c.startsWith("CONTEO"))                                        col.conteo              = col.conteo              ?? idx;
      });
      break;
    }

    if (headerRowIdx < 0) throw new Error("No se encontró fila de encabezados (DESCRIPCION + COD) en la hoja PRODUCCION");
    if (col.descripcion === undefined) throw new Error("No se encontró columna DESCRIPCION");

    addLog(`✓ Encabezado en fila ${headerRowIdx + 1} · ${Object.keys(col).length} columnas mapeadas`);
    setProgress(20);

    // Read data rows
    interface RawRow {
      cod_org_inv: string; codigo: string; descripcion: string;
      subinventario_origen: string; localizador_origen: string; lote: string;
      cantidad_fisica: number; pallets: number; cajas: number;
      subinventario_destino: string; localizador_destino: string;
      responsable: string; conteo: number | null;
    }
    const rawRows: RawRow[] = [];
    const get = (r: unknown[], k: string) => r[col[k]] ?? "";
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const r = rows[i] as unknown[];
      const desc = String(get(r, "descripcion")).trim();
      if (!desc) continue;
      rawRows.push({
        cod_org_inv:           String(get(r, "cod_org_inv")).trim(),
        codigo:                String(get(r, "codigo")).trim(),
        descripcion:           desc,
        subinventario_origen:  String(get(r, "subinventario_origen")).trim(),
        localizador_origen:    String(get(r, "localizador_origen")).trim(),
        lote:                  String(get(r, "lote")).trim(),
        cantidad_fisica:       parseFloat(String(get(r, "cantidad_fisica"))) || 0,
        pallets:               parseInt(String(get(r, "pallets"))) || 0,
        cajas:                 parseInt(String(get(r, "cajas"))) || 0,
        subinventario_destino: String(get(r, "subinventario_destino")).trim(),
        localizador_destino:   String(get(r, "localizador_destino")).trim(),
        responsable:           String(get(r, "responsable")).trim(),
        conteo:                col.conteo !== undefined ? (parseInt(String(get(r, "conteo"))) || null) : null,
      });
    }

    if (!rawRows.length) throw new Error("PRODUCCION: no se encontraron filas con datos");
    addLog(`✓ ${rawRows.length} líneas de reubicación leídas`);
    setProgress(35);

    // Fetch current ocupado for destination localizadores
    const destLocs = [...new Set(rawRows.map(r => r.localizador_destino.toUpperCase()).filter(Boolean))];
    const { data: locData, error: locErr } = await db
      .from("localizadores")
      .select("localizador, ocupado")
      .in("localizador", destLocs);
    if (locErr) throw new Error("BD localizadores: " + locErr.message);

    const ocupadoMap: Record<string, number> = {};
    (locData ?? []).forEach((l: { localizador: string; ocupado: number }) => {
      ocupadoMap[l.localizador.trim().toUpperCase()] = l.ocupado ?? 0;
    });
    addLog(`✓ ${Object.keys(ocupadoMap).length}/${destLocs.length} localizadores destino en BD`);
    setProgress(50);

    // Build inserts — INV-PE = ocupado_destino + pallets_de_esta_fila
    const now = new Date().toISOString();
    const inserts = rawRows.map(r => {
      const locKey = r.localizador_destino.toUpperCase();
      const invPe  = (ocupadoMap[locKey] ?? 0) + r.pallets;
      return {
        cod_org_inv:            r.cod_org_inv            || null,
        codigo:                 r.codigo                 || null,
        descripcion:            r.descripcion,
        subinventario_origen:   r.subinventario_origen   || null,
        localizador_origen:     r.localizador_origen     || null,
        lote:                   r.lote                   || null,
        cantidad_fisica:        r.cantidad_fisica,
        pallets:                r.pallets,
        cajas:                  r.cajas,
        subinventario_destino:  r.subinventario_destino  || null,
        localizador_destino:    r.localizador_destino    || null,
        responsable:            r.responsable            || null,
        inv_pe:                 invPe,
        conteo:                 r.conteo,
        estado:                 "pendiente",
        created_at:             now,
        updated_at:             now,
      };
    });

    const BATCH = 50;
    let done = 0;
    for (let i = 0; i < inserts.length; i += BATCH) {
      const batch = inserts.slice(i, i + BATCH);
      const { error } = await db.from("lineas_reubicacion").insert(batch);
      if (error) throw new Error(`Lote ${Math.ceil(i / BATCH) + 1}: ${error.message}`);
      done += batch.length;
      setProgress(50 + Math.round((done / inserts.length) * 45));
      setProgressLabel(`Insertando líneas… ${done}/${inserts.length}`);
    }

    setProgress(100);
    const ts = new Date().toLocaleTimeString("es-EC");
    setProgressLabel(`✅ ${inserts.length} líneas de reubicación creadas`);
    addLog(`✅ ${inserts.length} líneas insertadas como PENDIENTE — revisa en Órdenes de Producción`, "ok");
    setResult({ type: "produccion", count: inserts.length, at: ts });
  }

  async function processStock(wb: XLSX.WorkBook) {
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
    addLog(`✓ Hoja "${sheetName}" · ${rows.length} filas`);
    setProgress(10);

    let headerRowIdx = -1, locColIdx = -1, tarimasColIdx = -1, cantColIdx = -1;

    for (let i = 0; i < Math.min(30, rows.length); i++) {
      const row = (rows[i] as unknown[]).map(c =>
        String(c).trim().toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      );
      const li = row.findIndex(c => c === "LOCALIZADOR" || c === "LOC" || c.startsWith("LOCALIZ"));
      if (li < 0) continue;
      headerRowIdx = i;
      locColIdx = li;

      const tarimKw = ["TARIMA", "TARIMAS", "PALLET", "PALLETS", "ESTIBA", "PALETA", "PALETAS"];
      for (const kw of tarimKw) {
        const ti = row.findIndex((c, idx) => idx !== li && (c === kw || c.startsWith(kw)));
        if (ti >= 0) { tarimasColIdx = ti; break; }
      }

      if (tarimasColIdx < 0) {
        const qKw = ["CANTIDAD", "CANT", "QTY", "STOCK", "SALDO", "TOTAL", "UNIDADES"];
        for (const kw of qKw) {
          const qi = row.findIndex((c, idx) => idx !== li && (c === kw || c.startsWith(kw)));
          if (qi >= 0) { cantColIdx = qi; break; }
        }
      }
      break;
    }

    if (headerRowIdx < 0) throw new Error("No se encontró columna LOCALIZADOR en las primeras 30 filas");

    addLog(`✓ Encabezado en fila ${headerRowIdx + 1}`);
    setProgress(20);

    const totalByLoc: Record<string, number> = {};
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const r = rows[i] as unknown[];
      const loc = String(r[locColIdx] || "").trim().toUpperCase();
      if (!loc) continue;
      let pallets = 1;
      if (tarimasColIdx >= 0) {
        pallets = Math.ceil(parseFloat(String(r[tarimasColIdx] || "0")) || 0);
      } else if (cantColIdx >= 0) {
        pallets = Math.ceil(parseFloat(String(r[cantColIdx] || "0")) || 0);
      }
      totalByLoc[loc] = (totalByLoc[loc] ?? 0) + pallets;
    }

    const locKeys = Object.keys(totalByLoc);
    addLog(`✓ ${locKeys.length} localizadores únicos con stock`);
    setProgress(35);

    const { data: dbLocs, error: dbErr } = await db.from("localizadores").select("zona,localizador,capacidad");
    if (dbErr) throw new Error("BD: " + dbErr.message);

    const dbMap: Record<string, { zona: string; cap: number }> = {};
    (dbLocs || []).forEach((r: { zona: string; localizador: string; capacidad: number }) => {
      dbMap[r.localizador.trim().toUpperCase()] = { zona: r.zona, cap: r.capacidad };
    });

    const matched = locKeys.filter(k => dbMap[k]).length;
    addLog(`✓ BD: ${Object.keys(dbMap).length} loc · ${matched}/${locKeys.length} coincidencias`);
    if (matched === 0) throw new Error("Ningún localizador coincide con la BD");
    setProgress(50);

    type Update = { zona: string; localizador: string; ocupado: number; disponible: number; pct_ocupacion: number };
    const updates: Update[] = [];
    for (const [loc, info] of Object.entries(dbMap)) {
      const qty = totalByLoc[loc] ?? 0;
      const ocupado = Math.min(2_147_483_647, Math.round(qty));
      const disponible = Math.max(0, info.cap - ocupado);
      const pct = Math.min(9.9999, Math.round((info.cap > 0 ? ocupado / info.cap : 0) * 10000) / 10000);
      updates.push({ zona: info.zona, localizador: loc, ocupado, disponible, pct_ocupacion: pct });
    }

    const BATCH = 200;
    let done = 0;
    for (let i = 0; i < updates.length; i += BATCH) {
      const batch = updates.slice(i, i + BATCH);
      const { error } = await db.from("localizadores").upsert(batch, { onConflict: "zona,localizador" });
      if (error) throw new Error(`Lote ${Math.ceil(i / BATCH) + 1}: ${error.message}`);
      done += batch.length;
      setProgress(50 + Math.round((done / updates.length) * 45));
      setProgressLabel(`Actualizando BD… ${done}/${updates.length}`);
    }

    setProgress(100);
    const withStock = locKeys.filter(k => dbMap[k]).length;
    const ts = new Date().toLocaleTimeString("es-EC");
    setProgressLabel(`✅ ${withStock} localizadores actualizados`);
    addLog(`✅ Stock cargado: ${withStock} localizadores con datos`, "ok");
    setResult({ type: "stock", count: withStock, at: ts });
  }

  function handleFile(f: File) {
    if (f) processFile(f);
  }

  return (
    <div style={s.root}>
      <div style={s.pageHeader}>
        <div style={s.badge}>IMPORTACIÓN</div>
        <h1 style={s.title}>Subir Archivo</h1>
        <p style={s.sub}>Carga Excel de stock o mapa de planta para actualizar la BD</p>
      </div>

      <div style={s.grid}>
        {/* Zona de carga */}
        <div style={s.uploadBox}>
          <div
            style={{
              ...s.dropZone,
              borderColor: dragging ? "#f97316" : "rgba(249,115,22,0.25)",
              background: dragging ? "rgba(249,115,22,0.05)" : "transparent",
            }}
            onClick={() => !importing && fileRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          >
            <span style={{ fontSize: 48 }}>📂</span>
            <div style={s.dropTitle}>Arrastra tu archivo aquí</div>
            <div style={s.dropSub}>o haz clic para seleccionar</div>
            <div style={s.tags}>
              <span style={s.tagBlue}>Stock</span>
              <span style={s.tagGreen}>Mapa CAL_LOC</span>
              <span style={s.tagGray}>.xlsx · .xls</span>
            </div>
            <button
              style={{ ...s.btn, opacity: importing ? 0.6 : 1 }}
              disabled={importing}
              onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}
            >
              {importing ? "Procesando…" : "SELECCIONAR EXCEL →"}
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) { handleFile(f); e.target.value = ""; } }} />
          </div>

          {(importing || progressLabel) && (
            <div style={{ marginTop: 16 }}>
              <div style={s.progressTrack}>
                <div style={{ ...s.progressBar, width: `${progress}%`, background: importing ? "#f97316" : "#22c55e" }} />
              </div>
              <div style={s.progressLabel}>{progressLabel || "Procesando…"}</div>
            </div>
          )}

          {result && (
            <div style={s.resultBox}>
              <div style={s.resultTitle}>
                {result.type === "produccion"
                  ? "📋 Líneas de reubicación creadas"
                  : result.type === "mapa"
                  ? "⬡ Mapa de planta actualizado"
                  : "📦 Stock actualizado"}
              </div>
              <div style={s.resultSub}>{result.count} registros · {result.at}</div>
              <Link href={result.type === "produccion" ? "/ordenes-produccion" : "/analisis-bpt"} style={{ textDecoration: "none" }}>
                <button style={s.viewBtn}>
                  {result.type === "produccion" ? "VER ÓRDENES DE PRODUCCIÓN →" : "VER MAPA DE PLANTA →"}
                </button>
              </Link>
            </div>
          )}
        </div>

        {/* Guía + Log */}
        <div style={s.rightCol}>
          <div style={s.guideBox}>
            <div style={s.guideTitle}>GUÍA DE FORMATOS</div>
            <div style={s.guideSection}>
              <div style={s.guideLabel}>📦 Archivo de Stock</div>
              <ul style={s.guideList}>
                <li>Columna <code>LOCALIZADOR</code> o <code>LOC</code> requerida</li>
                <li>Columna <code>PALLETS</code> / <code>TARIMAS</code> o <code>CANTIDAD</code></li>
                <li>Opcional: <code>SUBINVENTARIO</code>, <code>FORMATO</code>, <code>LOTE</code></li>
                <li>Si hay CAJAS, cada saldo = 1 posición de pallet</li>
              </ul>
            </div>
            <div style={s.guideSection}>
              <div style={s.guideLabel}>⬡ Mapa de Planta</div>
              <ul style={s.guideList}>
                <li>El archivo debe contener hoja <code>CAL_LOC</code></li>
                <li>Estructura fija: zona, loc, formato, capacidad en columnas definidas</li>
                <li>Solo filas con zona tipo <code>ZONA X</code> son procesadas</li>
              </ul>
            </div>
            <div style={s.guideSection}>
              <div style={s.guideLabel}>📋 Producción — Reubicación</div>
              <ul style={s.guideList}>
                <li>Hoja con nombre que contenga <code>PRODUCCION</code></li>
                <li>Columnas: <code>Cod. Org Inv</code>, <code>Código</code>, <code>Descripción</code></li>
                <li><code>Subinventario/Localizador Origen</code> y <code>Destino</code></li>
                <li><code>Lote</code>, <code>Can Física</code>, <code>Pallets</code>, <code>Cajas</code></li>
                <li><code>RESPONSABLE</code> (escríbelo en el Excel antes de subir)</li>
                <li><code>INV-PE</code> se calcula: ocupado actual del destino + pallets de la fila</li>
                <li>Se crean como <b>PENDIENTE</b> para aprobar en Órdenes de Producción</li>
              </ul>
            </div>
          </div>

          {log.length > 0 && (
            <div style={s.logBox} ref={logRef}>
              <div style={s.logTitle}>LOG DE PROCESO</div>
              <div style={s.logContent}>
                {log.map((l, i) => (
                  <div key={i} style={{
                    ...s.logLine,
                    color: l.cls === "ok" ? "#4ade80" : l.cls === "err" ? "#f87171" : l.cls === "warn" ? "#fbbf24" : "#9ca3af",
                  }}>{l.msg}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const s: { [k: string]: React.CSSProperties } = {
  root: { padding: "32px", fontFamily: "'Courier New', monospace", color: "#e2e8f0", minHeight: "100vh", background: "#0a0e17" },
  pageHeader: { marginBottom: 28 },
  badge: { display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", marginBottom: 10 },
  title: { margin: "0 0 6px", fontSize: 26, fontWeight: 700, color: "#fff", letterSpacing: 1 },
  sub: { margin: 0, fontSize: 12, color: "#4a5568" },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, alignItems: "start" },
  uploadBox: { display: "flex", flexDirection: "column", gap: 0 },
  dropZone: { border: "2px dashed", borderRadius: 4, padding: "40px 32px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, cursor: "pointer", transition: "all 0.2s", textAlign: "center" as const },
  dropTitle: { fontSize: 16, fontWeight: 700, color: "#fff", letterSpacing: 1 },
  dropSub: { fontSize: 12, color: "#4a5568" },
  tags: { display: "flex", gap: 8, flexWrap: "wrap" as const, justifyContent: "center" },
  tagBlue: { background: "#1e3a5f", color: "#60a5fa", padding: "2px 10px", borderRadius: 3, fontSize: 11, letterSpacing: 1 },
  tagGreen: { background: "#1a2e1a", color: "#4ade80", padding: "2px 10px", borderRadius: 3, fontSize: 11, letterSpacing: 1 },
  tagGray: { background: "#1e2235", color: "#6b7280", padding: "2px 10px", borderRadius: 3, fontSize: 11, letterSpacing: 1 },
  btn: { background: "#f97316", border: "none", color: "#000", fontSize: 11, fontWeight: 700, letterSpacing: 2, padding: "12px 24px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", marginTop: 4 },
  progressTrack: { height: 6, background: "#1e2235", borderRadius: 3, overflow: "hidden" },
  progressBar: { height: "100%", borderRadius: 3, transition: "width 0.3s" },
  progressLabel: { fontSize: 11, color: "#6b7280", marginTop: 6 },
  resultBox: { marginTop: 20, background: "#0d1117", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 4, padding: "20px 24px", display: "flex", flexDirection: "column", gap: 8 },
  resultTitle: { fontSize: 13, fontWeight: 700, color: "#4ade80" },
  resultSub: { fontSize: 11, color: "#6b7280" },
  viewBtn: { background: "transparent", border: "1px solid rgba(37,99,235,0.4)", color: "#60a5fa", fontSize: 10, letterSpacing: 2, padding: "8px 16px", cursor: "pointer", fontFamily: "'Courier New', monospace", marginTop: 4 },
  rightCol: { display: "flex", flexDirection: "column", gap: 16 },
  guideBox: { background: "#0d1117", border: "1px solid rgba(249,115,22,0.15)", borderRadius: 4, padding: "20px 24px" },
  guideTitle: { fontSize: 10, letterSpacing: 3, color: "#f97316", marginBottom: 16 },
  guideSection: { marginBottom: 16 },
  guideLabel: { fontSize: 12, fontWeight: 700, color: "#e2e8f0", marginBottom: 8 },
  guideList: { margin: 0, padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: 5 },
  logBox: { background: "#0d1117", border: "1px solid rgba(249,115,22,0.1)", borderRadius: 4, padding: "16px 20px" },
  logTitle: { fontSize: 10, letterSpacing: 3, color: "#f97316", marginBottom: 10 },
  logContent: { maxHeight: 240, overflowY: "auto" as const },
  logLine: { fontSize: 11, fontFamily: "monospace", lineHeight: 1.6, whiteSpace: "pre-wrap" as const, marginBottom: 2 },
};
