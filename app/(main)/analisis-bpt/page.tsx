"use client";
import { useEffect, useState, useRef, useCallback, useMemo } from "react"; import * as XLSX from "xlsx";
import { getBrowserClient } from "@/lib/supabase/browser";
const db = getBrowserClient();
// ── Tipos ──────────────────────────────────────────────────────────────────
interface Localizador { zona: string; localizador: string; formato?: string; capacidad: number; ocupado: number; disponible: number; pct_ocupacion: number; activo?: boolean; }
interface SubInvItem {
  loc: string; subinv: string; formato: string; lote: string; pallets: number; codigo?: string;
  descripcion?: string; cajas?: number; cantidad_fisica?: number; cod_org_inv?: string;
}
interface Asignacion { loc: string; zona: string; palletsAsignados: number; prioridad?: string; }
interface PlanEntry { formato: string; lote: string; palletsNeed: number; asignaciones: Asignacion[]; palletsAsignados: number; palletsRestantes: number; cobertura_pct?: number; }
interface FragmentacionItem { formato: string; total_pallets: number; num_localizadores: number; nivel: string; indice: number; }
interface Consolidacion { formato: string; lote: string; locs_origen: string[]; loc_destino: string; zona_destino: string; pallets_a_mover: number; beneficio: string; }
interface AlertaBodega { nivel: string; mensaje: string; detalle?: string; }
interface ResumenFormato { formato: string; total_pallets: number; m2_estimado?: number; locs_propios: number; locs_ocupados: number; cobertura_pct: number; }
interface AnalisisData { fragmentacion: FragmentacionItem[]; consolidaciones: Consolidacion[]; alertas: AlertaBodega[]; resumen_formatos: ResumenFormato[]; metricas: Record<string, unknown>; }
interface TooltipData { d: Localizador; zona: string; x: number; y: number; } interface SelectedLoc { d: Localizador; zona: string; }
interface Movimiento { paso: number; tipo: "liberar" | "consolidar"; codigo: string; lote: string; pallets: number; formato: string; loc_origen: string; zona_origen: string; loc_destino: string; zona_destino: string; razon: string; }
interface SinEspacioItem { codigo: string; lote: string; pallets: number; formato: string; loc_origen: string; motivo: string; }
interface ConsolidacionPlan { movimientos: Movimiento[]; resumen: { total_movimientos: number; locs_liberadas: string[]; locs_liberadas_count: number; lotes_consolidados: number; pallets_movidos: number; fase_liberar: number; fase_consolidar: number; sin_espacio_count: number; }; sin_espacio: SinEspacioItem[]; }
interface ZonaCriticidad { zona: string; num_locs_mezcladas: number; num_codigos_fragmentados: number; pallets_en_mezcla: number; pallets_fragmentados: number; score_criticidad: number; nivel: "CRITICO" | "ALTO" | "MEDIO" | "OK"; }
interface PlanDiarioCriticidad { zonas_ordenadas: ZonaCriticidad[]; zonas_sin_mapa: string[]; total_mezclas: number; total_fragmentados: number; }
type UploadPhase = "idle" | "zoneSelect" | "formatCheck";
interface FileLocData { loc: string; zona: string; formato: string; pallets: number; }
interface FormatRow { _id: number; loc: string; zona: string; formato: string; pallets: number; locDest: string; }
interface StockUpdate { zona: string; localizador: string; ocupado: number; disponible: number; pct_ocupacion: number; }
// ── Colores ocupación ──────────────────────────────────────────────────────
const C = { empty: "#1e293b", low: "#639922", mid: "#1D9E75", high: "#BA7517", full: "#E24B4A", over: "#7A1F1F", };
function getColor(p: number) { if (p <= 0) return C.empty; if (p < 0.5) return C.low; if (p < 0.8) return C.mid; if (p < 1.0) return C.high; if (p < 1.1) return C.full; return C.over; }
const S = { available: "#16a34a", hasSubInv: "#2563eb", otherOcup: "#374151", full: "#E24B4A", };
function getSubInvColor(d: Localizador, subStock: number): string { if (d.pct_ocupacion > 1.1) return S.full; if (subStock > 0) return S.hasSubInv; if ((d.ocupado || 0) > 0) return S.otherOcup; return S.available; }
function getBadgeStyle(avg: number): React.CSSProperties { if (avg >= 1.1) return { background: "#7A1F1F", color: "#fca5a5" }; if (avg >= 1.0) return { background: "#633806", color: "#fcd34d" }; if (avg >= 0.8) return { background: "#1a3a1a", color: "#86efac" }; return { background: "#1e2235", color: "#8b8fa8" }; }
// Config hoja mapa CAL_LOC
const CAL_LOC_HEADER_ROW = 7;
const CAL_LOC_COL = { ZONA: 1, LOC: 2, FORMATO: 3, CAPACIDAD: 10, OCUPADO: 14, DISPONIBLE: 17, PCT: 18 };
// ── Componente ─────────────────────────────────────────────────────────────
export default function AnalisisBPTPage() { const [allData, setAllData] = useState<Record<string, Localizador[]>>({}); const [loading, setLoading] = useState(true); const [connOk, setConnOk] = useState<boolean | null>(null); const [lastUpdate, setLastUpdate] = useState(""); const [lastImportInfo, setLastImportInfo] = useState("");
const [fZone, setFZone] = useState("all"); const [fStatus, setFStatus] = useState("all"); const [fSearch, setFSearch] = useState("");
const [subInvStock, setSubInvStock] = useState<Record<string, Record<string, number>>>({}); const [allSubInvs, setAllSubInvs] = useState<string[]>([]); const [selectedSubInv, setSelectedSubInv] = useState("all");
// Plan de distribución
const [sortingPlan, setSortingPlan] = useState<PlanEntry[]>([]);
const [analisisData, setAnalisisData] = useState<AnalisisData | null>(null);
const [loadingPlan, setLoadingPlan] = useState(false);
const [showPlan, setShowPlan] = useState(false);
const [showAnalisis, setShowAnalisis] = useState(false);
const [planFilter, setPlanFilter] = useState("");
const [tooltip, setTooltip] = useState<TooltipData | null>(null); const [selectedLoc, setSelectedLoc] = useState<SelectedLoc | null>(null); const [viewMode, setViewMode] = useState<"map" | "table">("map");
const [importLog, setImportLog] = useState<{ msg: string; cls: string }[]>([]); const [progress, setProgress] = useState(0); const [progressLabel, setProgressLabel] = useState(""); const [importing, setImporting] = useState(false); const [dragging, setDragging] = useState(false);
const fileRef = useRef<HTMLInputElement>(null); const logRef = useRef<HTMLDivElement>(null);
// ── Upload flow state ────────────────────────────────────────────────────
const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
const [fileZones, setFileZones] = useState<string[]>([]);
const [fileByZone, setFileByZone] = useState<Record<string, FileLocData[]>>({});
const [fileSubInvItems, setFileSubInvItems] = useState<SubInvItem[]>([]);
const [selZone, setSelZone] = useState("all");
const [selLoc, setSelLoc] = useState("all");
const [consolidacionPlan, setConsolidacionPlan] = useState<ConsolidacionPlan | null>(null);
const [loadingConsolidacion, setLoadingConsolidacion] = useState(false);
const [showConsolidacion, setShowConsolidacion] = useState(true);
const [planDiario, setPlanDiario] = useState<PlanDiarioCriticidad | null>(null);
const [loadingDiario, setLoadingDiario] = useState(false);
const [formatRows, setFormatRows] = useState<FormatRow[]>([]);
// ── Cargar mapa desde BD ────────────────────────────────────────────────
const loadMap = useCallback(async () => { try { const { data, error } = await db .from("localizadores") .select("zona,localizador,formato,pct_ocupacion,capacidad,ocupado,disponible") .eq("activo", true) .order("zona").order("localizador"); if (error) throw error; const grouped: Record<string, Localizador[]> = {}; (data || []).forEach((r: Localizador) => { if (!grouped[r.zona]) grouped[r.zona] = []; grouped[r.zona].push(r); }); setAllData(grouped); setConnOk(true); setLastUpdate(new Date().toLocaleTimeString("es-EC")); } catch { setConnOk(false); } finally { setLoading(false); } }, []);
useEffect(() => { loadMap(); const t = setInterval(loadMap, 60_000); return () => clearInterval(t); }, [loadMap]);
useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [importLog]);
// ── Filtros ─────────────────────────────────────────────────────────────
function matchFilter(p: number) { if (fStatus === "all") return true; if (fStatus === "empty") return p <= 0; if (fStatus === "low") return p > 0 && p < 0.5; if (fStatus === "mid") return p >= 0.5 && p < 0.8; if (fStatus === "high") return p >= 0.8 && p <= 1.0; if (fStatus === "over") return p > 1.0; return true; }
// ── Stats globales ──────────────────────────────────────────────────────
const allLocs = useMemo(() => Object.values(allData).flat(), [allData]);
const { totalCap, totalOcup, totalPalletsLibres, conStock, conExceso } = useMemo(() => {
  let totalCap = 0, totalOcup = 0, totalPalletsLibres = 0, conStock = 0, conExceso = 0;
  for (const d of allLocs) {
    totalCap += d.capacidad || 0;
    totalOcup += d.ocupado || 0;
    totalPalletsLibres += Math.max(0, d.disponible || 0);
    if (d.ocupado > 0) conStock++;
    if (d.pct_ocupacion > 1.0) conExceso++;
  }
  return { totalCap, totalOcup, totalPalletsLibres, conStock, conExceso };
}, [allLocs]);
const avgGlobal = totalCap > 0 ? totalOcup / totalCap : 0;
const subInvMap = selectedSubInv !== "all" ? (subInvStock[selectedSubInv] ?? {}) : null; const subInvStats = subInvMap ? (() => { const keys = Object.keys(subInvMap); const total = keys.reduce((s, k) => s + (subInvMap[k] || 0), 0); return { locs: keys.length, total }; })() : null;
const stats = useMemo(() => [ { v: allLocs.length, l: "Localizadores" }, { v: Object.keys(allData).length, l: "Zonas" }, { v: (avgGlobal * 100).toFixed(1) + "%", l: "Ocupación global" }, { v: conStock, l: "Con stock" }, { v: totalPalletsLibres, l: "Pallets libres" }, { v: conExceso, l: "Con exceso" }, ], [allLocs.length, allData, avgGlobal, conStock, totalPalletsLibres, conExceso]);
// ── Detectar columnas del Excel ─────────────────────────────────────────
function detectHeader(rows: unknown[][]): { headerRowIdx: number; locColIdx: number; tarimasColIdx: number; cajasColIdx: number; cantColIdx: number; subInvColIdx: number; formatoColIdx: number; loteColIdx: number; codigoColIdx: number; descColIdx: number; codOrgInvColIdx: number; } { let headerRowIdx = -1, locColIdx = -1, tarimasColIdx = -1; let cajasColIdx = -1, cantColIdx = -1, subInvColIdx = -1; let formatoColIdx = -1, loteColIdx = -1, codigoColIdx = -1; let descColIdx = -1, codOrgInvColIdx = -1;
for (let i = 0; i < Math.min(30, rows.length); i++) {
  const row = (rows[i] as unknown[]).map(c =>
    String(c).trim().toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  );

  const li = row.findIndex(c =>
    c === "LOCALIZADOR" || c === "LOC" || c === "LOCALIZACION" || c.startsWith("LOCALIZ")
  );
  if (li < 0) continue;

  headerRowIdx = i;
  locColIdx    = li;

  subInvColIdx = row.findIndex(c =>
    c === "SUBINVENTARIO" || c === "SUBINV" || c === "SUB_INVENTARIO" ||
    c === "SUB INVENTARIO" || c === "SUBALMACEN" || c.startsWith("SUBIN")
  );

  formatoColIdx = row.findIndex((c, idx) =>
    idx !== li && idx !== subInvColIdx &&
    (c === "FORMATO" || c === "FORMAT" || c === "TIPO" || c.startsWith("FORMAT"))
  );

  loteColIdx = row.findIndex((c, idx) =>
    idx !== li && idx !== subInvColIdx && idx !== formatoColIdx &&
    (c === "LOTE" || c === "LOT" || c === "NUM_LOTE" || c === "NUMERO_LOTE" ||
     c === "NUMERO LOTE" || c === "NRO_LOTE" || c.startsWith("LOTE"))
  );

  for (const kw of ["CODIGO", "COD PROD", "COD ART", "COD ARTICULO", "COD PRODUCTO", "COD ITEM"]) {
    const ci = row.findIndex((c, idx) =>
      idx !== li && idx !== subInvColIdx && idx !== formatoColIdx && idx !== loteColIdx && c === kw
    );
    if (ci >= 0) { codigoColIdx = ci; break; }
  }
  if (codigoColIdx < 0) {
    const ci = row.findIndex((c, idx) =>
      idx !== li && idx !== subInvColIdx && idx !== formatoColIdx && idx !== loteColIdx &&
      (c === "COD" || (c.startsWith("COD") && c.length <= 7 && !c.includes("ORG") && !c.includes("INV")))
    );
    if (ci >= 0) codigoColIdx = ci;
  }

  const tarimKw = ["TARIMA", "TARIMAS", "PALLET", "PALLETS", "ESTIBA",
                   "NRO TARIMA", "NTAR", "NUM TARIMA", "PALETA", "PALETAS"];
  for (const kw of tarimKw) {
    const ti = row.findIndex((c, idx) =>
      idx !== li && idx !== subInvColIdx && (c === kw || c.startsWith(kw))
    );
    if (ti >= 0) { tarimasColIdx = ti; break; }
  }

  const cajaKw = ["CAJAS", "CAJA", "BOXES", "BOX", "FRACCION", "FRACCIONES",
                  "SALDO CAJA", "SALDO_CAJA", "UNIDADES SUELTAS", "SUELTAS"];
  for (const kw of cajaKw) {
    const ci2 = row.findIndex((c, idx) =>
      idx !== li && idx !== subInvColIdx && idx !== tarimasColIdx &&
      (c === kw || c.startsWith(kw))
    );
    if (ci2 >= 0) { cajasColIdx = ci2; break; }
  }

  const qKw = ["CANTIDAD", "CANT", "QTY", "STOCK", "SALDO",
               "TOTAL UOM", "TOTAL_UOM", "TOTAL", "UNIDADES", "UND"];
  for (const kw of qKw) {
    const qi = row.findIndex((c, idx) =>
      idx !== li && idx !== subInvColIdx && idx !== tarimasColIdx && idx !== cajasColIdx &&
      (c === kw || c.startsWith(kw))
    );
    if (qi >= 0) { cantColIdx = qi; break; }
  }

  if (tarimasColIdx < 0 && cantColIdx < 0) {
    const nr = (rows[Math.min(i + 1, rows.length - 1)] as unknown[]);
    for (let ci = li + 1; ci < row.length; ci++) {
      if (ci === subInvColIdx) continue;
      const v = String(nr[ci] || "");
      if (v && !isNaN(parseFloat(v))) { cantColIdx = ci; break; }
    }
  }

  // Detectar descripcion
  descColIdx = row.findIndex((c, idx) =>
    idx !== li && idx !== subInvColIdx && idx !== codigoColIdx &&
    (c === "DESCRIPCION" || c === "DESCRIPCION ARTICULO" || c === "DESCRIPCION PRODUCTO" ||
     c === "DESC" || c === "NOMBRE" || c.startsWith("DESCRIP"))
  );

  // Detectar cod_org_inv
  codOrgInvColIdx = row.findIndex((c, idx) =>
    idx !== li && idx !== codigoColIdx &&
    (c === "COD ORG INV" || c === "COD_ORG_INV" || c === "CODORGINV" ||
     c === "ORG INV" || c === "ORGANIZACION INV" || (c.includes("ORG") && c.includes("INV")))
  );

  break;
}
return { headerRowIdx, locColIdx, tarimasColIdx, cajasColIdx, cantColIdx, subInvColIdx, formatoColIdx, loteColIdx, codigoColIdx, descColIdx, codOrgInvColIdx };
}
// ── Procesar Excel ─────────────────────────────────────────────────────
async function processExcel(file: File) { setImporting(true); setProgress(0); setProgressLabel(""); setImportLog([]);
function log(msg: string, cls = "") {
  setImportLog(p => [...p, { msg, cls }]);
}

try {
  log("📖 Leyendo archivo…");
  setProgress(5);

  const buf = await file.arrayBuffer();
  const wb  = XLSX.read(buf, { type: "array" });
  log(`✓ Hojas encontradas: ${wb.SheetNames.join(", ")}`);

  // ── Rama 1: mapa CAL_LOC ─────────────────────────────────────────
  if (wb.SheetNames.includes("CAL_LOC")) {
    const ws   = wb.Sheets["CAL_LOC"];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
    log(`✓ Hoja CAL_LOC · ${rows.length} filas`);
    setProgress(20);

    const records: Localizador[] = [];
    for (let i = CAL_LOC_HEADER_ROW + 1; i < rows.length; i++) {
      const r    = rows[i] as unknown[];
      const zona = String(r[CAL_LOC_COL.ZONA] || "").trim();
      const loc  = String(r[CAL_LOC_COL.LOC]  || "").trim();
      if (!zona.startsWith("ZONA") || !loc) continue;
      const cap  = parseInt(String(r[CAL_LOC_COL.CAPACIDAD]))  || 0;
      const ocup = parseInt(String(r[CAL_LOC_COL.OCUPADO]))    || 0;
      const disp = parseInt(String(r[CAL_LOC_COL.DISPONIBLE])) || (cap - ocup);
      let   pct  = parseFloat(String(r[CAL_LOC_COL.PCT]))      || 0;
      if (pct > 5) pct = pct / 100;
      records.push({
        zona, localizador: loc,
        formato: String(r[CAL_LOC_COL.FORMATO] || "Mezcla").trim(),
        capacidad: cap, ocupado: ocup, disponible: disp,
        pct_ocupacion: Math.round(pct * 10000) / 10000, activo: true,
      });
    }

    if (!records.length) throw new Error("CAL_LOC: no se encontraron filas ZONA válidas");
    log(`✓ ${records.length} localizadores en el mapa`);
    setProgress(35);

    const BATCH = 200;
    let done = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH);
      const { error } = await db.from("localizadores").upsert(batch, { onConflict: "zona,localizador" });
      if (error) throw new Error(`Lote ${Math.ceil(i / BATCH) + 1}: ${error.message}`);
      done += batch.length;
      setProgress(35 + Math.round((done / records.length) * 55));
      setProgressLabel(`Subiendo mapa… ${done}/${records.length}`);
    }

    setProgress(100);
    setProgressLabel(`✅ Mapa cargado: ${records.length} localizadores`);
    log(`✅ Mapa de planta actualizado con ${records.length} localizadores`, "ok");
    setLastImportInfo(`Mapa · ${records.length} loc · ${new Date().toLocaleTimeString("es-EC")}`);

  // ── Rama 2: archivo de STOCK ──────────────────────────────────────
  } else {
    const sheetName = wb.SheetNames[0];
    const ws   = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
    log(`✓ Hoja "${sheetName}" · ${rows.length} filas totales`);
    setProgress(8);

    log("⟳ Detectando estructura del archivo…");
    const { headerRowIdx, locColIdx, tarimasColIdx, cajasColIdx, cantColIdx, subInvColIdx, formatoColIdx, loteColIdx, codigoColIdx, descColIdx, codOrgInvColIdx } = detectHeader(rows);

    if (headerRowIdx < 0 || locColIdx < 0) {
      const preview = rows.slice(0, 8).map((r, i) =>
        `  fila ${i + 1}: ${(r as unknown[]).slice(0, 6).map(c => `"${String(c)}"`).join(" | ")}`
      ).join("\n");
      throw new Error(
        `No se encontró columna LOCALIZADOR.\n` +
        `Asegúrate de que el encabezado tenga "LOCALIZADOR" o "LOC".\n\nPrimeras filas:\n${preview}`
      );
    }

    const headers = (rows[headerRowIdx] as unknown[]).map(c => String(c).trim());
    log(
      `✓ Estructura detectada (fila ${headerRowIdx + 1}):\n` +
      `  LOC       → col ${locColIdx + 1}: "${headers[locColIdx]}"\n` +
      (subInvColIdx  >= 0 ? `  SUBINV    → col ${subInvColIdx + 1}: "${headers[subInvColIdx]}"\n`  : `  SUBINV    → no encontrado\n`) +
      (codigoColIdx  >= 0 ? `  CODIGO    → col ${codigoColIdx + 1}: "${headers[codigoColIdx]}"\n`  : `  CODIGO    → no encontrado (se usará catálogo si hay formato vacío)\n`) +
      (formatoColIdx >= 0 ? `  FORMATO   → col ${formatoColIdx + 1}: "${headers[formatoColIdx]}"\n` : `  FORMATO   → no encontrado\n`) +
      (loteColIdx    >= 0 ? `  LOTE      → col ${loteColIdx + 1}: "${headers[loteColIdx]}"\n`      : `  LOTE      → no encontrado\n`) +
      (tarimasColIdx >= 0 ? `  PALLETS   → col ${tarimasColIdx + 1}: "${headers[tarimasColIdx]}"\n` : `  PALLETS   → no encontrado\n`) +
      (cajasColIdx   >= 0 ? `  CAJAS     → col ${cajasColIdx + 1}: "${headers[cajasColIdx]}" ← cada saldo = 1 posición pallet\n` : `  CAJAS     → no encontrado\n`) +
      (cantColIdx    >= 0 ? `  CANTIDAD  → col ${cantColIdx + 1}: "${headers[cantColIdx]}"` : `  CANT      → no encontrado (1 fila = 1 pallet)`)
    );
    setProgress(14);

    // ── PASO 2: leer TODAS las filas ────────────────────────────────
    log("⟳ Leyendo stock…\n  Regla ocupación: PALLETS (ceil) + CAJAS (cada saldo distinto = 1 pos)");

    const totalByLoc: Record<string, number>                 = {};
    const bySubInv:   Record<string, Record<string, number>> = {};
    const subInvItems: SubInvItem[]                          = [];
    const subInvSet   = new Set<string>();
    let   totalRows   = 0, skippedRows = 0;

    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const r   = rows[i] as unknown[];
      const raw = String(r[locColIdx] || "").trim();
      if (!raw) { skippedRows++; continue; }
      const loc = raw.toUpperCase();
      totalRows++;

      // ── Cálculo de pallets ocupados por esta fila ────────────────
      // Cada fila con PALLETS > 0  → ceil(pallets) posiciones
      // Cada fila con CAJAS > 0   → 1 posición extra (saldo suelto)
      // Si ambos están en la misma fila → ceil(pallets) + 1
      let pallets: number;
      if (tarimasColIdx >= 0) {
        const tarimasVal = parseFloat(String(r[tarimasColIdx] || "0")) || 0;
        const cajasVal   = cajasColIdx >= 0 ? (parseFloat(String(r[cajasColIdx] || "0")) || 0) : 0;
        pallets = Math.ceil(tarimasVal) + (cajasVal > 0 ? 1 : 0);
      } else {
        // Sin columna PALLETS: cada fila = 1 posición de pallet
        pallets = 1;
      }

      totalByLoc[loc] = (totalByLoc[loc] ?? 0) + pallets;

      // Acumular por subinventario
      if (subInvColIdx >= 0) {
        const si  = String(r[subInvColIdx] || "").trim();
        const fmt = formatoColIdx >= 0 ? String(r[formatoColIdx] || "").trim() : "";
        const lot = loteColIdx    >= 0 ? String(r[loteColIdx]    || "").trim() : "";
        if (si) {
          subInvSet.add(si);
          if (!bySubInv[si]) bySubInv[si] = {};
          bySubInv[si][loc] = (bySubInv[si][loc] ?? 0) + pallets;
          const cod        = codigoColIdx    >= 0 ? String(r[codigoColIdx]    || "").trim() : "";
          const desc       = descColIdx      >= 0 ? String(r[descColIdx]      || "").trim() : "";
          const codOrgInv  = codOrgInvColIdx >= 0 ? String(r[codOrgInvColIdx] || "").trim() : "";
          const cajasVal   = cajasColIdx     >= 0 ? (parseFloat(String(r[cajasColIdx] || "0")) || 0) : 0;
          const cantVal    = cantColIdx      >= 0 ? (parseFloat(String(r[cantColIdx]  || "0")) || 0) : undefined;
          subInvItems.push({
            loc, subinv: si, formato: fmt, lote: lot, pallets, codigo: cod,
            descripcion: desc || undefined,
            cajas: cajasVal,
            cantidad_fisica: cantVal,
            cod_org_inv: codOrgInv || undefined,
          });
        }
      }
    }

    const locKeys   = Object.keys(totalByLoc);
    const subInvArr = [...subInvSet].sort();

    log(
      `✓ Lectura completa:\n` +
      `  ${totalRows} filas con localizador · ${skippedRows} ignoradas\n` +
      `  ${locKeys.length} localizadores únicos\n` +
      (subInvArr.length > 0
        ? `  ${subInvArr.length} subinventarios: ${subInvArr.join(", ")}`
        : `  (sin columna subinventario)`)
    );
    setProgress(28);

    if (!locKeys.length) throw new Error("No se encontraron filas con localizador válido");

    // ── PASO 3: consultar BD ─────────────────────────────────────────
    log("⟳ Consultando BD…");
    const { data: allDbLocs, error: dbErr } = await db
      .from("localizadores")
      .select("zona,localizador,capacidad,formato");
    if (dbErr) throw new Error("BD: " + dbErr.message);

    const dbMap: Record<string, { zona: string; cap: number; formato: string }> = {};
    (allDbLocs || []).forEach((r: { zona: string; localizador: string; capacidad: number; formato: string }) => {
      dbMap[r.localizador.trim().toUpperCase()] = { zona: r.zona, cap: r.capacidad, formato: r.formato || "" };
    });

    const matched = locKeys.filter(k => dbMap[k]).length;
    log(
      `✓ BD: ${Object.keys(dbMap).length} localizadores · Coincidencias: ${matched}/${locKeys.length}\n` +
      `  Ejemplos Excel: ${locKeys.slice(0, 4).join(", ")}\n` +
      `  Ejemplos BD:    ${Object.keys(dbMap).slice(0, 4).join(", ")}`
    );
    setProgress(38);

    if (matched === 0) {
      throw new Error(
        `Ningún localizador del Excel coincide con la BD.\n` +
        `Excel → "${locKeys.slice(0, 3).join('", "')}"\n` +
        `BD    → "${Object.keys(dbMap).slice(0, 3).join('", "')}"`
      );
    }

    // Muestra de valores calculados
    {
      const sample = locKeys.slice(0, 5).map(k => `  ${k}: ${totalByLoc[k]}`).join("\n");
      log(`✓ Muestra posiciones de pallet por localizador:\n${sample}`);
    }
    setProgress(40);

    // ── PASO 4: calcular ocupación real y actualizar BD ───────────
    log("⟳ Calculando ocupación real…");

    const updates: StockUpdate[] = [];
    let withStock = 0, resetToZero = 0, notInDB = 0;

    for (const [loc, info] of Object.entries(dbMap)) {
      const qty     = totalByLoc[loc] ?? 0;
      const ocupado = Math.min(2_147_483_647, Math.max(0, Math.round(qty)));
      const disponible = Math.max(0, info.cap - ocupado);
      const rawPct  = info.cap > 0 ? ocupado / info.cap : 0;
      const pct     = Math.min(9.9999, Math.round(rawPct * 10000) / 10000);
      updates.push({ zona: info.zona, localizador: loc, ocupado, disponible, pct_ocupacion: pct });
      if (qty > 0) withStock++; else resetToZero++;
    }
    for (const loc of locKeys) { if (!dbMap[loc]) notInDB++; }

    log(
      `✓ Ocupación calculada:\n` +
      `  ${withStock} con stock · ${resetToZero} se resetean a vacío` +
      (notInDB > 0 ? `\n  ⚠ ${notInDB} del Excel no existen en BD` : "")
    );
    setProgress(48);

    // ── PASO 5: subir a BD en lotes paralelos ────────────────────
    const BATCH = 200; const PARALLEL = 5;
    let done = 0;
    for (let i = 0; i < updates.length; i += BATCH * PARALLEL) {
      const group = Array.from({ length: PARALLEL }, (_, j) =>
        updates.slice(i + j * BATCH, i + (j + 1) * BATCH)
      ).filter(b => b.length > 0);
      const results = await Promise.all(
        group.map(batch => db.from("localizadores").upsert(batch, { onConflict: "zona,localizador" }))
      );
      for (const { error } of results) { if (error) throw new Error(error.message); }
      done += group.reduce((s, b) => s + b.length, 0);
      setProgress(48 + Math.round((done / updates.length) * 40));
      setProgressLabel(`Actualizando BD… ${done}/${updates.length}`);
    }

    // ── PASO 5.5: importar inventario por subinventario via RPC ─────
    if (subInvItems.length > 0 && subInvArr.length > 0) {
      log(`⟳ Importando ${subInvItems.length} ítems a inventario (${subInvArr.length} subinventarios)…`);
      setProgressLabel("Importando inventario…");
      let invOk = 0, invErr = 0;
      for (const si of subInvArr) {
        const rows4si = subInvItems
          .filter(it => it.subinv === si)
          .map(it => ({
            codigo:          it.codigo        || "",
            descripcion:     it.descripcion   || null,
            lote:            it.lote          || null,
            localizador:     it.loc,
            pallets:         it.pallets,
            cajas:           it.cajas         ?? 0,
            cantidad_fisica: it.cantidad_fisica ?? null,
            formato:         it.formato        || null,
            cod_org_inv:     it.cod_org_inv    || null,
          }));
        if (!rows4si.length) continue;
        const { error: rpcErr } = await db.rpc("importar_subinventario", {
          p_subinventario: si,
          p_rows:          rows4si,
        });
        if (rpcErr) {
          log(`⚠ Inventario ${si}: ${rpcErr.message}`, "warn");
          invErr++;
        } else {
          invOk++;
        }
      }
      log(
        invErr === 0
          ? `✓ Inventario actualizado: ${subInvArr.length} subinventario${subInvArr.length > 1 ? "s" : ""} · ${subInvItems.length} registros`
          : `⚠ Inventario: ${invOk} OK · ${invErr} con error`,
        invErr === 0 ? "ok" : "warn"
      );
    }

    // ── PASO 6: guardar subinventarios en estado ──────────────────
    if (Object.keys(bySubInv).length > 0) {
      const normalizedBySubInv: Record<string, Record<string, number>> = {};
      for (const [si, locMap] of Object.entries(bySubInv)) {
        normalizedBySubInv[si] = {};
        for (const [loc, qty] of Object.entries(locMap)) {
          normalizedBySubInv[si][loc.toUpperCase()] = qty;
        }
      }
      setSubInvStock(normalizedBySubInv);
      setAllSubInvs(subInvArr);
      const prodKey = subInvArr.find(s =>
        s.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes("PRODUCCION")
      );
      if (prodKey) setSelectedSubInv(prodKey);
      log(`✓ ${subInvArr.length} subinventarios cargados para visualización`);
    }

    setProgress(90);
    setProgressLabel("Recargando mapa y catálogo…");

    // ── PASOS 6+7: loadMap y catálogo en paralelo ────────────────
    const allCodigos = [...new Set(subInvItems.map(it => it.codigo).filter((c): c is string => !!c))];
    const [, catResult] = await Promise.all([
      loadMap(),
      allCodigos.length > 0
        ? db.from("catalogo_productos").select("codigo,formato,cajas_por_pallet").in("codigo", allCodigos)
        : Promise.resolve({ data: null, error: null }),
    ]);
    const catData = catResult?.data;
    if (catData && catData.length > 0) {
      type CatEntry = { codigo: string; formato: string; cajas_por_pallet: number };
      const catMap: Record<string, CatEntry> = {};
      for (const c of catData as CatEntry[]) catMap[c.codigo] = c;
      let enriched = 0;
      for (const item of subInvItems) {
        const cat = item.codigo ? catMap[item.codigo] : undefined;
        if (!cat) continue;
        if (!item.formato && cat.formato) { item.formato = cat.formato; enriched++; }
      }
      log(enriched > 0
        ? `✓ Catálogo: ${enriched} formatos completados desde catalogo_productos`
        : `✓ Catálogo: ${catData.length} productos consultados (formatos ya presentes en Excel)`
      );
    }

    // ── PASO 8: Construir mapa por zona para selector ────────────
    const byZoneMap: Record<string, FileLocData[]> = {};
    for (const [loc, qty] of Object.entries(totalByLoc)) {
      if (qty === 0) continue;
      const dbInfo = dbMap[loc];
      if (!dbInfo) continue;
      const zona = dbInfo.zona;
      const siItem = subInvItems.find(it => it.loc === loc);
      const fmt = siItem?.formato || dbInfo.formato || "";
      if (!byZoneMap[zona]) byZoneMap[zona] = [];
      byZoneMap[zona].push({ loc, zona, formato: fmt, pallets: qty });
    }
    const zonesFound = Object.keys(byZoneMap).sort();
    setFileZones(zonesFound);
    setFileByZone(byZoneMap);
    setFileSubInvItems(subInvItems);
    setSelZone("all");
    setFormatRows([]);
    setUploadPhase("zoneSelect");

    // Construir localizadores completos desde datos ya en memoria (sin query extra)
    const locsParaPlan: Localizador[] = updates.map(u => ({
      zona: u.zona,
      localizador: u.localizador,
      formato: dbMap[u.localizador]?.formato || "",
      capacidad: dbMap[u.localizador]?.cap || 0,
      ocupado: u.ocupado,
      disponible: u.disponible,
      pct_ocupacion: u.pct_ocupacion,
    }));
    void handlePlanDiario(subInvItems, locsParaPlan);

    setProgress(100);
    setProgressLabel(`✅ ${withStock} con stock · ${zonesFound.length} zonas`);
    log(`✅ Archivo procesado: ${withStock} con stock, ${zonesFound.length} zonas. Selecciona zona y localizador para continuar.`, "ok");
    setLastImportInfo(`Stock · ${withStock} c/stock · ${new Date().toLocaleTimeString("es-EC")}`);
  }

} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  log("❌ " + msg, "err");
  setProgressLabel("❌ Error al procesar");
} finally {
  setImporting(false);
}
}
// ── Ir a tabla de formatos/destinos ────────────────────────────────────
function handleGoToFormat() {
  let items = selZone === "all"
    ? Object.values(fileByZone).flat()
    : fileByZone[selZone] || [];
  if (selLoc !== "all") {
    items = items.filter(d => d.loc.toUpperCase() === selLoc.toUpperCase());
  }
  setFormatRows(items.map((d, i) => ({ _id: i, ...d, locDest: "" })));
  setUploadPhase("formatCheck");
}
// ── Ejecutar plan para zona/localizador seleccionados ──────────────────
async function handleExecutePlan() {
  setLoadingPlan(true);
  setSortingPlan([]);
  setAnalisisData(null);
  try {
    let items = selZone === "all"
      ? fileSubInvItems
      : fileSubInvItems.filter(it => {
          const zoneEntry = fileByZone[selZone];
          return zoneEntry ? zoneEntry.some(l => l.loc === it.loc) : false;
        });
    if (selLoc !== "all") {
      items = items.filter(it => it.loc.toUpperCase() === selLoc.toUpperCase());
    }
    const { data: freshLocs } = await db
      .from("localizadores")
      .select("zona,localizador,capacidad,disponible,formato")
      .eq("activo", true);
    const resp = await fetch("/api/analisis-bpt/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, locations: freshLocs || [], fullAnalysis: true }),
    });
    const data = await resp.json();
    if (data.ok && data.plan) {
      setSortingPlan(data.plan as PlanEntry[]);
      setShowPlan(true);
      // Rellenar locDest en formatRows desde el plan
      const locDestMap: Record<string, string> = {};
      for (const entry of data.plan as PlanEntry[]) {
        for (const asig of entry.asignaciones) {
          if (!locDestMap[entry.lote]) locDestMap[entry.lote] = asig.loc;
        }
      }
      setFormatRows(prev => prev.map(r => {
        const related = (data.plan as PlanEntry[]).find(e =>
          e.asignaciones.some(a => a.loc === r.loc) || r.loc === r.loc
        );
        const suggestion = related?.asignaciones?.[0]?.loc ?? "";
        return r.locDest ? r : { ...r, locDest: suggestion };
      }));
      if (data.fragmentacion || data.alertas) {
        setAnalisisData({
          fragmentacion: data.fragmentacion ?? [],
          consolidaciones: data.consolidaciones ?? [],
          alertas: data.alertas ?? [],
          resumen_formatos: data.resumen_formatos ?? [],
          metricas: data.metricas ?? {},
        });
        setShowAnalisis(true);
      }
    }
  } catch {
    // plan error handled silently
  } finally {
    setLoadingPlan(false);
  }
}
// ── Organización Extrema ────────────────────────────────────────────────
async function handleConsolidacionExtrema() {
  setLoadingConsolidacion(true);
  setConsolidacionPlan(null);
  try {
    const allLocsDB = Object.values(allData).flat();
    const resp = await fetch("/api/consolidacion-extrema", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: fileSubInvItems,
        locations: allLocsDB,
        targetLoc: selLoc !== "all" ? selLoc : undefined,
      }),
    });
    const data = await resp.json();
    if (data.ok) {
      setConsolidacionPlan(data as ConsolidacionPlan);
      setShowConsolidacion(true);
    }
  } catch {
    // handled silently
  } finally {
    setLoadingConsolidacion(false);
  }
}
// ── Plan Diario Completo ────────────────────────────────────────────────────
async function handlePlanDiario(
  overrideItems?: SubInvItem[],
  overrideLocs?: Localizador[]
) {
  setLoadingDiario(true);
  setConsolidacionPlan(null);
  setPlanDiario(null);
  try {
    const items = overrideItems ?? fileSubInvItems;
    const locs = overrideLocs ?? Object.values(allData).flat();
    const resp = await fetch("/api/consolidacion-diaria", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, locations: locs }),
    });
    const data = await resp.json();
    if (data.ok) {
      setPlanDiario({
        zonas_ordenadas: data.zonas_ordenadas ?? [],
        zonas_sin_mapa: data.zonas_sin_mapa ?? [],
        total_mezclas: data.total_mezclas ?? 0,
        total_fragmentados: data.total_fragmentados ?? 0,
      });
      if (data.plan) {
        setConsolidacionPlan(data.plan as ConsolidacionPlan);
        setShowConsolidacion(true);
      }
    }
  } catch {
    // handled silently
  } finally {
    setLoadingDiario(false);
  }
}
// ── Datos para render ──────────────────────────────────────────────────
const zonasRender = useMemo(
  () => fZone === "all" ? Object.keys(allData) : [fZone].filter(z => allData[z]),
  [fZone, allData]
);
const allLocsFlat = useMemo(() => {
  const fst = fStatus;
  return allLocs
    .filter(d => {
      const p = d.pct_ocupacion;
      const ok = fst === "all" || (fst === "empty" && p <= 0) || (fst === "low" && p > 0 && p < 0.5) || (fst === "mid" && p >= 0.5 && p < 0.8) || (fst === "high" && p >= 0.8 && p <= 1.0) || (fst === "over" && p > 1.0);
      return ok && (fZone === "all" || d.zona === fZone) && (!fSearch || d.localizador.toUpperCase().includes(fSearch.toUpperCase()));
    })
    .sort((a, b) => a.zona.localeCompare(b.zona) || a.localizador.localeCompare(b.localizador));
}, [allLocs, fZone, fStatus, fSearch]);
const leyenda = useMemo(() => selectedSubInv === "all" ? [ { c: C.empty, l: "Vacío" }, { c: C.low, l: "<50%" }, { c: C.mid, l: "50–80%" }, { c: C.high, l: "81–99%" }, { c: C.full, l: "100%" }, { c: C.over, l: ">110%" }, ] : [ { c: S.available, l: "Libre (disponible)" }, { c: S.hasSubInv, l: `Tiene ${selectedSubInv}` }, { c: S.otherOcup, l: "Ocupado por otros" }, { c: S.full, l: "Exceso" }, ], [selectedSubInv]);
// Plan filtrado
const planFiltrado = useMemo(() => {
  if (!planFilter) return sortingPlan;
  const q = planFilter.toUpperCase();
  return sortingPlan.filter(p =>
    p.formato.includes(q) || p.lote.includes(q) ||
    p.asignaciones.some(a => a.loc.includes(q) || a.zona.includes(q))
  );
}, [sortingPlan, planFilter]);
// Agrupar plan por formato
const planByFormato = useMemo(() => {
  const m: Record<string, PlanEntry[]> = {};
  for (const e of planFiltrado) { if (!m[e.formato]) m[e.formato] = []; m[e.formato].push(e); }
  return m;
}, [planFiltrado]);
// ── Render ─────────────────────────────────────────────────────────────
return ( <div style={{ background: "#0f1117", minHeight: "100%", color: "#e8eaf0", fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
  {/* HEADER */}
  <div style={{ background: "#1a1d27", borderBottom: "1px solid #2e3247", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width: 34, height: 34, background: "#2563eb", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#fff" }}>WMS</div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Mapa de Planta — Ocupación Real</div>
        <div style={{ fontSize: 11, color: "#8b8fa8", marginTop: 1 }}>
          Análisis BPT
          {lastImportInfo && <span style={{ marginLeft: 8, color: "#4ade80" }}>· {lastImportInfo}</span>}
        </div>
      </div>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {connOk === null && <span style={{ fontSize: 11, padding: "4px 10px", borderRadius: 20, background: "#1e2235", color: "#8b8fa8", border: "1px solid #374151" }}>⏳ Conectando…</span>}
      {connOk === true  && <span style={{ fontSize: 11, padding: "4px 10px", borderRadius: 20, background: "#1a2e1a", color: "#4ade80", border: "1px solid #166534" }}>✓ Conectado</span>}
      {connOk === false && <span style={{ fontSize: 11, padding: "4px 10px", borderRadius: 20, background: "#2e1a1a", color: "#f87171", border: "1px solid #7f1d1d" }}>✗ Sin conexión</span>}
      {lastUpdate && <span style={{ fontSize: 11, color: "#5a5e75" }}>Actualizado: {lastUpdate}</span>}
    </div>
  </div>

  {/* UPLOAD */}
  <div
    onClick={() => fileRef.current?.click()}
    onDragOver={e => { e.preventDefault(); setDragging(true); }}
    onDragLeave={() => setDragging(false)}
    onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) { setUploadPhase("idle"); setFormatRows([]); processExcel(f); } }}
    style={{ margin: "14px 20px 0", border: `2px dashed ${dragging ? "#2563eb" : "#2e3247"}`, borderRadius: 10, padding: "13px 18px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", cursor: "pointer", background: dragging ? "rgba(37,99,235,.06)" : "transparent", transition: "border-color .2s" }}
  >
    <div style={{ fontSize: 24 }}>📂</div>
    <div style={{ flex: 1, minWidth: 220 }}>
      <div style={{ fontSize: 13, fontWeight: 500 }}>Subir Excel de stock o mapa de planta</div>
      <div style={{ fontSize: 11, color: "#8b8fa8", marginTop: 3, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span style={{ background: "#1e3a5f", color: "#60a5fa", padding: "1px 7px", borderRadius: 4 }}>Stock</span>
        PALLETS (ceil) + CAJAS (cada saldo=1 pos) → ocupación real · SUBINVENTARIO → plan distribución
        <span style={{ background: "#1a2e1a", color: "#4ade80", padding: "1px 7px", borderRadius: 4 }}>Mapa</span>
        hoja CAL_LOC
      </div>
    </div>
    <button onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}
      style={{ padding: "7px 16px", background: "#2563eb", border: "none", borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer", flexShrink: 0 }}>
      Seleccionar Excel
    </button>
    <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
      onChange={e => { const f = e.target.files?.[0]; if (f) { setUploadPhase("idle"); setFormatRows([]); processExcel(f); e.target.value = ""; } }} />
  </div>

  {/* PROGRESS + LOG */}
  {(importing || progressLabel) && (
    <div style={{ margin: "8px 20px 0" }}>
      <div style={{ height: 5, background: "#222535", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", background: importing ? "#2563eb" : "#22c55e", borderRadius: 3, width: `${progress}%`, transition: "width .3s" }} />
      </div>
      <div style={{ fontSize: 11, color: "#8b8fa8", marginTop: 4 }}>{progressLabel || "Procesando…"}</div>
    </div>
  )}
  {importLog.length > 0 && (
    <div ref={logRef} style={{ margin: "8px 20px 0", background: "#1a1d27", border: "1px solid #2e3247", borderRadius: 8, padding: "10px 14px", fontSize: 11, maxHeight: 155, overflowY: "auto", fontFamily: "monospace" }}>
      {importLog.map((l, i) => (
        <div key={i} style={{ color: l.cls === "ok" ? "#4ade80" : l.cls === "err" ? "#f87171" : l.cls === "warn" ? "#fbbf24" : "#c8cad8", marginBottom: 2, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{l.msg}</div>
      ))}
    </div>
  )}

  {/* ── SELECTOR DE ZONA + LOCALIZADOR ────────────────────────────────── */}
  {uploadPhase === "zoneSelect" && fileZones.length > 0 && (() => {
    const locOptions = selZone === "all"
      ? Object.values(fileByZone).flat()
      : fileByZone[selZone] || [];
    const locItems = selLoc !== "all"
      ? fileSubInvItems.filter(it => it.loc.toUpperCase() === selLoc.toUpperCase())
      : [];
    return (
    <div style={{ margin: "10px 20px 0", background: "#0d1a2b", border: "1px solid #1d4ed8", borderRadius: 10, padding: "14px 18px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#93c5fd", marginBottom: 10 }}>
        ✓ Archivo leído · {fileZones.length} zonas · {fileSubInvItems.length} ítems · Selecciona zona y localizador
      </div>

      {/* Selectores */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 10, color: "#5a5e75", marginBottom: 4, letterSpacing: 1 }}>ZONA</div>
          <select value={selZone} onChange={e => { setSelZone(e.target.value); setSelLoc("all"); }}
            style={{ fontSize: 12, padding: "6px 10px", border: "1px solid #2563eb", borderRadius: 6, background: "#0f1117", color: "#e8eaf0", outline: "none", minWidth: 160 }}>
            <option value="all">Todas las zonas</option>
            {fileZones.map(z => (
              <option key={z} value={z}>{z} ({fileByZone[z]?.length ?? 0} loc)</option>
            ))}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#5a5e75", marginBottom: 4, letterSpacing: 1 }}>LOCALIZADOR</div>
          <select value={selLoc} onChange={e => setSelLoc(e.target.value)}
            style={{ fontSize: 12, padding: "6px 10px", border: "1px solid #7c3aed", borderRadius: 6, background: "#0f1117", color: "#e8eaf0", outline: "none", minWidth: 180 }}>
            <option value="all">Todos los localizadores</option>
            {locOptions.map(l => (
              <option key={l.loc} value={l.loc}>{l.loc} · {l.pallets} plt</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => void handlePlanDiario()} disabled={loadingDiario || fileSubInvItems.length === 0}
            style={{ padding: "7px 18px", background: loadingDiario ? "#7f1d1d" : "#dc2626", border: "none", borderRadius: 7, color: "#fff", fontSize: 12, fontWeight: 700, cursor: loadingDiario ? "wait" : "pointer" }}>
            {loadingDiario ? "⟳ Analizando zonas…" : "🔴 Plan Diario Completo"}
          </button>
          <button onClick={handleGoToFormat}
            style={{ padding: "7px 16px", background: "#2563eb", border: "none", borderRadius: 7, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Plan distribución →
          </button>
          <button onClick={handleConsolidacionExtrema} disabled={loadingConsolidacion || fileSubInvItems.length === 0}
            style={{ padding: "7px 12px", background: loadingConsolidacion ? "#3b0764" : "#7c3aed", border: "none", borderRadius: 7, color: "#fff", fontSize: 12, fontWeight: 700, cursor: loadingConsolidacion ? "wait" : "pointer" }}>
            {loadingConsolidacion ? "⟳" : "⚡ Zona"}
          </button>
          <button onClick={() => { setUploadPhase("idle"); setConsolidacionPlan(null); setPlanDiario(null); }}
            style={{ padding: "7px 12px", background: "transparent", border: "1px solid #374151", borderRadius: 7, color: "#5a5e75", fontSize: 12, cursor: "pointer" }}>
            Cancelar
          </button>
        </div>
      </div>

      {/* Preview del localizador seleccionado */}
      {selLoc !== "all" && locItems.length > 0 && (
        <div style={{ background: "#0f1117", border: "1px solid #3b0764", borderRadius: 8, padding: "10px 14px", marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#a78bfa", marginBottom: 6 }}>
            Contenido de {selLoc} · {locItems.length} ítems
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {locItems.map((it, i) => (
              <div key={i} style={{ background: "#1a1d27", border: "1px solid #2e3247", borderRadius: 5, padding: "4px 8px", fontSize: 11 }}>
                <span style={{ color: "#60a5fa", fontWeight: 600 }}>{it.codigo || "—"}</span>
                <span style={{ color: "#5a5e75" }}> / </span>
                <span style={{ color: "#c4b5fd" }}>L:{it.lote || "—"}</span>
                <span style={{ color: "#5a5e75" }}> · </span>
                <span style={{ color: "#4ade80", fontWeight: 700 }}>{it.pallets} plt</span>
                {it.formato && <span style={{ color: "#5a5e75", marginLeft: 4, fontSize: 10 }}>[{it.formato}]</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Chips de zonas */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {fileZones.map(z => (
          <span key={z} onClick={() => { setSelZone(z); setSelLoc("all"); }}
            style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, cursor: "pointer",
              background: selZone === z ? "#1d4ed8" : "#1e2235",
              color: selZone === z ? "#93c5fd" : "#5a5e75",
              border: selZone === z ? "1px solid #2563eb" : "1px solid #2e3247" }}>
            {z} · {fileByZone[z]?.length ?? 0}
          </span>
        ))}
      </div>
    </div>
    );
  })()}

  {/* ── TABLA DE FORMATOS Y LOCALIZADOR DESTINO ─────────────────────────── */}
  {uploadPhase === "formatCheck" && formatRows.length > 0 && (
    <div style={{ margin: "10px 20px 0", background: "#0d1117", border: "1px solid #2e3247", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ background: "#1a1d27", padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#e8eaf0" }}>
            Formatos y localizador destino
            {selZone !== "all" && <span style={{ fontSize: 11, color: "#60a5fa", marginLeft: 8 }}>· {selZone}</span>}
          </div>
          <div style={{ fontSize: 11, color: "#5a5e75", marginTop: 2 }}>{formatRows.length} localizadores con stock · edita el destino antes de ejecutar</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setUploadPhase("zoneSelect")}
            style={{ padding: "6px 12px", background: "transparent", border: "1px solid #374151", borderRadius: 6, color: "#5a5e75", fontSize: 11, cursor: "pointer" }}>
            ← Cambiar zona
          </button>
          <button onClick={handleExecutePlan} disabled={loadingPlan}
            style={{ padding: "6px 16px", background: loadingPlan ? "#1d3a6e" : "#2563eb", border: "none", borderRadius: 6, color: "#fff", fontSize: 12, fontWeight: 700, cursor: loadingPlan ? "wait" : "pointer" }}>
            {loadingPlan ? "⟳ Generando sugerencias…" : "Ejecutar y ver sugerencias →"}
          </button>
        </div>
      </div>
      <div style={{ overflowX: "auto", maxHeight: 340, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead style={{ position: "sticky", top: 0, zIndex: 1 }}>
            <tr style={{ background: "#111827", borderBottom: "1px solid #2e3247" }}>
              {["LOCALIZADOR", "ZONA", "FORMATO", "PALLETS", "LOCALIZADOR DESTINO"].map(h => (
                <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "#5a5e75", fontWeight: 600, fontSize: 10, letterSpacing: 1, whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {formatRows.map((r, i) => (
              <tr key={r._id} style={{ borderBottom: "1px solid #1e2235", background: i % 2 === 0 ? "transparent" : "#0d1117" }}>
                <td style={{ padding: "6px 12px", fontWeight: 600, color: "#e8eaf0" }}>{r.loc}</td>
                <td style={{ padding: "6px 12px", color: "#8b8fa8", fontSize: 11 }}>{r.zona}</td>
                <td style={{ padding: "6px 12px" }}>
                  {r.formato
                    ? <span style={{ background: "#1e3a5f", color: "#60a5fa", padding: "2px 8px", borderRadius: 4, fontSize: 11 }}>{r.formato}</span>
                    : <span style={{ color: "#374151" }}>—</span>}
                </td>
                <td style={{ padding: "6px 12px", textAlign: "right", color: "#4ade80", fontWeight: 700 }}>{r.pallets}</td>
                <td style={{ padding: "6px 8px" }}>
                  <input
                    value={r.locDest}
                    onChange={e => setFormatRows(prev => prev.map(x => x._id === r._id ? { ...x, locDest: e.target.value.toUpperCase() } : x))}
                    placeholder="Sugerencia al ejecutar…"
                    style={{ fontSize: 11, padding: "4px 8px", border: `1px solid ${r.locDest ? "#22c55e" : "#2e3247"}`, borderRadius: 5, background: "#0f1117", color: "#e8eaf0", outline: "none", width: 160, fontFamily: "monospace" }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )}

  <div style={{ padding: "14px 20px" }}>

    {/* Stats */}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
      {loading
        ? Array(6).fill(0).map((_, i) => <div key={i} style={{ flex: 1, minWidth: 90, height: 62, background: "#222535", borderRadius: 8, animation: "pulse 1.5s infinite" }} />)
        : stats.map(s => (
            <div key={s.l} style={{ background: "#1a1d27", border: "1px solid #2e3247", borderRadius: 8, padding: "9px 12px", flex: 1, minWidth: 90, textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{s.v}</div>
              <div style={{ fontSize: 10, color: "#8b8fa8", marginTop: 2 }}>{s.l}</div>
            </div>
          ))}
    </div>

    {/* ── SELECTOR SUBINVENTARIO ─────────────────────────────────── */}
    {allSubInvs.length > 0 && (
      <div style={{ background: "#1a1d27", border: "1px solid #2e3247", borderRadius: 10, padding: "13px 16px", marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: "#e8eaf0", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ background: "#2563eb", borderRadius: 4, padding: "2px 8px", fontSize: 11 }}>📦 Ver por subinventario</span>
          <span style={{ color: "#5a5e75", fontWeight: 400, fontSize: 11 }}>Selecciona para ver dónde tiene productos y dónde hay espacio</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={() => setSelectedSubInv("all")}
            style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid", transition: "all .15s",
              background: selectedSubInv === "all" ? "#2563eb" : "#222535",
              borderColor: selectedSubInv === "all" ? "#2563eb" : "#374151",
              color: selectedSubInv === "all" ? "#fff" : "#8b8fa8" }}>
            Ocupación total
          </button>
          {allSubInvs.map(si => {
            const isSelected = selectedSubInv === si;
            const isProd = si.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes("PRODUCCION");
            return (
              <button key={si} onClick={() => setSelectedSubInv(si)}
                style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid", transition: "all .15s",
                  background: isSelected ? (isProd ? "#166534" : "#1e3a5f") : "#222535",
                  borderColor: isSelected ? (isProd ? "#22c55e" : "#60a5fa") : "#374151",
                  color: isSelected ? (isProd ? "#4ade80" : "#93c5fd") : "#8b8fa8" }}>
                {si}
              </button>
            );
          })}
        </div>

        {selectedSubInv !== "all" && subInvStats && (
          <div style={{ marginTop: 10, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ background: "#0f1117", borderRadius: 7, padding: "8px 14px", fontSize: 12 }}>
              <span style={{ color: "#8b8fa8" }}>Loc con </span>
              <strong style={{ color: "#60a5fa" }}>{selectedSubInv}</strong>
              <span style={{ fontSize: 18, fontWeight: 700, display: "block", color: "#60a5fa" }}>{subInvStats.locs}</span>
            </div>
            <div style={{ background: "#0f1117", borderRadius: 7, padding: "8px 14px", fontSize: 12 }}>
              <span style={{ color: "#8b8fa8" }}>Pallets totales</span>
              <span style={{ fontSize: 18, fontWeight: 700, display: "block" }}>{subInvStats.total.toLocaleString()}</span>
            </div>
            <div style={{ background: "#0f1117", borderRadius: 7, padding: "8px 14px", fontSize: 12 }}>
              <span style={{ color: "#8b8fa8" }}>Ubicaciones libres</span>
              <span style={{ fontSize: 18, fontWeight: 700, display: "block", color: "#4ade80" }}>
                {allLocs.filter(d => (d.ocupado || 0) === 0).length}
              </span>
            </div>
            <div style={{ background: "#0f1117", borderRadius: 7, padding: "8px 14px", fontSize: 12 }}>
              <span style={{ color: "#8b8fa8" }}>Ocupados por otros</span>
              <span style={{ fontSize: 18, fontWeight: 700, display: "block", color: "#9ca3af" }}>
                {allLocs.filter(d => (d.ocupado || 0) > 0 && !((subInvMap ?? {})[d.localizador.toUpperCase()])).length}
              </span>
            </div>
          </div>
        )}
      </div>
    )}

    {/* ── PANEL DE CRITICIDAD DIARIA ─────────────────────────────────── */}
    {(planDiario || loadingDiario) && (
      <div style={{ background: "#0f0808", border: "1px solid #dc2626", borderRadius: 10, marginBottom: 12, overflow: "hidden" }}>
        <div style={{ background: "#1a0808", padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>🔴</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fca5a5" }}>Evaluación Diaria — Zonas por Criticidad</div>
              <div style={{ fontSize: 11, color: "#f87171", marginTop: 1 }}>Zonas con más mezclas se ejecutan primero · Plan automático completo</div>
            </div>
          </div>
          {planDiario && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 11, background: "#450a0a", color: "#fca5a5", padding: "3px 10px", borderRadius: 5 }}>{planDiario.total_mezclas} mezclas</span>
              <span style={{ fontSize: 11, background: "#1e1a0a", color: "#fbbf24", padding: "3px 10px", borderRadius: 5 }}>{planDiario.total_fragmentados} fragmentados</span>
              {planDiario.zonas_sin_mapa.length > 0 && (
                <span style={{ fontSize: 11, background: "#1e1a0a", color: "#fbbf24", padding: "3px 10px", borderRadius: 5 }}>⚠ {planDiario.zonas_sin_mapa.length} sin mapa</span>
              )}
              <span style={{ fontSize: 11, background: "#1a2e1a", color: "#4ade80", padding: "3px 10px", borderRadius: 5 }}>{planDiario.zonas_ordenadas.length} zonas analizadas</span>
            </div>
          )}
        </div>

        {loadingDiario && (
          <div style={{ padding: "24px", textAlign: "center", color: "#fca5a5", fontSize: 13 }}>
            ⟳ Evaluando criticidad de todas las zonas y generando plan diario…
          </div>
        )}

        {planDiario && (
          <div style={{ padding: "12px 16px" }}>
            {/* Localizadores sin mapa */}
            {planDiario.zonas_sin_mapa.length > 0 && (
              <div style={{ background: "#1a1100", border: "1px solid #92400e", borderRadius: 7, padding: "8px 12px", marginBottom: 10, fontSize: 11 }}>
                <span style={{ color: "#fbbf24", fontWeight: 700 }}>⚠ {planDiario.zonas_sin_mapa.length} localizadores sin mapa</span>
                <span style={{ color: "#78716c", marginLeft: 8 }}>— No existen en BD, crear esta semana para incluirlos en el análisis</span>
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {planDiario.zonas_sin_mapa.slice(0, 30).map(loc => (
                    <span key={loc} style={{ background: "#292218", border: "1px solid #92400e", borderRadius: 3, padding: "2px 6px", color: "#d97706", fontSize: 10 }}>{loc}</span>
                  ))}
                  {planDiario.zonas_sin_mapa.length > 30 && (
                    <span style={{ color: "#78716c", fontSize: 10, alignSelf: "center" }}>+{planDiario.zonas_sin_mapa.length - 30} más</span>
                  )}
                </div>
              </div>
            )}

            {/* Tabla de zonas por criticidad */}
            {planDiario.zonas_ordenadas.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "#1a0808", borderBottom: "1px solid #7f1d1d" }}>
                      {["#", "ZONA", "NIVEL", "MEZCLAS", "FRAGMENTADOS", "PLT MEZCLA", "PLT FRAG.", "SCORE"].map(h => (
                        <th key={h} style={{ padding: "7px 12px", textAlign: "left", color: "#5a5e75", fontWeight: 600, fontSize: 10, letterSpacing: 1, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {planDiario.zonas_ordenadas.map((z, i) => {
                      const nc = z.nivel === "CRITICO" ? "#f87171" : z.nivel === "ALTO" ? "#fb923c" : z.nivel === "MEDIO" ? "#fbbf24" : "#4ade80";
                      const nb = z.nivel === "CRITICO" ? "#450a0a" : z.nivel === "ALTO" ? "#431407" : z.nivel === "MEDIO" ? "#1e1a0a" : "#1a2e1a";
                      return (
                        <tr key={z.zona} style={{ borderBottom: "1px solid #1e1010", background: i % 2 === 0 ? "transparent" : "#0d0808" }}>
                          <td style={{ padding: "6px 12px", color: "#5a5e75", fontWeight: 700, fontSize: 11 }}>{i + 1}</td>
                          <td style={{ padding: "6px 12px", fontWeight: 700, color: "#e8eaf0" }}>{z.zona}</td>
                          <td style={{ padding: "6px 12px" }}>
                            <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 3, fontWeight: 700, background: nb, color: nc }}>{z.nivel}</span>
                          </td>
                          <td style={{ padding: "6px 12px", textAlign: "right", color: z.num_locs_mezcladas > 0 ? "#f87171" : "#4ade80", fontWeight: z.num_locs_mezcladas > 0 ? 700 : 400 }}>{z.num_locs_mezcladas}</td>
                          <td style={{ padding: "6px 12px", textAlign: "right", color: z.num_codigos_fragmentados > 0 ? "#fbbf24" : "#4ade80", fontWeight: z.num_codigos_fragmentados > 0 ? 700 : 400 }}>{z.num_codigos_fragmentados}</td>
                          <td style={{ padding: "6px 12px", textAlign: "right", color: "#e8eaf0" }}>{z.pallets_en_mezcla}</td>
                          <td style={{ padding: "6px 12px", textAlign: "right", color: "#e8eaf0" }}>{z.pallets_fragmentados}</td>
                          <td style={{ padding: "6px 12px", textAlign: "right", color: nc, fontWeight: 700 }}>{z.score_criticidad}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ textAlign: "center", color: "#4ade80", fontSize: 13, padding: 16 }}>
                ✓ Todas las zonas están limpias. Sin mezclas ni fragmentación.
              </div>
            )}
          </div>
        )}
      </div>
    )}

    {/* ── PLAN DE ORGANIZACIÓN EXTREMA ──────────────────────────────── */}
    {(consolidacionPlan || loadingConsolidacion) && (
      <div style={{ background: "#0d0a1a", border: "1px solid #7c3aed", borderRadius: 10, marginBottom: 12, overflow: "hidden" }}>
        <div style={{ background: "#1e0a3c", padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16 }}>⚡</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#c4b5fd" }}>Plan de Organización Extrema</div>
              <div style={{ fontSize: 11, color: "#a78bfa", marginTop: 1 }}>
                {planDiario ? "Plan diario · todas las zonas" : selLoc !== "all" ? `Anclado en ${selLoc}` : "Todas las zonas"} · Fase 1: Liberar mezclas · Fase 2: Consolidar lotes
              </div>
            </div>
          </div>
          {consolidacionPlan && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, background: "#4c1d95", color: "#c4b5fd", padding: "3px 10px", borderRadius: 5 }}>
                {consolidacionPlan.resumen.total_movimientos} movimientos
              </span>
              <span style={{ fontSize: 11, background: "#1a2e1a", color: "#4ade80", padding: "3px 10px", borderRadius: 5 }}>
                {consolidacionPlan.resumen.pallets_movidos} plt
              </span>
              <span style={{ fontSize: 11, background: "#1e1a0a", color: "#fbbf24", padding: "3px 10px", borderRadius: 5 }}>
                {consolidacionPlan.resumen.locs_liberadas_count} loc liberadas
              </span>
              {consolidacionPlan.resumen.sin_espacio_count > 0 && (
                <span style={{ fontSize: 11, background: "#2e1a1a", color: "#f87171", padding: "3px 10px", borderRadius: 5 }}>
                  ⚠ {consolidacionPlan.resumen.sin_espacio_count} sin espacio
                </span>
              )}
              <button onClick={() => setShowConsolidacion(!showConsolidacion)}
                style={{ padding: "4px 12px", fontSize: 11, border: "1px solid #7c3aed", borderRadius: 6, background: showConsolidacion ? "#7c3aed" : "#0f1117", color: "#fff", cursor: "pointer" }}>
                {showConsolidacion ? "Ocultar" : "Ver plan"}
              </button>
            </div>
          )}
        </div>

        {loadingConsolidacion && (
          <div style={{ padding: "20px", textAlign: "center", color: "#a78bfa", fontSize: 13 }}>
            ⟳ El cerebro está calculando la organización óptima…
          </div>
        )}

        {showConsolidacion && consolidacionPlan && consolidacionPlan.movimientos.length > 0 && (
          <div style={{ padding: "12px 16px" }}>
            {/* Resumen de fases */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              {[
                { label: "Fase 1: Liberar mezclas", count: consolidacionPlan.resumen.fase_liberar, color: "#fbbf24", bg: "#1e1a0a" },
                { label: "Fase 2: Consolidar lotes", count: consolidacionPlan.resumen.fase_consolidar, color: "#4ade80", bg: "#1a2e1a" },
                { label: "Lotes consolidados", count: consolidacionPlan.resumen.lotes_consolidados, color: "#60a5fa", bg: "#0f1a2e" },
              ].map(s => (
                <div key={s.label} style={{ background: s.bg, borderRadius: 7, padding: "6px 14px", fontSize: 12 }}>
                  <span style={{ color: "#8b8fa8" }}>{s.label}: </span>
                  <span style={{ color: s.color, fontWeight: 700 }}>{s.count}</span>
                </div>
              ))}
            </div>

            {/* Lista de movimientos */}
            <div style={{ maxHeight: 500, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead style={{ position: "sticky", top: 0, zIndex: 1 }}>
                  <tr style={{ background: "#0d0a1a", borderBottom: "1px solid #3b0764" }}>
                    {["#", "TIPO", "CÓDIGO", "LOTE", "PLT", "FORMATO", "ORIGEN", "DESTINO", "RAZÓN"].map(h => (
                      <th key={h} style={{ padding: "6px 10px", textAlign: "left", color: "#5a5e75", fontWeight: 600, fontSize: 10, letterSpacing: 1, whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {consolidacionPlan.movimientos.map((m, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #1e1a2e", background: m.tipo === "liberar" ? "rgba(251,191,36,.04)" : "rgba(74,222,128,.04)" }}>
                      <td style={{ padding: "5px 10px", color: "#5a5e75", fontWeight: 700, fontSize: 10 }}>{m.paso}</td>
                      <td style={{ padding: "5px 10px" }}>
                        <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 3, fontWeight: 700,
                          background: m.tipo === "liberar" ? "#1e1a0a" : "#1a2e1a",
                          color: m.tipo === "liberar" ? "#fbbf24" : "#4ade80" }}>
                          {m.tipo === "liberar" ? "LIBERAR" : "CONSOLIDAR"}
                        </span>
                      </td>
                      <td style={{ padding: "5px 10px", color: "#60a5fa", fontWeight: 600 }}>{m.codigo}</td>
                      <td style={{ padding: "5px 10px", color: "#c4b5fd", fontSize: 10 }}>{m.lote}</td>
                      <td style={{ padding: "5px 10px", color: "#4ade80", fontWeight: 700, textAlign: "right" }}>{m.pallets}</td>
                      <td style={{ padding: "5px 10px", color: "#8b8fa8", fontSize: 10 }}>{m.formato || "—"}</td>
                      <td style={{ padding: "5px 10px" }}>
                        <span style={{ color: "#f87171", fontWeight: 600 }}>{m.loc_origen}</span>
                        <span style={{ color: "#374151", fontSize: 10 }}> {m.zona_origen}</span>
                      </td>
                      <td style={{ padding: "5px 10px" }}>
                        <span style={{ color: "#4ade80", fontWeight: 600 }}>{m.loc_destino}</span>
                        <span style={{ color: "#374151", fontSize: 10 }}> {m.zona_destino}</span>
                      </td>
                      <td style={{ padding: "5px 10px", color: "#5a5e75", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.razon}>{m.razon}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Sin espacio */}
            {consolidacionPlan.sin_espacio.length > 0 && (
              <div style={{ marginTop: 10, background: "#1a0a0a", border: "1px solid #7f1d1d", borderRadius: 8, padding: "10px 14px" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#f87171", marginBottom: 6 }}>
                  ⚠ Ítems sin espacio disponible ({consolidacionPlan.sin_espacio.length})
                </div>
                {consolidacionPlan.sin_espacio.map((s, i) => (
                  <div key={i} style={{ fontSize: 11, color: "#fca5a5", marginBottom: 3, paddingLeft: 8 }}>
                    <span style={{ color: "#60a5fa" }}>{s.codigo}</span>/{s.lote} · {s.pallets} plt desde {s.loc_origen} — {s.motivo}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {showConsolidacion && consolidacionPlan && consolidacionPlan.movimientos.length === 0 && (
          <div style={{ padding: "20px", textAlign: "center", color: "#4ade80", fontSize: 13 }}>
            ✓ El almacén ya está perfectamente organizado. No se requieren movimientos.
          </div>
        )}
      </div>
    )}

    {/* ── PLAN DE DISTRIBUCIÓN PRODUCCION ─────────────────────────── */}
    {(sortingPlan.length > 0 || loadingPlan) && (
      <div style={{ background: "#0d1a2b", border: "1px solid #1d4ed8", borderRadius: 10, marginBottom: 12, overflow: "hidden" }}>
        {/* Header del plan */}
        <div style={{ background: "#1e3a5f", padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16 }}>🗂</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#93c5fd" }}>Plan de Distribución — PRODUCCION</div>
              <div style={{ fontSize: 11, color: "#60a5fa", marginTop: 1 }}>
                Algoritmo greedy · prioriza mismo formato · ordena por formato y lote
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {!loadingPlan && (
              <input
                value={planFilter}
                onChange={e => setPlanFilter(e.target.value.toUpperCase())}
                placeholder="Filtrar formato / lote / loc…"
                style={{ fontSize: 11, padding: "5px 10px", border: "1px solid #2563eb", borderRadius: 6, background: "#0f1117", color: "#e8eaf0", outline: "none", width: 190 }}
              />
            )}
            <button
              onClick={() => setShowPlan(!showPlan)}
              style={{ padding: "5px 12px", fontSize: 12, border: "1px solid #2563eb", borderRadius: 6, background: showPlan ? "#2563eb" : "#0f1117", color: "#fff", cursor: "pointer" }}>
              {showPlan ? "Ocultar" : "Ver plan"}
            </button>
          </div>
        </div>

        {loadingPlan && (
          <div style={{ padding: "20px", textAlign: "center", color: "#60a5fa", fontSize: 13 }}>
            ⟳ Calculando plan de distribución…
          </div>
        )}

        {showPlan && !loadingPlan && (
          <div style={{ padding: "12px 16px", maxHeight: 480, overflowY: "auto" }}>
            {Object.keys(planByFormato).length === 0 ? (
              <div style={{ color: "#5a5e75", fontSize: 12, textAlign: "center", padding: 20 }}>Sin resultados para el filtro</div>
            ) : (
              Object.entries(planByFormato).map(([formato, entries]) => {
                const totalNeed = entries.reduce((s, e) => s + e.palletsNeed, 0);
                const totalAsig = entries.reduce((s, e) => s + e.palletsAsignados, 0);
                const totalRest = entries.reduce((s, e) => s + e.palletsRestantes, 0);
                return (
                  <div key={formato} style={{ marginBottom: 16 }}>
                    {/* Header formato */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, borderBottom: "1px solid #1d4ed8", paddingBottom: 6 }}>
                      <span style={{ background: "#1d4ed8", color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 10px", borderRadius: 4 }}>
                        FORMATO: {formato}
                      </span>
                      <span style={{ fontSize: 11, color: "#60a5fa" }}>{entries.length} lotes</span>
                      <span style={{ fontSize: 11, color: "#e8eaf0" }}>{totalNeed} pallets necesarios</span>
                      {totalRest > 0
                        ? <span style={{ fontSize: 11, color: "#f87171", background: "#2e1a1a", padding: "1px 7px", borderRadius: 4 }}>⚠ {totalRest} sin espacio</span>
                        : <span style={{ fontSize: 11, color: "#4ade80", background: "#1a2e1a", padding: "1px 7px", borderRadius: 4 }}>✓ {totalAsig} asignados</span>
                      }
                    </div>

                    {/* Lotes del formato */}
                    {entries.map((entry, ei) => (
                      <div key={ei} style={{ marginLeft: 12, marginBottom: 10, background: "#0f1117", borderRadius: 7, padding: "10px 12px", border: "1px solid #1e3a5f" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 11, color: "#93c5fd", fontWeight: 600 }}>Lote: {entry.lote}</span>
                          <span style={{ fontSize: 11, color: "#8b8fa8" }}>{entry.palletsNeed} pallets</span>
                          {entry.palletsRestantes > 0 && (
                            <span style={{ fontSize: 10, background: "#2e1a1a", color: "#f87171", padding: "1px 6px", borderRadius: 3 }}>
                              {entry.palletsRestantes} sin asignar
                            </span>
                          )}
                        </div>

                        {/* Ubicaciones asignadas */}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                          {entry.asignaciones.map((a, ai) => (
                            <div key={ai} style={{
                              background: "#1e3a5f", border: "1px solid #2563eb", borderRadius: 5,
                              padding: "4px 8px", fontSize: 11, display: "flex", alignItems: "center", gap: 5
                            }}>
                              <span style={{ color: "#60a5fa", fontWeight: 600 }}>{a.loc}</span>
                              <span style={{ color: "#5a5e75" }}>·</span>
                              <span style={{ color: "#8b8fa8", fontSize: 10 }}>{a.zona}</span>
                              <span style={{ color: "#5a5e75" }}>·</span>
                              <span style={{ color: "#4ade80", fontWeight: 700 }}>{a.palletsAsignados} plt</span>
                            </div>
                          ))}
                          {entry.asignaciones.length === 0 && (
                            <span style={{ fontSize: 11, color: "#f87171" }}>Sin ubicaciones disponibles</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    )}

    {/* ── ANÁLISIS COMPLETO DE BODEGA ────────────────────────────────── */}
    {analisisData && (
      <div style={{ marginBottom: 12 }}>

        {/* Alertas */}
        {analisisData.alertas.length > 0 && (
          <div style={{ background: "#1a1117", border: "1px solid #7f1d1d", borderRadius: 10, marginBottom: 8, overflow: "hidden" }}>
            <div style={{ background: "#2e1a1a", padding: "8px 14px", fontSize: 12, fontWeight: 700, color: "#fca5a5", display: "flex", alignItems: "center", gap: 8 }}>
              <span>⚠ Alertas de bodega</span>
              <span style={{ background: "#7f1d1d", color: "#fca5a5", padding: "1px 8px", borderRadius: 10, fontSize: 10 }}>{analisisData.alertas.length}</span>
            </div>
            <div style={{ padding: "8px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
              {analisisData.alertas.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11 }}>
                  <span style={{ color: a.nivel === "critico" ? "#f87171" : "#fbbf24", fontWeight: 700, flexShrink: 0 }}>
                    {a.nivel === "critico" ? "●" : "◦"}
                  </span>
                  <div>
                    <span style={{ color: a.nivel === "critico" ? "#fca5a5" : "#fde68a" }}>{a.mensaje}</span>
                    {a.detalle && <span style={{ color: "#5a5e75", marginLeft: 6 }}>— {a.detalle}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <button onClick={() => setShowAnalisis(!showAnalisis)}
          style={{ fontSize: 11, padding: "5px 14px", background: showAnalisis ? "#1e3a5f" : "#222535", border: "1px solid #2563eb", borderRadius: 6, color: "#60a5fa", cursor: "pointer", marginBottom: 8 }}>
          {showAnalisis ? "▲ Ocultar análisis detallado" : "▼ Ver análisis completo (fragmentación · consolidación · formatos)"}
        </button>

        {showAnalisis && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>

            {/* Fragmentación */}
            {analisisData.fragmentacion.length > 0 && (
              <div style={{ background: "#0d1117", border: "1px solid #2e3247", borderRadius: 9, padding: "12px 14px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#93c5fd", marginBottom: 10 }}>
                  Fragmentación por formato
                  <span style={{ fontSize: 10, color: "#5a5e75", fontWeight: 400, marginLeft: 6 }}>cuántos localizadores ocupa cada formato</span>
                </div>
                {analisisData.fragmentacion.map((f, i) => {
                  const col = f.nivel === "critico" ? "#f87171" : f.nivel === "fragmentado" ? "#fbbf24" : f.nivel === "aceptable" ? "#60a5fa" : "#4ade80";
                  return (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid #1e2235", fontSize: 11 }}>
                      <span style={{ color: "#e8eaf0", maxWidth: "55%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.formato}</span>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ color: "#8b8fa8" }}>{f.total_pallets} plt</span>
                        <span style={{ color: col, fontWeight: 700 }}>{f.num_localizadores} locs</span>
                        <span style={{ background: col + "33", color: col, padding: "1px 6px", borderRadius: 3, fontSize: 10 }}>{f.nivel}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Resumen por formato */}
            {analisisData.resumen_formatos.length > 0 && (
              <div style={{ background: "#0d1117", border: "1px solid #2e3247", borderRadius: 9, padding: "12px 14px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#93c5fd", marginBottom: 10 }}>
                  Cobertura por formato
                  <span style={{ fontSize: 10, color: "#5a5e75", fontWeight: 400, marginLeft: 6 }}>% pallets en locs del mismo formato</span>
                </div>
                {analisisData.resumen_formatos.map((r, i) => (
                  <div key={i} style={{ padding: "5px 0", borderBottom: "1px solid #1e2235", fontSize: 11 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ color: "#e8eaf0", maxWidth: "55%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.formato}</span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <span style={{ color: "#8b8fa8" }}>{r.total_pallets} plt</span>
                        {r.m2_estimado && <span style={{ color: "#5a5e75" }}>{r.m2_estimado}m²</span>}
                        <span style={{ color: r.cobertura_pct >= 80 ? "#4ade80" : r.cobertura_pct >= 50 ? "#fbbf24" : "#f87171", fontWeight: 700 }}>{r.cobertura_pct}%</span>
                      </div>
                    </div>
                    <div style={{ height: 3, background: "#1e2235", borderRadius: 2 }}>
                      <div style={{ height: "100%", width: `${Math.min(100, r.cobertura_pct)}%`, background: r.cobertura_pct >= 80 ? "#4ade80" : r.cobertura_pct >= 50 ? "#fbbf24" : "#f87171", borderRadius: 2 }} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Sugerencias de consolidación */}
            {analisisData.consolidaciones.length > 0 && (
              <div style={{ background: "#0d1117", border: "1px solid #2e3247", borderRadius: 9, padding: "12px 14px", gridColumn: "1 / -1" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa", marginBottom: 10 }}>
                  Sugerencias de consolidación
                  <span style={{ fontSize: 10, color: "#5a5e75", fontWeight: 400, marginLeft: 6 }}>mueve estos lotes para reducir fragmentación</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }}>
                  {analisisData.consolidaciones.map((c, i) => (
                    <div key={i} style={{ background: "#0f1117", border: "1px solid #3730a3", borderRadius: 7, padding: "9px 12px", fontSize: 11 }}>
                      <div style={{ color: "#a78bfa", fontWeight: 700, marginBottom: 4 }}>{c.formato}</div>
                      <div style={{ color: "#8b8fa8", marginBottom: 2 }}>Lote: <span style={{ color: "#e8eaf0" }}>{c.lote}</span></div>
                      <div style={{ color: "#8b8fa8", marginBottom: 2 }}>{c.pallets_a_mover} pallets desde {c.locs_origen.length} locs → <span style={{ color: "#4ade80", fontWeight: 600 }}>{c.loc_destino}</span></div>
                      <div style={{ color: "#60a5fa", fontSize: 10, marginTop: 4 }}>{c.beneficio}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )}

    {/* Toolbar */}
    <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", background: "#1a1d27", border: "1px solid #2e3247", borderRadius: 7, padding: "6px 10px", flex: 1, minWidth: 240 }}>
        {leyenda.map(({ c, l }) => (
          <span key={l} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#8b8fa8" }}>
            <span style={{ width: 11, height: 11, borderRadius: 2, background: c, flexShrink: 0, display: "inline-block" }} />{l}
          </span>
        ))}
      </div>

      <select value={fZone} onChange={e => setFZone(e.target.value)}
        style={{ fontSize: 12, padding: "5px 8px", border: "1px solid #2e3247", borderRadius: 6, background: "#1a1d27", color: "#e8eaf0", outline: "none" }}>
        <option value="all">Todas las zonas</option>
        {Object.keys(allData).map(z => <option key={z} value={z}>{z}</option>)}
      </select>

      <select value={fStatus} onChange={e => setFStatus(e.target.value)}
        style={{ fontSize: 12, padding: "5px 8px", border: "1px solid #2e3247", borderRadius: 6, background: "#1a1d27", color: "#e8eaf0", outline: "none" }}>
        <option value="all">Todos</option>
        <option value="empty">Vacíos</option>
        <option value="low">Bajo</option>
        <option value="mid">Medio</option>
        <option value="high">Alto</option>
        <option value="over">Exceso</option>
      </select>

      <input value={fSearch} onChange={e => setFSearch(e.target.value)} placeholder="Buscar loc…"
        style={{ fontSize: 12, padding: "5px 8px", border: "1px solid #2e3247", borderRadius: 6, background: "#1a1d27", color: "#e8eaf0", outline: "none", width: 90 }} />

      <div style={{ display: "flex", border: "1px solid #2e3247", borderRadius: 6, overflow: "hidden" }}>
        {(["map", "table"] as const).map(m => (
          <button key={m} onClick={() => setViewMode(m)}
            style={{ padding: "5px 12px", fontSize: 12, border: "none", cursor: "pointer", background: viewMode === m ? "#2563eb" : "#1a1d27", color: viewMode === m ? "#fff" : "#8b8fa8" }}>
            {m === "map" ? "⊞ Mapa" : "☰ Tabla"}
          </button>
        ))}
      </div>

      <button onClick={loadMap}
        style={{ fontSize: 12, padding: "5px 10px", border: "1px solid #2e3247", borderRadius: 6, background: "#222535", color: "#8b8fa8", cursor: "pointer" }}>↻</button>
    </div>

    {/* Contenido + panel lateral */}
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>

      <div style={{ flex: 1, minWidth: 0 }}>
        {loading ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(215px,1fr))", gap: 10 }}>
            {Array(8).fill(0).map((_, i) => <div key={i} style={{ height: 148, background: "#222535", borderRadius: 10, animation: "pulse 1.5s infinite" }} />)}
          </div>
        ) : viewMode === "table" ? (

          /* ── TABLA ── */
          <div style={{ background: "#1a1d27", border: "1px solid #2e3247", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #2e3247" }}>
                    {["Zona", "Localizador", "Formato",
                      selectedSubInv !== "all" ? selectedSubInv : "Ocupado",
                      "Capacidad", "Disponible", "% Ocup"].map(h => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "#8b8fa8", fontWeight: 500, whiteSpace: "nowrap", fontSize: 11 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allLocsFlat.map((d, i) => {
                    const p     = d.pct_ocupacion || 0;
                    const sel   = selectedLoc?.d.localizador === d.localizador;
                    const subQty= subInvMap ? (subInvMap[d.localizador.toUpperCase()] ?? 0) : null;
                    return (
                      <tr key={d.localizador} onClick={() => setSelectedLoc(sel ? null : { d, zona: d.zona })}
                        style={{ borderBottom: "1px solid #1e2235", background: sel ? "#1e2e4a" : i % 2 === 0 ? "transparent" : "#1c1f2d", cursor: "pointer" }}>
                        <td style={{ padding: "6px 12px", color: "#8b8fa8" }}>{d.zona}</td>
                        <td style={{ padding: "6px 12px", fontWeight: 600 }}>{d.localizador}</td>
                        <td style={{ padding: "6px 12px", color: "#5a5e75", fontSize: 11 }}>{d.formato || "—"}</td>
                        <td style={{ padding: "6px 12px", textAlign: "right", color: subQty != null ? (subQty > 0 ? "#60a5fa" : "#5a5e75") : (d.ocupado > 0 ? "#e8eaf0" : "#5a5e75") }}>
                          {subQty != null ? subQty : d.ocupado}
                        </td>
                        <td style={{ padding: "6px 12px", textAlign: "right" }}>{d.capacidad}</td>
                        <td style={{ padding: "6px 12px", textAlign: "right", color: d.disponible > 0 ? "#4ade80" : "#f87171" }}>{d.disponible}</td>
                        <td style={{ padding: "6px 12px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ width: 55, height: 5, background: "#2e3247", borderRadius: 3, overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${Math.min(100, p * 100)}%`, background: getColor(p), borderRadius: 3 }} />
                            </div>
                            <span style={{ color: getColor(p), fontWeight: 700, minWidth: 38, fontSize: 11 }}>{(p * 100).toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {allLocsFlat.length === 0 && <div style={{ textAlign: "center", color: "#5a5e75", padding: 40, fontSize: 13 }}>Sin resultados</div>}
            </div>
          </div>

        ) : zonasRender.length === 0 ? (
          <div style={{ textAlign: "center", color: "#5a5e75", padding: 50, fontSize: 13 }}>Sin resultados</div>
        ) : (

          /* ── MAPA ── */
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(215px,1fr))", gap: 10 }}>
            {zonasRender.map(zn => {
              const ls  = allData[zn] || [];
              const avg = ls.reduce((s, d) => s + (d.pct_ocupacion || 0), 0) / (ls.length || 1);
              const withStock       = ls.filter(d => d.ocupado > 0).length;
              const palletsLibresZn = ls.reduce((s, d) => s + Math.max(0, d.disponible || 0), 0);
              const subInvInZone    = subInvMap ? ls.filter(d => (subInvMap[d.localizador.toUpperCase()] ?? 0) > 0).length : 0;
              const freeInZone      = ls.filter(d => (d.ocupado || 0) === 0).length;

              return (
                <div key={zn} style={{ background: "#1a1d27", border: "1px solid #2e3247", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{zn}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      {palletsLibresZn > 0 && (
                        <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 4, fontWeight: 700, background: "#14532d", color: "#4ade80" }}>
                          {palletsLibresZn} libres
                        </span>
                      )}
                      <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 4, fontWeight: 700, ...getBadgeStyle(avg) }}>
                        {(avg * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                  <div style={{ height: 4, background: "#2e3247", borderRadius: 2, overflow: "hidden", marginBottom: 7 }}>
                    <div style={{ height: "100%", width: `${Math.min(110, avg * 100)}%`, background: getColor(avg), borderRadius: 2, transition: "width .4s" }} />
                  </div>

                  {/* Grid de celdas — muestra pallets disponibles */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {ls.map(d => {
                      const p      = d.pct_ocupacion || 0;
                      const subQty = subInvMap ? (subInvMap[d.localizador.toUpperCase()] ?? 0) : 0;
                      const show   = matchFilter(p) && (!fSearch || d.localizador.toUpperCase().includes(fSearch.toUpperCase()));
                      const sel    = selectedLoc?.d.localizador === d.localizador;
                      const color  = subInvMap ? getSubInvColor(d, subQty) : getColor(p);
                      const disp   = d.disponible || 0;

                      // Etiqueta: pallets disponibles en el cubo
                      let label = "";
                      if (show) {
                        if (subInvMap) {
                          // Modo subinventario: mostrar cantidad del subinv seleccionado
                          label = subQty > 0 ? (subQty > 99 ? "99+" : String(subQty)) : (disp > 0 ? String(disp > 99 ? 99 : disp) : "");
                        } else {
                          // Modo normal: mostrar disponible
                          label = disp > 0 ? (disp > 99 ? "99+" : String(disp)) : (d.ocupado > 0 ? "■" : "");
                        }
                      }

                      return (
                        <div
                          key={d.localizador}
                          onMouseMove={e => { if (!sel) setTooltip({ d, zona: zn, x: e.clientX, y: e.clientY }); }}
                          onMouseLeave={() => setTooltip(null)}
                          onClick={() => { setTooltip(null); setSelectedLoc(sel ? null : { d, zona: zn }); }}
                          style={{
                            width: 32, height: 32, borderRadius: 4, cursor: "pointer", flexShrink: 0,
                            background: show ? color : "#2e3247",
                            opacity: show ? 1 : 0.1,
                            outline: sel ? "2px solid #fff" : "none",
                            outlineOffset: 1,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: label.length > 2 ? 7 : (label === "■" ? 12 : 9),
                            fontWeight: 800,
                            color: label === "■" ? "rgba(255,255,255,0.35)" : (disp > 0 ? "#4ade80" : "rgba(255,255,255,0.5)"),
                            userSelect: "none",
                          }}
                        >
                          {label}
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ fontSize: 10, color: "#5a5e75", marginTop: 6, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 4 }}>
                    <span>{ls.length} loc</span>
                    {subInvMap
                      ? <>
                          <span style={{ color: "#60a5fa" }}>{subInvInZone} {selectedSubInv}</span>
                          <span style={{ color: "#4ade80" }}>{freeInZone} vacías</span>
                        </>
                      : <span style={{ color: "#8b8fa8" }}>{withStock} c/stock</span>
                    }
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* PANEL LATERAL */}
      {selectedLoc && (() => {
        const { d, zona } = selectedLoc;
        const p     = d.pct_ocupacion || 0;
        const sc    = getColor(p);
        const label = p > 1.1 ? "EXCESO" : p >= 1.0 ? "LLENO" : p >= 0.8 ? "ALTO" : p > 0 ? "EN USO" : "VACÍO";
        const subQty= subInvMap ? (subInvMap[d.localizador.toUpperCase()] ?? 0) : null;
        return (
          <div style={{ width: 235, flexShrink: 0, background: "#1a1d27", border: "1px solid #4a5175", borderRadius: 10, padding: "15px", position: "sticky", top: 80 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{d.localizador}</div>
                <div style={{ fontSize: 11, color: "#8b8fa8", marginTop: 2 }}>{zona}</div>
              </div>
              <button onClick={() => setSelectedLoc(null)}
                style={{ background: "none", border: "none", color: "#5a5e75", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
            </div>

            <div style={{ background: d.disponible > 0 ? "#14532d" : "#2e1a1a", border: `1px solid ${d.disponible > 0 ? "#166534" : "#7f1d1d"}`, borderRadius: 8, padding: "14px", marginBottom: 10, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: d.disponible > 0 ? "#86efac" : "#fca5a5", marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Pallets disponibles
              </div>
              <div style={{ fontSize: 38, fontWeight: 800, color: d.disponible > 0 ? "#4ade80" : "#f87171", lineHeight: 1 }}>
                {d.disponible > 0 ? d.disponible : "0"}
              </div>
              <div style={{ fontSize: 11, color: d.disponible > 0 ? "#86efac" : "#fca5a5", marginTop: 4 }}>
                de {d.capacidad} capacidad total
              </div>
            </div>

            <div style={{ background: "#0f1117", borderRadius: 8, padding: "10px 13px", marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 5 }}>
                <span style={{ color: "#8b8fa8" }}>{label}</span>
                <span style={{ color: sc, fontWeight: 700 }}>{(p * 100).toFixed(1)}%</span>
              </div>
              <div style={{ height: 8, background: "#2e3247", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(100, p * 100)}%`, background: sc, borderRadius: 4 }} />
              </div>
            </div>

            {([
              ["Capacidad",  d.capacidad  || 0, "pallets"],
              ["Ocupado",    d.ocupado    || 0, "pallets"],
              ["Disponible", d.disponible || 0, "pallets"],
              ["Formato",    d.formato    || "—", ""],
            ] as [string, number | string, string][]).map(([k, v, u]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #2e3247", fontSize: 12 }}>
                <span style={{ color: "#8b8fa8" }}>{k}</span>
                <span style={{ fontWeight: 600, color: k === "Disponible" ? (Number(v) > 0 ? "#4ade80" : "#f87171") : "#e8eaf0" }}>
                  {v}{u ? ` ${u}` : ""}
                </span>
              </div>
            ))}

            {subQty !== null && selectedSubInv !== "all" && (
              <div style={{ marginTop: 12, background: "#0f1117", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: "#8b8fa8", marginBottom: 4 }}>Subinventario seleccionado</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#60a5fa", marginBottom: 6 }}>{selectedSubInv}</div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: "#8b8fa8" }}>Pallets aquí</span>
                  <span style={{ fontWeight: 700, color: subQty > 0 ? "#60a5fa" : "#4ade80" }}>
                    {subQty > 0 ? `${subQty} plt` : "No tiene"}
                  </span>
                </div>
                {subQty === 0 && d.disponible > 0 && (
                  <div style={{ marginTop: 6, fontSize: 11, color: "#4ade80", background: "#1a2e1a", borderRadius: 5, padding: "4px 8px" }}>
                    ✓ {d.disponible} pallets disponibles para {selectedSubInv}
                  </div>
                )}
                {subQty === 0 && d.disponible === 0 && d.ocupado > 0 && (
                  <div style={{ marginTop: 6, fontSize: 11, color: "#9ca3af", background: "#1e2235", borderRadius: 5, padding: "4px 8px" }}>
                    ✗ Ocupado por otros subinventarios
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  </div>

  {/* TOOLTIP */}
  {tooltip && !selectedLoc && (() => {
    const { d, zona, x, y } = tooltip;
    const p     = d.pct_ocupacion || 0;
    const s     = p > 1.1 ? "⚠ EXCESO" : p >= 1.0 ? "LLENO" : p >= 0.8 ? "ALTO" : p > 0 ? "EN USO" : "VACÍO";
    const sc    = getColor(p);
    const subQty= subInvMap ? (subInvMap[d.localizador.toUpperCase()] ?? 0) : null;
    return (
      <div style={{ position: "fixed", left: x + 14, top: y + 14, background: "#1a1d27", border: "1px solid #4a5175", borderRadius: 8, padding: "10px 13px", fontSize: 12, pointerEvents: "none", zIndex: 9999, minWidth: 180, boxShadow: "0 8px 24px rgba(0,0,0,.6)" }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 1 }}>{d.localizador}</div>
        <div style={{ fontSize: 10, color: "#5a5e75", marginBottom: 6, paddingBottom: 6, borderBottom: "1px solid #2e3247" }}>{zona} · {d.formato || "—"}</div>
        <div style={{ background: d.disponible > 0 ? "#14532d" : "#2e1a1a", borderRadius: 6, padding: "8px 10px", marginBottom: 8, textAlign: "center" }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: d.disponible > 0 ? "#4ade80" : "#f87171", lineHeight: 1 }}>
            {d.disponible > 0 ? d.disponible : "LLENO"}
          </div>
          {d.disponible > 0 && <div style={{ fontSize: 10, color: "#86efac", marginTop: 2 }}>pallets disponibles</div>}
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: sc, marginBottom: 5 }}>{(p * 100).toFixed(1)}% — {s}</div>
        {([["Capacidad", d.capacidad || 0], ["Ocupado", d.ocupado || 0], ["Disponible", d.disponible || 0]] as [string, number][]).map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 18, color: "#8b8fa8", margin: "2px 0", fontSize: 11 }}>
            <span>{k}</span><span style={{ color: "#e8eaf0", fontWeight: 500 }}>{v} plt</span>
          </div>
        ))}
        {subQty !== null && selectedSubInv !== "all" && (
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid #2e3247", fontSize: 11 }}>
            <span style={{ color: "#8b8fa8" }}>{selectedSubInv}: </span>
            <span style={{ color: subQty > 0 ? "#60a5fa" : "#4ade80", fontWeight: 600 }}>
              {subQty > 0 ? `${subQty} plt` : "Libre"}
            </span>
          </div>
        )}
        <div style={{ fontSize: 10, color: "#5a5e75", marginTop: 5, fontStyle: "italic" }}>Click para fijar panel</div>
      </div>
    );
  })()}

  <style>{`@keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:.8} }`}</style>
</div>
); }