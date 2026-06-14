"use client";

import { useRef, useState, useCallback } from "react";
import * as XLSX from "xlsx";
import Link from "next/link";
import { getBrowserClient } from "@/lib/supabase/browser";

const db = getBrowserClient();

const CAL_LOC_HEADER_ROW = 7;
const CAL_LOC_COL = { ZONA: 1, LOC: 2, FORMATO: 3, CAPACIDAD: 10, OCUPADO: 14, DISPONIBLE: 17, PCT: 18 };

const normStr = (v: unknown) =>
  String(v).trim().toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// ── Types ─────────────────────────────────────────────────────────────────────

type LogEntry = { msg: string; cls: string };
type Step = "idle" | "previewing" | "preview" | "importing" | "done";

type FormatCheck = {
  localizador: string;
  zona: string;
  formato_archivo: string;
  formato_db: string;
  match: boolean;
  en_db: boolean;
};

type StockUpdate = {
  zona: string;
  localizador: string;
  ocupado: number;
  disponible: number;
  pct_ocupacion: number;
};

type StockPreview = {
  kind: "stock";
  has_format_col: boolean;
  total_locs: number;
  locs_in_db: number;
  format_checks: FormatCheck[];
  mismatches_count: number;
  not_in_db_count: number;
  updates: StockUpdate[];
};

type EditableRow = {
  _id: number;
  cod_org_inv: string;
  codigo: string;
  descripcion: string;
  subinventario_origen: string;
  localizador_origen: string;
  lote: string;
  cantidad_fisica: number;
  pallets: number;
  cajas: number;
  subinventario_destino: string;
  localizador_destino: string;
  zona_destino: string;
  formato_destino: string;
  loc_encontrado: boolean;
  responsable: string;
  conteo: number | null;
};

type ProduccionPreview = {
  kind: "produccion";
  locs_not_found: string[];
};

type MapaPreview = {
  kind: "mapa";
  records: Record<string, unknown>[];
  count: number;
};

type Preview = StockPreview | ProduccionPreview | MapaPreview;

type UploadResult = { type: "mapa" | "stock" | "produccion"; count: number; at: string } | null;

// ── Component ─────────────────────────────────────────────────────────────────

export default function SubirArchivoPage() {
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("idle");
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [result, setResult] = useState<UploadResult>(null);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [editableRows, setEditableRows] = useState<EditableRow[]>([]);
  const [allLocMap, setAllLocMap] = useState<Record<string, { zona: string; formato: string }>>({});
  const [showAllChecks, setShowAllChecks] = useState(false);

  const addLog = useCallback((msg: string, cls = "") => {
    setLog(p => [...p, { msg, cls }]);
  }, []);

  // ── Parse / Preview phase ──────────────────────────────────────────────────

  async function handleFile(file: File) {
    setStep("previewing");
    setProgress(0);
    setProgressLabel("Analizando archivo…");
    setLog([]);
    setResult(null);
    setPreview(null);
    setShowAllChecks(false);

    try {
      addLog(`📖 Leyendo "${file.name}"…`);
      setProgress(10);
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      addLog(`✓ Hojas: ${wb.SheetNames.join(", ")}`);
      setProgress(20);

      if (wb.SheetNames.includes("CAL_LOC")) {
        await previewMapa(wb);
      } else if (wb.SheetNames.some(n => n.toUpperCase().includes("PRODUCCION"))) {
        await previewProduccion(file);
      } else {
        await previewStock(wb, file);
      }
    } catch (e: unknown) {
      addLog("❌ " + (e instanceof Error ? e.message : String(e)), "err");
      setProgressLabel("❌ Error al analizar");
      setStep("idle");
    }
  }

  async function previewMapa(wb: XLSX.WorkBook) {
    setProgressLabel("Analizando mapa CAL_LOC…");
    const ws = wb.Sheets["CAL_LOC"];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
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
      if (pct > 5) pct /= 100;
      records.push({
        zona, localizador: loc,
        formato: String(r[CAL_LOC_COL.FORMATO] || "Mezcla").trim(),
        capacidad: cap, ocupado: ocup, disponible: disp,
        pct_ocupacion: Math.round(pct * 10000) / 10000, activo: true,
      });
    }
    if (!records.length) throw new Error("CAL_LOC: no se encontraron filas ZONA válidas");
    addLog(`✓ ${records.length} localizadores encontrados en el mapa`);
    setProgress(90);
    setPreview({ kind: "mapa", records, count: records.length });
    setProgressLabel(`Listo · ${records.length} localizadores`);
    setStep("preview");
  }

  async function previewStock(wb: XLSX.WorkBook, file: File) {
    setProgressLabel("Analizando stock…");
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
    addLog(`✓ Hoja "${sheetName}" · ${rows.length} filas`);
    setProgress(25);

    // Detect header — incluyendo columna FORMATO para validar sin llamada extra al backend
    let headerRowIdx = -1, locColIdx = -1, tarimasColIdx = -1, cajasColIdx = -1, cantColIdx = -1, formatoColIdx = -1;
    for (let i = 0; i < Math.min(30, rows.length); i++) {
      const row = (rows[i] as unknown[]).map(normStr);
      const li = row.findIndex(c => c === "LOCALIZADOR" || c === "LOC" || c.startsWith("LOCALIZ"));
      if (li < 0) continue;
      headerRowIdx = i; locColIdx = li;
      for (const kw of ["TARIMA", "TARIMAS", "PALLET", "PALLETS", "ESTIBA", "PALETA", "PALETAS"]) {
        const ti = row.findIndex((c, idx) => idx !== li && (c === kw || c.startsWith(kw)));
        if (ti >= 0) { tarimasColIdx = ti; break; }
      }
      for (const kw of ["CAJAS", "CAJA", "BOXES", "FRACCION"]) {
        const ci = row.findIndex((c, idx) => idx !== li && idx !== tarimasColIdx && (c === kw || c.startsWith(kw)));
        if (ci >= 0) { cajasColIdx = ci; break; }
      }
      if (tarimasColIdx < 0) {
        for (const kw of ["CANTIDAD", "CANT", "QTY", "STOCK", "SALDO", "TOTAL", "UNIDADES"]) {
          const qi = row.findIndex((c, idx) => idx !== li && (c === kw || c.startsWith(kw)));
          if (qi >= 0) { cantColIdx = qi; break; }
        }
      }
      for (const kw of ["FORMATO", "FORMAT", "TIPO"]) {
        const fi = row.findIndex((c, idx) => idx !== li && idx !== tarimasColIdx && idx !== cajasColIdx && (c === kw || c.startsWith(kw)));
        if (fi >= 0) { formatoColIdx = fi; break; }
      }
      break;
    }
    if (headerRowIdx < 0) throw new Error("No se encontró columna LOCALIZADOR en las primeras 30 filas");
    addLog(`✓ Encabezado en fila ${headerRowIdx + 1}`);

    // Compute totalByLoc y capturar (localizador → formato del archivo) en un solo pase
    const totalByLoc: Record<string, number> = {};
    const fileFmts: Record<string, string> = {};  // última ocurrencia de formato por localizador
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const r = rows[i] as unknown[];
      const loc = String(r[locColIdx] || "").trim().toUpperCase();
      if (!loc) continue;
      let pallets = 1;
      if (tarimasColIdx >= 0) {
        const tar = parseFloat(String(r[tarimasColIdx] || "0")) || 0;
        const caj = cajasColIdx >= 0 ? (parseFloat(String(r[cajasColIdx] || "0")) || 0) : 0;
        pallets = Math.ceil(tar) + (caj > 0 ? 1 : 0);
        if (pallets === 0) pallets = 0;
      } else if (cantColIdx >= 0) {
        pallets = Math.ceil(parseFloat(String(r[cantColIdx] || "0")) || 0);
      }
      totalByLoc[loc] = (totalByLoc[loc] ?? 0) + pallets;
      if (formatoColIdx >= 0) fileFmts[loc] = String(r[formatoColIdx] || "").trim();
    }
    setProgress(40);

    // Fetch localizadores en paralelo mientras procesamos (única llamada BD)
    const { data: dbLocs, error: dbErr } = await db
      .from("localizadores").select("zona,localizador,capacidad,formato");
    if (dbErr) throw new Error("BD: " + dbErr.message);

    const dbMap: Record<string, { zona: string; cap: number; formato: string }> = {};
    (dbLocs || []).forEach((r: { zona: string; localizador: string; capacidad: number; formato: string }) => {
      dbMap[r.localizador.trim().toUpperCase()] = { zona: r.zona, cap: r.capacidad, formato: r.formato || "" };
    });
    setProgress(65);

    // Compute updates y format_checks en un solo pase — sin llamada extra al backend
    const updates: StockUpdate[] = [];
    for (const [loc, info] of Object.entries(dbMap)) {
      const qty = totalByLoc[loc] ?? 0;
      const ocupado = Math.min(2_147_483_647, Math.round(qty));
      const disponible = Math.max(0, info.cap - ocupado);
      const pct = Math.min(9.9999, Math.round((info.cap > 0 ? ocupado / info.cap : 0) * 10000) / 10000);
      updates.push({ zona: info.zona, localizador: loc, ocupado, disponible, pct_ocupacion: pct });
    }

    const has_format_col = formatoColIdx >= 0;
    const format_checks: FormatCheck[] = Object.entries(fileFmts).map(([loc, fmtFile]) => {
      const db = dbMap[loc];
      if (!db) return { localizador: loc, zona: "", formato_archivo: fmtFile, formato_db: "", match: false, en_db: false };
      const fmtDB = db.formato;
      const comodin = !fmtDB || ["MEZCLA", "MIX", "VACIO"].includes(fmtDB.toUpperCase());
      const match = !fmtFile || comodin || fmtFile.toUpperCase() === fmtDB.toUpperCase();
      return { localizador: loc, zona: db.zona, formato_archivo: fmtFile, formato_db: fmtDB, match, en_db: true };
    });
    const mismatches_count = format_checks.filter(c => !c.match && c.en_db).length;
    const not_in_db_count = format_checks.filter(c => !c.en_db).length;

    const matched = Object.keys(totalByLoc).filter(k => dbMap[k]).length;
    addLog(`✓ ${Object.keys(dbMap).length} loc en BD · ${matched}/${Object.keys(totalByLoc).length} del archivo coinciden`);
    if (has_format_col) {
      if (mismatches_count > 0) addLog(`⚠️ ${mismatches_count} discrepancias de formato detectadas`, "warn");
      else addLog("✓ Todos los formatos son compatibles con los localizadores destino", "ok");
    } else {
      addLog("ℹ️ El archivo no tiene columna FORMATO — se omite validación", "");
    }

    setProgress(90);
    setPreview({ kind: "stock", has_format_col, total_locs: Object.keys(totalByLoc).length,
      locs_in_db: matched, format_checks, mismatches_count, not_in_db_count, updates });
    setProgressLabel(`Listo · ${matched} localizadores para actualizar`);
    setStep("preview");
  }

  async function previewProduccion(file: File) {
    setProgressLabel("Analizando líneas de producción…");

    // Lanzar backend + fetch de localizadores en paralelo
    const fd = new FormData();
    fd.append("file", file);
    const [res, { data: allLocs }] = await Promise.all([
      fetch("/api/upload-preview", { method: "POST", body: fd }),
      db.from("localizadores").select("zona,localizador,formato"),
    ]);

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail ?? err.error ?? "Error al analizar el archivo");
    }
    const data = await res.json();
    if (data.type !== "produccion") throw new Error("Tipo de archivo inesperado");

    // Mapa de localizadores listo al mismo tiempo que la respuesta del backend
    const locMap: Record<string, { zona: string; formato: string }> = {};
    (allLocs || []).forEach((l: { zona: string; localizador: string; formato: string }) => {
      locMap[l.localizador.trim().toUpperCase()] = { zona: l.zona, formato: l.formato || "" };
    });
    setAllLocMap(locMap);

    const rows: EditableRow[] = (data.rows ?? []).map((r: EditableRow) => ({ ...r }));
    addLog(`✓ ${rows.length} líneas de reubicación encontradas`);
    if ((data.locs_not_found ?? []).length > 0)
      addLog(`⚠️ ${data.locs_not_found.length} localizadores destino no encontrados en BD: ${data.locs_not_found.slice(0, 3).join(", ")}${data.locs_not_found.length > 3 ? "…" : ""}`, "warn");
    setProgress(90);

    setEditableRows(rows);
    setPreview({ kind: "produccion", locs_not_found: data.locs_not_found ?? [] });
    setProgressLabel(`Listo · ${rows.length} líneas para revisar`);
    setStep("preview");
  }

  // ── Row editing ────────────────────────────────────────────────────────────

  function updateRow(id: number, field: "localizador_destino" | "subinventario_destino", value: string) {
    setEditableRows(prev => prev.map(r => {
      if (r._id !== id) return r;
      if (field === "localizador_destino") {
        const key = value.trim().toUpperCase();
        const info = allLocMap[key];
        return { ...r, localizador_destino: value,
          zona_destino: info?.zona ?? (key ? "?" : ""),
          formato_destino: info?.formato ?? "",
          loc_encontrado: !!info };
      }
      return { ...r, [field]: value };
    }));
  }

  // ── Import phase ───────────────────────────────────────────────────────────

  async function confirmImport() {
    if (!preview) return;
    setStep("importing");
    setProgress(0);
    setProgressLabel("");
    setLog([]);

    try {
      if (preview.kind === "mapa") await importMapa(preview.records);
      else if (preview.kind === "stock") await importStock(preview.updates, preview.locs_in_db);
      else await importProduccion(editableRows);
    } catch (e: unknown) {
      addLog("❌ " + (e instanceof Error ? e.message : String(e)), "err");
      setProgressLabel("❌ Error al importar");
      setStep("preview");
    }
  }

  async function importMapa(records: Record<string, unknown>[]) {
    addLog(`📤 Subiendo ${records.length} localizadores…`);
    const BATCH = 200;
    let done = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH);
      const { error } = await db.from("localizadores").upsert(batch, { onConflict: "zona,localizador" });
      if (error) throw new Error(`Lote ${Math.ceil(i / BATCH) + 1}: ${error.message}`);
      done += batch.length;
      setProgress(Math.round((done / records.length) * 100));
      setProgressLabel(`Actualizando mapa… ${done}/${records.length}`);
    }
    setProgress(100);
    const ts = new Date().toLocaleTimeString("es-EC");
    setProgressLabel(`✅ Mapa actualizado: ${records.length} localizadores`);
    addLog(`✅ Mapa actualizado con ${records.length} localizadores`, "ok");
    setResult({ type: "mapa", count: records.length, at: ts });
    setStep("done");
  }

  async function importStock(updates: StockUpdate[], matched: number) {
    addLog(`📤 Actualizando ${updates.length} localizadores…`);
    const BATCH = 200;
    let done = 0;
    for (let i = 0; i < updates.length; i += BATCH) {
      const batch = updates.slice(i, i + BATCH);
      const { error } = await db.from("localizadores").upsert(batch, { onConflict: "zona,localizador" });
      if (error) throw new Error(`Lote ${Math.ceil(i / BATCH) + 1}: ${error.message}`);
      done += batch.length;
      setProgress(Math.round((done / updates.length) * 100));
      setProgressLabel(`Actualizando BD… ${done}/${updates.length}`);
    }
    setProgress(100);
    const ts = new Date().toLocaleTimeString("es-EC");
    setProgressLabel(`✅ ${matched} localizadores actualizados`);
    addLog(`✅ Stock cargado: ${matched} localizadores con datos`, "ok");
    setResult({ type: "stock", count: matched, at: ts });
    setStep("done");
  }

  async function importProduccion(rows: EditableRow[]) {
    addLog(`📤 Preparando ${rows.length} líneas…`);
    setProgress(10);

    const destLocs = [...new Set(rows.map(r => r.localizador_destino.toUpperCase()).filter(Boolean))];
    const { data: locData, error: locErr } = await db
      .from("localizadores").select("localizador,ocupado").in("localizador", destLocs);
    if (locErr) throw new Error("BD localizadores: " + locErr.message);

    const ocupadoMap: Record<string, number> = {};
    (locData ?? []).forEach((l: { localizador: string; ocupado: number }) => {
      ocupadoMap[l.localizador.trim().toUpperCase()] = l.ocupado ?? 0;
    });
    addLog(`✓ ${Object.keys(ocupadoMap).length}/${destLocs.length} localizadores destino en BD`);
    setProgress(25);

    const codigos = [...new Set(rows.map(r => r.codigo).filter(Boolean))];
    const catPalletsMap: Record<string, number> = {};
    if (codigos.length > 0) {
      const { data: catData } = await db
        .from("catalogo_productos").select("codigo,cajas_por_pallet").in("codigo", codigos);
      (catData ?? []).forEach((c: { codigo: string; cajas_por_pallet: number }) => {
        if (c.cajas_por_pallet) catPalletsMap[c.codigo] = Number(c.cajas_por_pallet);
      });
    }
    setProgress(40);

    const now = new Date().toISOString();
    const inserts = rows.map(r => {
      const locKey = r.localizador_destino.toUpperCase();
      const cpp = catPalletsMap[r.codigo] ?? 0;
      const effPallets = r.pallets > 0 ? r.pallets
        : r.cajas > 0 && cpp > 0 ? Math.ceil(r.cajas / cpp) : r.cajas > 0 ? 1 : 0;
      return {
        cod_org_inv: r.cod_org_inv || null,
        codigo: r.codigo || null,
        descripcion: r.descripcion,
        subinventario_origen: r.subinventario_origen || null,
        localizador_origen: r.localizador_origen || null,
        lote: r.lote || null,
        cantidad_fisica: r.cantidad_fisica,
        pallets: r.pallets,
        cajas: r.cajas,
        subinventario_destino: r.subinventario_destino || null,
        localizador_destino: r.localizador_destino || null,
        responsable: r.responsable || null,
        inv_pe: (ocupadoMap[locKey] ?? 0) + effPallets,
        conteo: r.conteo,
        estado: "pendiente",
        created_at: now,
        updated_at: now,
      };
    });

    const BATCH = 50;
    let done = 0;
    for (let i = 0; i < inserts.length; i += BATCH) {
      const batch = inserts.slice(i, i + BATCH);
      const { error } = await db.from("lineas_reubicacion").insert(batch);
      if (error) throw new Error(`Lote ${Math.ceil(i / BATCH) + 1}: ${error.message}`);
      done += batch.length;
      setProgress(40 + Math.round((done / inserts.length) * 56));
      setProgressLabel(`Insertando líneas… ${done}/${inserts.length}`);
    }

    setProgress(100);
    const ts = new Date().toLocaleTimeString("es-EC");
    setProgressLabel(`✅ ${inserts.length} líneas de reubicación creadas`);
    addLog(`✅ ${inserts.length} líneas insertadas como PENDIENTE`, "ok");
    setResult({ type: "produccion", count: inserts.length, at: ts });
    setStep("done");
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={s.root}>
      <div style={s.pageHeader}>
        <div style={s.badge}>IMPORTACIÓN</div>
        <h1 style={s.title}>Subir Archivo</h1>
        <p style={s.sub}>Carga Excel de stock o mapa de planta para actualizar la BD</p>
      </div>

      {/* ── IDLE / PREVIEWING: upload zone ── */}
      {(step === "idle" || step === "previewing") && (
        <div style={s.grid}>
          <div style={s.uploadBox}>
            <div
              style={{ ...s.dropZone,
                borderColor: dragging ? "#f97316" : "rgba(249,115,22,0.25)",
                background: dragging ? "rgba(249,115,22,0.05)" : "transparent",
                opacity: step === "previewing" ? 0.6 : 1,
                pointerEvents: step === "previewing" ? "none" : "auto",
              }}
              onClick={() => fileRef.current?.click()}
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
                <span style={s.tagOrange}>Producción</span>
                <span style={s.tagGray}>.xlsx · .xls</span>
              </div>
              <button
                style={{ ...s.btn, opacity: step === "previewing" ? 0.6 : 1 }}
                disabled={step === "previewing"}
                onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}
              >
                {step === "previewing" ? "Analizando…" : "SELECCIONAR EXCEL →"}
              </button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
                onChange={e => { const f = e.target.files?.[0]; if (f) { handleFile(f); e.target.value = ""; } }} />
            </div>

            {step === "previewing" && (
              <div style={{ marginTop: 16 }}>
                <div style={s.progressTrack}>
                  <div style={{ ...s.progressBar, width: `${progress}%`, background: "#f97316" }} />
                </div>
                <div style={s.progressLabel}>{progressLabel || "Analizando…"}</div>
              </div>
            )}
          </div>

          <div style={s.rightCol}>
            <div style={s.guideBox}>
              <div style={s.guideTitle}>GUÍA DE FORMATOS</div>
              <div style={s.guideSection}>
                <div style={s.guideLabel}>📦 Archivo de Stock</div>
                <ul style={s.guideList}>
                  <li>Columna <code>LOCALIZADOR</code> o <code>LOC</code> requerida</li>
                  <li>Columna <code>PALLETS</code> / <code>TARIMAS</code> o <code>CANTIDAD</code></li>
                  <li>Opcional: <code>FORMATO</code> — se valida contra BD antes de importar</li>
                </ul>
              </div>
              <div style={s.guideSection}>
                <div style={s.guideLabel}>⬡ Mapa de Planta</div>
                <ul style={s.guideList}>
                  <li>El archivo debe contener hoja <code>CAL_LOC</code></li>
                  <li>Solo filas con zona tipo <code>ZONA X</code> son procesadas</li>
                </ul>
              </div>
              <div style={s.guideSection}>
                <div style={s.guideLabel}>📋 Producción — Reubicación</div>
                <ul style={s.guideList}>
                  <li>Hoja con nombre que contenga <code>PRODUCCION</code></li>
                  <li>Destino editable antes de confirmar importación</li>
                  <li>Se crean como <b>PENDIENTE</b> para aprobar en Órdenes</li>
                </ul>
              </div>
            </div>
            {log.length > 0 && <LogPanel log={log} />}
          </div>
        </div>
      )}

      {/* ── PREVIEW ── */}
      {step === "preview" && preview && (
        <div>
          {preview.kind === "mapa" && (
            <MapaPreviewPanel
              preview={preview}
              log={log}
              onCancel={() => setStep("idle")}
              onConfirm={confirmImport}
            />
          )}
          {preview.kind === "stock" && (
            <StockPreviewPanel
              preview={preview}
              log={log}
              showAllChecks={showAllChecks}
              onToggleAll={() => setShowAllChecks(p => !p)}
              onCancel={() => setStep("idle")}
              onConfirm={confirmImport}
            />
          )}
          {preview.kind === "produccion" && (
            <ProduccionPreviewPanel
              rows={editableRows}
              locs_not_found={preview.locs_not_found}
              log={log}
              onUpdateRow={updateRow}
              onCancel={() => setStep("idle")}
              onConfirm={confirmImport}
            />
          )}
        </div>
      )}

      {/* ── IMPORTING ── */}
      {step === "importing" && (
        <div style={s.importingBox}>
          <div style={s.importingTitle}>Importando datos…</div>
          <div style={s.progressTrack}>
            <div style={{ ...s.progressBar, width: `${progress}%`, background: "#f97316" }} />
          </div>
          <div style={s.progressLabel}>{progressLabel || "Procesando…"}</div>
          <LogPanel log={log} />
        </div>
      )}

      {/* ── DONE ── */}
      {step === "done" && result && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <div style={s.progressTrack}>
              <div style={{ ...s.progressBar, width: "100%", background: "#22c55e" }} />
            </div>
            <div style={s.progressLabel}>{progressLabel}</div>
          </div>
          <div style={s.resultBox}>
            <div style={s.resultTitle}>
              {result.type === "produccion" ? "📋 Líneas de reubicación creadas"
                : result.type === "mapa" ? "⬡ Mapa de planta actualizado"
                : "📦 Stock actualizado"}
            </div>
            <div style={s.resultSub}>{result.count} registros · {result.at}</div>
            <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
              <Link href={result.type === "produccion" ? "/ordenes-produccion" : "/analisis-bpt"} style={{ textDecoration: "none" }}>
                <button style={s.viewBtn}>
                  {result.type === "produccion" ? "VER ÓRDENES →" : "VER MAPA →"}
                </button>
              </Link>
              <button style={{ ...s.viewBtn, borderColor: "rgba(249,115,22,0.4)", color: "#f97316" }}
                onClick={() => { setStep("idle"); setResult(null); setPreview(null); setLog([]); }}>
                SUBIR OTRO
              </button>
            </div>
          </div>
          <LogPanel log={log} />
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function LogPanel({ log }: { log: { msg: string; cls: string }[] }) {
  if (!log.length) return null;
  return (
    <div style={s.logBox}>
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
  );
}

function ConfirmBar({ onCancel, onConfirm, confirmLabel }: { onCancel: () => void; onConfirm: () => void; confirmLabel: string }) {
  return (
    <div style={s.confirmBar}>
      <button style={s.cancelBtn} onClick={onCancel}>CANCELAR</button>
      <button style={s.confirmBtn} onClick={onConfirm}>{confirmLabel} →</button>
    </div>
  );
}

function MapaPreviewPanel({ preview, log, onCancel, onConfirm }: {
  preview: { count: number };
  log: { msg: string; cls: string }[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div style={s.previewWrapper}>
      <div style={s.previewHeader}>
        <div style={s.badge}>PREVISUALIZACIÓN — MAPA CAL_LOC</div>
        <div style={{ marginTop: 12, fontSize: 14, color: "#e2e8f0" }}>
          Se actualizarán <strong style={{ color: "#4ade80" }}>{preview.count}</strong> localizadores en la BD.
        </div>
      </div>
      <ConfirmBar onCancel={onCancel} onConfirm={onConfirm} confirmLabel="IMPORTAR MAPA" />
      <LogPanel log={log} />
    </div>
  );
}

function StockPreviewPanel({ preview, log, showAllChecks, onToggleAll, onCancel, onConfirm }: {
  preview: { has_format_col: boolean; total_locs: number; locs_in_db: number; format_checks: { localizador: string; zona: string; formato_archivo: string; formato_db: string; match: boolean; en_db: boolean }[]; mismatches_count: number; not_in_db_count: number; updates: unknown[] };
  log: { msg: string; cls: string }[];
  showAllChecks: boolean;
  onToggleAll: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const notFound = preview.format_checks.filter(c => !c.en_db);
  const mismatches = preview.format_checks.filter(c => c.en_db && !c.match);
  const ok = preview.format_checks.filter(c => c.en_db && c.match);
  const visibleChecks = showAllChecks ? preview.format_checks : [...mismatches, ...notFound].slice(0, 20);

  return (
    <div style={s.previewWrapper}>
      <div style={s.previewHeader}>
        <div style={s.badge}>PREVISUALIZACIÓN — STOCK</div>
        <div style={s.statsRow}>
          <Stat label="Loc en archivo" value={preview.total_locs} color="#e2e8f0" />
          <Stat label="Encontrados en BD" value={preview.locs_in_db} color="#4ade80" />
          {preview.has_format_col && <Stat label="Formatos OK" value={ok.length} color="#4ade80" />}
          {preview.has_format_col && preview.mismatches_count > 0 && <Stat label="Discrepancias" value={preview.mismatches_count} color="#fbbf24" />}
          {preview.not_in_db_count > 0 && <Stat label="No en BD" value={preview.not_in_db_count} color="#f87171" />}
        </div>
      </div>

      {preview.has_format_col && (mismatches.length > 0 || notFound.length > 0 || showAllChecks) && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, letterSpacing: 2, color: "#f97316", marginBottom: 10 }}>
            {showAllChecks ? "TODOS LOS CHEQUEOS DE FORMATO" : "DISCREPANCIAS DE FORMATO"}
          </div>
          <div style={{ overflowX: "auto" as const }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {["LOCALIZADOR","ZONA","FORMATO ARCHIVO","FORMATO BD","ESTADO"].map(h => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleChecks.map(c => (
                  <tr key={c.localizador}>
                    <td style={s.td}>{c.localizador}</td>
                    <td style={s.td}>{c.zona || "—"}</td>
                    <td style={s.td}>{c.formato_archivo || "—"}</td>
                    <td style={s.td}>{c.formato_db || "—"}</td>
                    <td style={s.td}>
                      {!c.en_db
                        ? <span style={{ color: "#f87171" }}>❌ No en BD</span>
                        : c.match
                          ? <span style={{ color: "#4ade80" }}>✅ Compatible</span>
                          : <span style={{ color: "#fbbf24" }}>⚠️ Discrepancia</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button style={s.toggleBtn} onClick={onToggleAll}>
            {showAllChecks ? "▲ Mostrar solo problemas" : `▼ Ver todos (${preview.format_checks.length})`}
          </button>
        </div>
      )}

      {preview.has_format_col && mismatches.length === 0 && notFound.length === 0 && (
        <div style={s.allOkBox}>✅ Todos los formatos del archivo son compatibles con los localizadores en BD.</div>
      )}
      {!preview.has_format_col && (
        <div style={s.infoBox}>ℹ️ El archivo no contiene columna FORMATO — se importa sin validación de formato.</div>
      )}

      <ConfirmBar onCancel={onCancel} onConfirm={onConfirm} confirmLabel="CONFIRMAR E IMPORTAR STOCK" />
      <LogPanel log={log} />
    </div>
  );
}

function ProduccionPreviewPanel({ rows, locs_not_found, log, onUpdateRow, onCancel, onConfirm }: {
  rows: EditableRow[];
  locs_not_found: string[];
  log: { msg: string; cls: string }[];
  onUpdateRow: (id: number, field: "localizador_destino" | "subinventario_destino", value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div style={s.previewWrapper}>
      <div style={s.previewHeader}>
        <div style={s.badge}>PREVISUALIZACIÓN — PRODUCCIÓN / REUBICACIÓN</div>
        <div style={s.statsRow}>
          <Stat label="Líneas" value={rows.length} color="#e2e8f0" />
          <Stat label="Destinos encontrados" value={rows.filter(r => r.loc_encontrado).length} color="#4ade80" />
          {locs_not_found.length > 0 && <Stat label="Destinos no encontrados" value={locs_not_found.length} color="#f87171" />}
        </div>
        <p style={{ fontSize: 11, color: "#6b7280", margin: "8px 0 0" }}>
          Edita el <strong style={{ color: "#e2e8f0" }}>Subinventario Destino</strong> y el <strong style={{ color: "#e2e8f0" }}>Localizador Destino</strong> antes de importar. La Zona y el Formato se actualizan automáticamente.
        </p>
      </div>

      <div style={{ overflowX: "auto" as const, marginBottom: 16 }}>
        <table style={{ ...s.table, minWidth: 900 }}>
          <thead>
            <tr>
              {["DESCRIPCIÓN","ORIGEN","SUBINV DESTINO","LOC DESTINO","ZONA","FORMATO","PLT","CAJ"].map(h => (
                <th key={h} style={s.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r._id} style={{ background: !r.loc_encontrado && r.localizador_destino ? "rgba(248,113,113,0.05)" : undefined }}>
                <td style={{ ...s.td, maxWidth: 200 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                    {r.descripcion}
                  </div>
                  {r.codigo && <div style={{ fontSize: 10, color: "#6b7280" }}>{r.codigo}</div>}
                </td>
                <td style={s.td}>{r.localizador_origen || "—"}</td>
                <td style={s.td}>
                  <input
                    style={s.editInput}
                    value={r.subinventario_destino}
                    onChange={e => onUpdateRow(r._id, "subinventario_destino", e.target.value)}
                    placeholder="—"
                  />
                </td>
                <td style={s.td}>
                  <input
                    style={{
                      ...s.editInput,
                      borderColor: r.localizador_destino && !r.loc_encontrado
                        ? "rgba(248,113,113,0.6)"
                        : r.loc_encontrado ? "rgba(74,222,128,0.3)" : "rgba(249,115,22,0.2)",
                    }}
                    value={r.localizador_destino}
                    onChange={e => onUpdateRow(r._id, "localizador_destino", e.target.value)}
                    placeholder="—"
                  />
                </td>
                <td style={{ ...s.td, color: r.zona_destino === "?" ? "#fbbf24" : r.zona_destino ? "#4ade80" : "#6b7280" }}>
                  {r.zona_destino || "—"}
                </td>
                <td style={{ ...s.td, color: "#9ca3af" }}>{r.formato_destino || "—"}</td>
                <td style={{ ...s.td, textAlign: "right" as const }}>{r.pallets || "—"}</td>
                <td style={{ ...s.td, textAlign: "right" as const }}>{r.cajas || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmBar onCancel={onCancel} onConfirm={onConfirm} confirmLabel="CONFIRMAR E IMPORTAR" />
      <LogPanel log={log} />
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={s.stat}>
      <div style={{ ...s.statValue, color }}>{value}</div>
      <div style={s.statLabel}>{label}</div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: { [k: string]: React.CSSProperties } = {
  root: { padding: "32px", fontFamily: "'Courier New', monospace", color: "#e2e8f0", minHeight: "100vh", background: "#0a0e17" },
  pageHeader: { marginBottom: 28 },
  badge: { display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", marginBottom: 10 },
  title: { margin: "0 0 6px", fontSize: 26, fontWeight: 700, color: "#fff", letterSpacing: 1 },
  sub: { margin: 0, fontSize: 12, color: "#4a5568" },

  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, alignItems: "start" },
  uploadBox: { display: "flex", flexDirection: "column", gap: 0 },
  dropZone: { border: "2px dashed", borderRadius: 4, padding: "40px 32px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, cursor: "pointer", transition: "all 0.2s", textAlign: "center" },
  dropTitle: { fontSize: 16, fontWeight: 700, color: "#fff", letterSpacing: 1 },
  dropSub: { fontSize: 12, color: "#4a5568" },
  tags: { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" },
  tagBlue: { background: "#1e3a5f", color: "#60a5fa", padding: "2px 10px", borderRadius: 3, fontSize: 11, letterSpacing: 1 },
  tagGreen: { background: "#1a2e1a", color: "#4ade80", padding: "2px 10px", borderRadius: 3, fontSize: 11, letterSpacing: 1 },
  tagOrange: { background: "#2d1a0a", color: "#fb923c", padding: "2px 10px", borderRadius: 3, fontSize: 11, letterSpacing: 1 },
  tagGray: { background: "#1e2235", color: "#6b7280", padding: "2px 10px", borderRadius: 3, fontSize: 11, letterSpacing: 1 },
  btn: { background: "#f97316", border: "none", color: "#000", fontSize: 11, fontWeight: 700, letterSpacing: 2, padding: "12px 24px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", marginTop: 4 },

  progressTrack: { height: 6, background: "#1e2235", borderRadius: 3, overflow: "hidden" },
  progressBar: { height: "100%", borderRadius: 3, transition: "width 0.3s" },
  progressLabel: { fontSize: 11, color: "#6b7280", marginTop: 6 },

  rightCol: { display: "flex", flexDirection: "column", gap: 16 },
  guideBox: { background: "#0d1117", border: "1px solid rgba(249,115,22,0.15)", borderRadius: 4, padding: "20px 24px" },
  guideTitle: { fontSize: 10, letterSpacing: 3, color: "#f97316", marginBottom: 16 },
  guideSection: { marginBottom: 16 },
  guideLabel: { fontSize: 12, fontWeight: 700, color: "#e2e8f0", marginBottom: 8 },
  guideList: { margin: 0, padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: 5 },

  logBox: { background: "#0d1117", border: "1px solid rgba(249,115,22,0.1)", borderRadius: 4, padding: "16px 20px", marginTop: 16 },
  logTitle: { fontSize: 10, letterSpacing: 3, color: "#f97316", marginBottom: 10 },
  logContent: { maxHeight: 200, overflowY: "auto" },
  logLine: { fontSize: 11, fontFamily: "monospace", lineHeight: 1.6, whiteSpace: "pre-wrap", marginBottom: 2 },

  // Preview
  previewWrapper: { maxWidth: 1100 },
  previewHeader: { marginBottom: 20 },
  statsRow: { display: "flex", gap: 24, marginTop: 16, flexWrap: "wrap" },
  stat: { display: "flex", flexDirection: "column", gap: 2 },
  statValue: { fontSize: 28, fontWeight: 700, lineHeight: 1 },
  statLabel: { fontSize: 10, color: "#6b7280", letterSpacing: 1 },

  table: { width: "100%", borderCollapse: "collapse", fontSize: 11 },
  th: { background: "#0d1117", padding: "8px 12px", textAlign: "left", color: "#f97316", fontSize: 10, letterSpacing: 2, borderBottom: "1px solid rgba(249,115,22,0.2)", whiteSpace: "nowrap" },
  td: { padding: "7px 12px", borderBottom: "1px solid rgba(255,255,255,0.04)", color: "#9ca3af", verticalAlign: "middle" },
  toggleBtn: { marginTop: 8, background: "transparent", border: "1px solid rgba(255,255,255,0.1)", color: "#6b7280", fontSize: 10, letterSpacing: 1, padding: "5px 12px", cursor: "pointer", fontFamily: "'Courier New', monospace", borderRadius: 2 },
  allOkBox: { background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 4, padding: "12px 16px", fontSize: 12, color: "#4ade80", marginBottom: 16 },
  infoBox: { background: "rgba(96,165,250,0.06)", border: "1px solid rgba(96,165,250,0.15)", borderRadius: 4, padding: "12px 16px", fontSize: 12, color: "#60a5fa", marginBottom: 16 },

  editInput: { background: "#0d1117", border: "1px solid rgba(249,115,22,0.2)", color: "#e2e8f0", fontSize: 11, padding: "4px 8px", fontFamily: "'Courier New', monospace", width: "100%", minWidth: 110, borderRadius: 2, outline: "none" },

  confirmBar: { display: "flex", gap: 12, marginBottom: 20 },
  cancelBtn: { background: "transparent", border: "1px solid rgba(255,255,255,0.15)", color: "#6b7280", fontSize: 11, letterSpacing: 2, padding: "10px 20px", cursor: "pointer", fontFamily: "'Courier New', monospace", borderRadius: 2 },
  confirmBtn: { background: "#f97316", border: "none", color: "#000", fontSize: 11, fontWeight: 700, letterSpacing: 2, padding: "10px 24px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },

  importingBox: { maxWidth: 600 },
  importingTitle: { fontSize: 13, color: "#e2e8f0", marginBottom: 16 },

  resultBox: { background: "#0d1117", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 4, padding: "20px 24px", display: "flex", flexDirection: "column", gap: 8, maxWidth: 500 },
  resultTitle: { fontSize: 13, fontWeight: 700, color: "#4ade80" },
  resultSub: { fontSize: 11, color: "#6b7280" },
  viewBtn: { background: "transparent", border: "1px solid rgba(37,99,235,0.4)", color: "#60a5fa", fontSize: 10, letterSpacing: 2, padding: "8px 16px", cursor: "pointer", fontFamily: "'Courier New', monospace" },
};
