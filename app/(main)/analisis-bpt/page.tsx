"use client";
import { useEffect, useState, useRef, useCallback } from "react"; import * as XLSX from "xlsx";
import { getBrowserClient } from "@/lib/supabase/browser";
const db = getBrowserClient();
// ── Tipos ──────────────────────────────────────────────────────────────────
// Forma de respuesta de /api/plan-ubicacion usada en procesarComoLineas
interface PlanLine {
  row_idx: number; cod_org_inv: string; codigo: string; descripcion: string;
  subinventario_origen: string; localizador_origen: string; lote: string;
  cantidad_fisica: number; pallets: number; cajas: number;
  pallets_efectivos: number;
  subinventario_destino: string; localizador_destino: string;
  inv_pe: number; sin_espacio: boolean; is_fragment: boolean;
}
interface Localizador { zona: string; localizador: string; formato?: string; capacidad: number; ocupado: number; disponible: number; pct_ocupacion: number; activo?: boolean; }
interface SubInvItem {
  loc: string; subinv: string; formato: string; lote: string; pallets: number;
  cantidad_fisica?: number; codigo?: string; descripcion?: string; cod_org_inv?: string;
  nombre_org_inv?: string; nombre_subinv?: string; um?: string; peso?: number;
  um_peso?: string; tipo_inventario?: string; calidad?: string; marca?: string;
  estado_inventario?: string; estado?: string; m2_x_caja?: number;
  can_reservada?: number; dispo_reservar?: number; um_sec?: string;
  cantidad_fisica_sec?: number; lote_status?: string;
}
interface Asignacion { loc: string; zona: string; palletsAsignados: number; }
interface PlanEntry { formato: string; lote: string; palletsNeed: number; asignaciones: Asignacion[]; palletsAsignados: number; palletsRestantes: number; }
interface TooltipData { d: Localizador; zona: string; x: number; y: number; } interface SelectedLoc { d: Localizador; zona: string; }
interface Movimiento { codigo: string; lote: string; origen_localizador: string; origen_subinventario: string; origen_pallets: number; destino_localizador: string; destino_subinventario: string; destino_pallets: number; }
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
const [storedItems, setStoredItems] = useState<SubInvItem[]>([]); const [procesando, setProcesando] = useState(false); const [procesadoInfo, setProcesadoInfo] = useState<{ count: number; subinv: string } | null>(null);
// Plan de distribución
const [sortingPlan, setSortingPlan] = useState<PlanEntry[]>([]);
const [loadingPlan, setLoadingPlan] = useState(false);
const [showPlan, setShowPlan] = useState(false);
const [planFilter, setPlanFilter] = useState("");
// Consolidación
const [consolidacion, setConsolidacion] = useState<Movimiento[] | null>(null);
const [loadingConsol, setLoadingConsol] = useState(false);
const [showConsol, setShowConsol] = useState(false);
const [umbralConsol, setUmbralConsol] = useState(2);
const [consolFilter, setConsolFilter] = useState("");
const [tooltip, setTooltip] = useState<TooltipData | null>(null); const [selectedLoc, setSelectedLoc] = useState<SelectedLoc | null>(null); const [viewMode, setViewMode] = useState<"map" | "table">("map");
const [importLog, setImportLog] = useState<{ msg: string; cls: string }[]>([]); const [progress, setProgress] = useState(0); const [progressLabel, setProgressLabel] = useState(""); const [importing, setImporting] = useState(false); const [dragging, setDragging] = useState(false);
const fileRef = useRef<HTMLInputElement>(null); const logRef = useRef<HTMLDivElement>(null);
// ── Cargar mapa desde BD ────────────────────────────────────────────────
const loadMap = useCallback(async () => { try { const { data, error } = await db .from("localizadores") .select("zona,localizador,formato,pct_ocupacion,capacidad,ocupado,disponible") .eq("activo", true) .order("zona").order("localizador"); if (error) throw error; const grouped: Record<string, Localizador[]> = {}; (data || []).forEach((r: Localizador) => { if (!grouped[r.zona]) grouped[r.zona] = []; grouped[r.zona].push(r); }); setAllData(grouped); setConnOk(true); setLastUpdate(new Date().toLocaleTimeString("es-EC")); } catch { setConnOk(false); } finally { setLoading(false); } }, []);
useEffect(() => { loadMap(); const t = setInterval(loadMap, 60_000); return () => clearInterval(t); }, [loadMap]);
useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [importLog]);
// ── Filtros ─────────────────────────────────────────────────────────────
function matchFilter(p: number) { if (fStatus === "all") return true; if (fStatus === "empty") return p <= 0; if (fStatus === "low") return p > 0 && p < 0.5; if (fStatus === "mid") return p >= 0.5 && p < 0.8; if (fStatus === "high") return p >= 0.8 && p <= 1.0; if (fStatus === "over") return p > 1.0; return true; }
// ── Stats globales ──────────────────────────────────────────────────────
const allLocs = Object.values(allData).flat(); const totalCap = allLocs.reduce((s, d) => s + (d.capacidad || 0), 0); const totalOcup = allLocs.reduce((s, d) => s + (d.ocupado || 0), 0); const avgGlobal = totalCap > 0 ? totalOcup / totalCap : 0; const subInvMap = selectedSubInv !== "all" ? (subInvStock[selectedSubInv] ?? {}) : null; const subInvStats = subInvMap ? (() => { const keys = Object.keys(subInvMap); const total = keys.reduce((s, k) => s + (subInvMap[k] || 0), 0); return { locs: keys.length, total }; })() : null; const totalPalletsLibres = allLocs.reduce((s, d) => s + Math.max(0, d.disponible || 0), 0);
const stats = [ { v: allLocs.length, l: "Localizadores" }, { v: Object.keys(allData).length, l: "Zonas" }, { v: (avgGlobal * 100).toFixed(1) + "%", l: "Ocupación global" }, { v: allLocs.filter(d => d.ocupado > 0).length, l: "Con stock" }, { v: totalPalletsLibres, l: "Pallets libres" }, { v: allLocs.filter(d => d.pct_ocupacion > 1.0).length, l: "Con exceso" }, ];
// ── Detectar columnas del Excel ─────────────────────────────────────────
function detectHeader(rows: unknown[][]): {
  headerRowIdx: number; locColIdx: number; tarimasColIdx: number; cajasColIdx: number;
  cantColIdx: number; cantFisicaColIdx: number; subInvColIdx: number; formatoColIdx: number;
  loteColIdx: number; codigoColIdx: number; descColIdx: number; codOrgColIdx: number;
  nombreOrgColIdx: number; nombreSubColIdx: number; umColIdx: number; pesoColIdx: number;
  umPesoColIdx: number; tipoInvColIdx: number; calidadColIdx: number; marcaColIdx: number;
  estadoInvColIdx: number; estadoColIdx: number; m2CajaColIdx: number;
  canReservColIdx: number; dispoReservColIdx: number; umSecColIdx: number;
  canFisSecColIdx: number; loteStatusColIdx: number;
} {
  let headerRowIdx = -1, locColIdx = -1, tarimasColIdx = -1, cajasColIdx = -1;
  let cantColIdx = -1, cantFisicaColIdx = -1, subInvColIdx = -1;
  let formatoColIdx = -1, loteColIdx = -1, codigoColIdx = -1, descColIdx = -1, codOrgColIdx = -1;
  let nombreOrgColIdx = -1, nombreSubColIdx = -1, umColIdx = -1, pesoColIdx = -1;
  let umPesoColIdx = -1, tipoInvColIdx = -1, calidadColIdx = -1, marcaColIdx = -1;
  let estadoInvColIdx = -1, estadoColIdx = -1, m2CajaColIdx = -1;
  let canReservColIdx = -1, dispoReservColIdx = -1, umSecColIdx = -1;
  let canFisSecColIdx = -1, loteStatusColIdx = -1;

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

  // ── ORDEN IMPORTANTE: codOrgColIdx ANTES que codigoColIdx ──────────────
  // "Codigo Org Inv" empieza con "COD" igual que "Código" — detectar el más
  // específico primero para evitar que se asigne al índice equivocado.
  const codOrgKw = ["COD ORG INV", "CODIGO ORG INV", "COD.ORG.INV", "CODORGINV", "CODORG INV", "CODIGO ORG"];
  for (const kw of codOrgKw) {
    const oi = row.findIndex((c, idx) =>
      idx !== li && idx !== subInvColIdx && idx !== formatoColIdx && idx !== loteColIdx &&
      (c === kw || c.startsWith(kw))
    );
    if (oi >= 0) { codOrgColIdx = oi; break; }
  }

  // Código del producto (excluye codOrgColIdx ya asignado)
  const codKw = ["CODIGO", "COD", "CODART", "COD ART", "ARTICULO", "ITEM", "SKU"];
  for (const kw of codKw) {
    const ci = row.findIndex((c, idx) =>
      idx !== li && idx !== subInvColIdx && idx !== formatoColIdx &&
      idx !== loteColIdx && idx !== codOrgColIdx &&
      (c === kw || c.startsWith(kw))
    );
    if (ci >= 0) { codigoColIdx = ci; break; }
  }

  // Descripción
  const descKw = ["DESCRIPCION", "DESCRIPCI", "DESC", "PRODUCTO", "NOMBRE PRODUCTO"];
  for (const kw of descKw) {
    const di = row.findIndex((c, idx) =>
      idx !== li && idx !== subInvColIdx && idx !== formatoColIdx &&
      idx !== loteColIdx && idx !== codigoColIdx && idx !== codOrgColIdx &&
      (c === kw || c.startsWith(kw))
    );
    if (di >= 0) { descColIdx = di; break; }
  }

  // Pallets / Tarimas
  const tarimKw = ["TARIMA", "TARIMAS", "PALLET", "PALLETS", "ESTIBA",
                   "NRO TARIMA", "NTAR", "NUM TARIMA", "PALETA", "PALETAS"];
  for (const kw of tarimKw) {
    const ti = row.findIndex((c, idx) =>
      idx !== li && idx !== subInvColIdx && (c === kw || c.startsWith(kw))
    );
    if (ti >= 0) { tarimasColIdx = ti; break; }
  }

  // Cajas
  const cajaKw = ["CAJAS", "CAJA", "BOXES", "BOX", "FRACCION", "FRACCIONES",
                  "SALDO CAJA", "SALDO_CAJA", "UNIDADES SUELTAS", "SUELTAS"];
  for (const kw of cajaKw) {
    const ci2 = row.findIndex((c, idx) =>
      idx !== li && idx !== subInvColIdx && idx !== tarimasColIdx &&
      (c === kw || c.startsWith(kw))
    );
    if (ci2 >= 0) { cajasColIdx = ci2; break; }
  }

  // Can Física (m² reales del producto — UM=M2)
  const canFisKw = ["CAN FISICA", "CAN.FISICA", "CANTIDAD FISICA", "CANT FISICA",
                    "CANT.FISICA", "CANTIDAD_FISICA", "CANFISICA"];
  for (const kw of canFisKw) {
    const fi = row.findIndex((c, idx) =>
      idx !== li && idx !== subInvColIdx && idx !== tarimasColIdx && idx !== cajasColIdx &&
      (c === kw || c.startsWith(kw))
    );
    if (fi >= 0) { cantFisicaColIdx = fi; break; }
  }

  // Cantidad genérica (fallback si no hay PALLETS ni CAN FISICA)
  const qKw = ["CANTIDAD", "CANT", "QTY", "STOCK", "SALDO",
               "TOTAL UOM", "TOTAL_UOM", "TOTAL", "UNIDADES", "UND"];
  for (const kw of qKw) {
    const qi = row.findIndex((c, idx) =>
      idx !== li && idx !== subInvColIdx && idx !== tarimasColIdx &&
      idx !== cajasColIdx && idx !== cantFisicaColIdx &&
      (c === kw || c.startsWith(kw))
    );
    if (qi >= 0) { cantColIdx = qi; break; }
  }

  if (tarimasColIdx < 0 && cantColIdx < 0 && cantFisicaColIdx < 0) {
    const nr = (rows[Math.min(i + 1, rows.length - 1)] as unknown[]);
    for (let ci = li + 1; ci < row.length; ci++) {
      if (ci === subInvColIdx) continue;
      const v = String(nr[ci] || "");
      if (v && !isNaN(parseFloat(v))) { cantColIdx = ci; break; }
    }
  }

  // ── Columnas extendidas (segunda pasada sobre el mismo row) ──────────
  const usedPrimary = new Set([locColIdx, subInvColIdx, formatoColIdx, loteColIdx,
    codOrgColIdx, codigoColIdx, descColIdx, tarimasColIdx, cajasColIdx,
    cantFisicaColIdx, cantColIdx].filter(x => x >= 0));
  const findExtra = (kws: string[]) => row.findIndex((c, idx) =>
    !usedPrimary.has(idx) && kws.some(kw => c === kw || c.startsWith(kw))
  );
  nombreOrgColIdx   = findExtra(["NOMBRE ORG INV", "NOMBRE ORG"]);
  nombreSubColIdx   = findExtra(["NOMBRE SUBINVENTARIO", "NOMBRE SUB INVENTARIO", "NOMBRE SUBINV"]);
  umColIdx          = row.findIndex((c, idx) => !usedPrimary.has(idx) && c === "UM");
  pesoColIdx        = row.findIndex((c, idx) => !usedPrimary.has(idx) && c === "PESO");
  umPesoColIdx      = findExtra(["UM PESO"]);
  tipoInvColIdx     = findExtra(["TIPO INVENTARIO"]);
  calidadColIdx     = row.findIndex((c, idx) => !usedPrimary.has(idx) && c === "CALIDAD");
  marcaColIdx       = row.findIndex((c, idx) => !usedPrimary.has(idx) && c === "MARCA");
  estadoInvColIdx   = findExtra(["ESTADO INVENTARIO"]);
  estadoColIdx      = row.findIndex((c, idx) => !usedPrimary.has(idx) && c === "ESTADO" && idx !== estadoInvColIdx);
  m2CajaColIdx      = findExtra(["M2 X CAJA", "M2XCAJA", "M2 CAJA"]);
  canReservColIdx   = findExtra(["CAN RESERVADA", "CANT RESERVADA"]);
  dispoReservColIdx = findExtra(["DISPO RESERVAR"]);
  umSecColIdx       = findExtra(["UM SEC"]);
  canFisSecColIdx   = findExtra(["CAN FISICA SEC", "CANTIDAD FISICA SEC"]);
  loteStatusColIdx  = findExtra(["LOTE STATUS", "STATUS LOTE"]);

  break;
}
return { headerRowIdx, locColIdx, tarimasColIdx, cajasColIdx, cantColIdx, cantFisicaColIdx,
         subInvColIdx, formatoColIdx, loteColIdx, codigoColIdx, descColIdx, codOrgColIdx,
         nombreOrgColIdx, nombreSubColIdx, umColIdx, pesoColIdx, umPesoColIdx, tipoInvColIdx,
         calidadColIdx, marcaColIdx, estadoInvColIdx, estadoColIdx, m2CajaColIdx,
         canReservColIdx, dispoReservColIdx, umSecColIdx, canFisSecColIdx, loteStatusColIdx };
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
        pct_ocupacion: Math.round(pct * 10000) / 10000,
        // activo no se incluye → localizadores bloqueados conservan su estado
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
    const { headerRowIdx, locColIdx, tarimasColIdx, cajasColIdx, cantColIdx, cantFisicaColIdx,
            subInvColIdx, formatoColIdx, loteColIdx, codigoColIdx, descColIdx, codOrgColIdx,
            nombreOrgColIdx, nombreSubColIdx, umColIdx, pesoColIdx, umPesoColIdx, tipoInvColIdx,
            calidadColIdx, marcaColIdx, estadoInvColIdx, estadoColIdx, m2CajaColIdx,
            canReservColIdx, dispoReservColIdx, umSecColIdx, canFisSecColIdx, loteStatusColIdx,
          } = detectHeader(rows);

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
        const si      = String(r[subInvColIdx]    || "").trim();
        const fmt     = formatoColIdx    >= 0 ? String(r[formatoColIdx]    || "").trim() : "";
        const lot     = loteColIdx       >= 0 ? String(r[loteColIdx]       || "").trim() : "";
        const cod     = codigoColIdx     >= 0 ? String(r[codigoColIdx]     || "").trim() : "";
        const desc    = descColIdx       >= 0 ? String(r[descColIdx]       || "").trim() : "";
        const codOrg  = codOrgColIdx     >= 0 ? String(r[codOrgColIdx]     || "").trim() : "";
        const canFis  = cantFisicaColIdx >= 0 ? parseFloat(String(r[cantFisicaColIdx] || "0").replace(",", ".")) || 0 : 0;
        if (si) {
          subInvSet.add(si);
          if (!bySubInv[si]) bySubInv[si] = {};
          bySubInv[si][loc] = (bySubInv[si][loc] ?? 0) + pallets;
          const str = (ci: number) => ci >= 0 ? String(r[ci] || "").trim() || undefined : undefined;
          const num = (ci: number) => ci >= 0 ? parseFloat(String(r[ci] || "").replace(",", ".")) || undefined : undefined;
          subInvItems.push({
            loc, subinv: si, formato: fmt, lote: lot, pallets,
            cantidad_fisica: canFis || undefined, codigo: cod, descripcion: desc, cod_org_inv: codOrg,
            nombre_org_inv: str(nombreOrgColIdx), nombre_subinv: str(nombreSubColIdx),
            um: str(umColIdx), peso: num(pesoColIdx), um_peso: str(umPesoColIdx),
            tipo_inventario: str(tipoInvColIdx), calidad: str(calidadColIdx), marca: str(marcaColIdx),
            estado_inventario: str(estadoInvColIdx), estado: str(estadoColIdx),
            m2_x_caja: num(m2CajaColIdx), can_reservada: num(canReservColIdx),
            dispo_reservar: num(dispoReservColIdx), um_sec: str(umSecColIdx),
            cantidad_fisica_sec: num(canFisSecColIdx), lote_status: str(loteStatusColIdx),
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

    type StockUpdate = { zona: string; localizador: string; ocupado: number; disponible: number; pct_ocupacion: number };
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

    // ── PASO 5: subir a BD en lotes ──────────────────────────────
    const BATCH = 200;
    let done = 0;
    for (let i = 0; i < updates.length; i += BATCH) {
      const batch = updates.slice(i, i + BATCH);
      const { error } = await db
        .from("localizadores")
        .upsert(batch, { onConflict: "zona,localizador" });
      if (error) throw new Error(`Lote ${Math.ceil(i / BATCH) + 1}: ${error.message}`);
      done += batch.length;
      setProgress(48 + Math.round((done / updates.length) * 40));
      setProgressLabel(`Actualizando BD… ${done}/${updates.length}`);
    }

    // ── PASO 5b: upsert a inventario via RPC + recalcular ocupación ──
    if (subInvItems.length > 0) {
      log("⟳ Actualizando tabla inventario…");
      const bySubInvGroups = new Map<string, typeof subInvItems>();
      for (const item of subInvItems) {
        if (!item.subinv) continue;
        if (!bySubInvGroups.has(item.subinv)) bySubInvGroups.set(item.subinv, []);
        bySubInvGroups.get(item.subinv)!.push(item);
      }
      for (const [si, siItems] of bySubInvGroups) {
        const rows = siItems
          .filter(item => dbMap[item.loc.toUpperCase()])
          .map(item => ({
            codigo:              item.codigo            || "",
            lote:                item.lote              || null,
            localizador:         item.loc,
            subinventario:       item.subinv,
            descripcion:         item.descripcion       || null,
            pallets:             item.pallets,
            cajas:               0,
            cantidad_fisica:     item.cantidad_fisica   ?? null,
            formato:             item.formato           || null,
            cod_org_inv:         item.cod_org_inv       || null,
            nombre_org_inv:      item.nombre_org_inv    || null,
            nombre_subinv:       item.nombre_subinv     || null,
            um:                  item.um                || null,
            peso:                item.peso              ?? null,
            um_peso:             item.um_peso           || null,
            tipo_inventario:     item.tipo_inventario   || null,
            calidad:             item.calidad           || null,
            marca:               item.marca             || null,
            estado_inventario:   item.estado_inventario || null,
            estado:              item.estado            || null,
            m2_x_caja:          item.m2_x_caja         ?? null,
            can_reservada:       item.can_reservada     ?? null,
            dispo_reservar:      item.dispo_reservar    ?? null,
            um_sec:              item.um_sec            || null,
            cantidad_fisica_sec: item.cantidad_fisica_sec ?? null,
            lote_status:         item.lote_status       || null,
          }));
        const { error: rpcErr } = await db.rpc("importar_subinventario", {
          p_subinventario: si,
          p_rows: rows,
        });
        if (rpcErr) throw new Error(`importar_subinventario ${si}: ${rpcErr.message}`);
        log(`✅ Inventario actualizado: ${si} (${rows.length} registros)`, "ok");
      }
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
      setStoredItems(subInvItems); // persist for PROCESAR button
      setProcesadoInfo(null);
      const prodKey = subInvArr.find(s =>
        s.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes("PRODUCCION")
      );
      if (prodKey) setSelectedSubInv(prodKey);
      log(`✓ ${subInvArr.length} subinventarios cargados — selecciona uno y presiona PROCESAR para crear líneas`);
    }

    setProgress(90);
    setProgressLabel("Recargando mapa…");
    await loadMap();

    // ── PASO 7: Plan de distribución PRODUCCION ───────────────────
    const prodItems = subInvItems.filter(item =>
      item.subinv.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes("PRODUCCION")
    );

    if (prodItems.length > 0) {
      log(`⟳ Calculando plan de distribución para ${prodItems.length} líneas PRODUCCION…`);
      setLoadingPlan(true);

      const { data: freshLocs } = await db
        .from("localizadores")
        .select("zona,localizador,capacidad,disponible,formato")
        .eq("activo", true);

      try {
        const resp = await fetch("/api/analisis-bpt/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: prodItems, locations: freshLocs || [] }),
        });
        const { ok, plan, error: planErr } = await resp.json();
        if (ok && plan) {
          setSortingPlan(plan);
          setShowPlan(true);
          log(`✅ Plan generado: ${(plan as PlanEntry[]).length} grupos (formato+lote)`, "ok");
        } else {
          log(`⚠ Plan no generado: ${planErr}`, "warn");
        }
      } catch {
        log("⚠ Error generando plan de distribución", "warn");
      } finally {
        setLoadingPlan(false);
      }
    }

    setProgress(100);
    setProgressLabel(`✅ ${withStock} con stock · ${resetToZero} vacíos`);
    log(`✅ Mapa actualizado: ${withStock} con stock, ${resetToZero} vacíos`, "ok");
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
// ── PROCESAR: crea lineas_reubicacion usando /api/plan-ubicacion ──────────
async function procesarComoLineas() {
  const items = storedItems.filter(item => item.subinv === selectedSubInv);
  if (!items.length) { alert(`No hay ítems para ${selectedSubInv}`); return; }
  setProcesando(true);
  const now = new Date().toISOString();

  try {
    // 1. Catálogo de metraje (incluye __DEFAULT__ como fallback sin magic number)
    const { data: catalogData } = await db
      .from("catalogo_metraje")
      .select("codigo,metraje_por_pallet");
    const catalogMap: Record<string, number> = {};
    for (const c of catalogData ?? []) {
      catalogMap[(c.codigo || "").toUpperCase().trim()] = Number(c.metraje_por_pallet);
    }
    const M2_DEFAULT = catalogMap["__DEFAULT__"] ?? 1.2;

    // 2. Ubicaciones activas (R3 ya filtrado aquí; R1/R2/R4 los maneja la API)
    const { data: availLocs } = await db
      .from("localizadores")
      .select("zona,localizador,capacidad,ocupado,disponible,formato,activo")
      .eq("activo", true);

    // 3. Mapear SubInvItem → StockItem y llamar al motor único /api/plan-ubicacion
    const stockItems = items.map((item, idx) => ({
      row_idx:               idx,
      cod_org_inv:           item.cod_org_inv  || "",
      codigo:                item.codigo       || "",
      descripcion:           item.descripcion  || `${item.subinv} · ${item.formato || "Sin formato"}`,
      subinventario_origen:  item.subinv,
      localizador_origen:    item.loc,
      lote:                  item.lote         || "",
      cantidad_fisica:       item.cantidad_fisica || item.pallets,
      pallets:               item.pallets,
      cajas:                 0,
      responsable:           "",
      conteo:                null,
      formato:               item.formato      || "",
    }));

    const resp = await fetch("/api/plan-ubicacion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: stockItems, locations: availLocs || [] }),
    });
    const { ok: planOk, plan, error: planErr } = await resp.json();
    if (!planOk) throw new Error(planErr ?? "Error en /api/plan-ubicacion");

    // 4. Construir registros para lineas_reubicacion
    const records = (plan as PlanLine[]).map(line => {
      const codKey = (line.codigo || "").toUpperCase().trim();
      const m2Unit = catalogMap[codKey] || M2_DEFAULT;
      const metraje = line.cantidad_fisica && line.cantidad_fisica > 0
        ? Math.round(line.cantidad_fisica * 100) / 100
        : Math.round(line.pallets * m2Unit * 100) / 100;

      return {
        cod_org_inv:           line.cod_org_inv  || null,
        codigo:                line.codigo       || null,
        descripcion:           line.descripcion,
        subinventario_origen:  line.subinventario_origen,
        localizador_origen:    line.localizador_origen,
        lote:                  line.lote || null,
        pallets:               line.pallets,
        cajas:                 0,
        cantidad_fisica:       line.cantidad_fisica || line.pallets,
        metraje,
        localizador_destino:   line.sin_espacio ? null : line.localizador_destino,
        subinventario_destino: line.sin_espacio ? null : line.subinventario_destino,
        estado:                "pendiente",
        created_at:            now,
        updated_at:            now,
      };
    });

    // 5. Insertar en lotes
    const BATCH = 50;
    const batches: typeof records[] = [];
    for (let i = 0; i < records.length; i += BATCH) batches.push(records.slice(i, i + BATCH));
    const results = await Promise.all(batches.map(b => db.from("lineas_reubicacion").insert(b)));
    let done = 0, errors = 0;
    results.forEach((r, i) => { if (r.error) errors++; else done += batches[i].length; });

    if (errors === 0) {
      setProcesadoInfo({ count: done, subinv: selectedSubInv });
      setImportLog(p => [...p, { msg: `✅ ${done} líneas enviadas a revisión — destinos asignados por /api/plan-ubicacion`, cls: "ok" }]);
    } else {
      setImportLog(p => [...p, { msg: `⚠ ${done} creadas, ${errors} lotes con error`, cls: "warn" }]);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    setImportLog(p => [...p, { msg: `❌ ${msg}`, cls: "err" }]);
  } finally {
    setProcesando(false);
  }
}
// ── Consolidación ──────────────────────────────────────────────────────
async function loadConsolidacion() {
  setLoadingConsol(true);
  try {
    const resp = await fetch(`/api/analisis-bpt/consolidacion?umbral=${umbralConsol}`);
    const { ok, movimientos, error: err } = await resp.json();
    if (!ok) throw new Error(err);
    setConsolidacion(movimientos);
    setShowConsol(true);
  } catch (e: unknown) {
    setImportLog(p => [...p, { msg: `⚠ Consolidación: ${e instanceof Error ? e.message : String(e)}`, cls: "warn" }]);
  } finally {
    setLoadingConsol(false);
  }
}
// ── Datos para render ──────────────────────────────────────────────────
const consolFiltrado = !consolFilter
  ? (consolidacion ?? [])
  : (consolidacion ?? []).filter(m =>
      m.codigo.includes(consolFilter) || m.lote.includes(consolFilter) ||
      m.origen_localizador.includes(consolFilter) || m.destino_localizador.includes(consolFilter)
    );
const zonasRender = fZone === "all" ? Object.keys(allData) : [fZone].filter(z => allData[z]);
const allLocsFlat = allLocs .filter(d => matchFilter(d.pct_ocupacion) && (fZone === "all" || d.zona === fZone) && (!fSearch || d.localizador.toUpperCase().includes(fSearch.toUpperCase())) ) .sort((a, b) => a.zona.localeCompare(b.zona) || a.localizador.localeCompare(b.localizador));
const leyenda = selectedSubInv === "all" ? [ { c: C.empty, l: "Vacío" }, { c: C.low, l: "<50%" }, { c: C.mid, l: "50–80%" }, { c: C.high, l: "81–99%" }, { c: C.full, l: "100%" }, { c: C.over, l: ">110%" }, ] : [ { c: S.available, l: "Libre (disponible)" }, { c: S.hasSubInv, l: `Tiene ${selectedSubInv}` }, { c: S.otherOcup, l: "Ocupado por otros" }, { c: S.full, l: "Exceso" }, ];
// Plan filtrado
const planFiltrado = planFilter
  ? sortingPlan.filter(p =>
      p.formato.includes(planFilter.toUpperCase()) ||
      p.lote.includes(planFilter.toUpperCase()) ||
      p.asignaciones.some(a =>
        a.loc.includes(planFilter.toUpperCase()) || a.zona.includes(planFilter.toUpperCase())
      )
    )
  : sortingPlan;
// Agrupar plan por formato
const planByFormato: Record<string, PlanEntry[]> = {};
for (const e of planFiltrado) {
  if (!planByFormato[e.formato]) planByFormato[e.formato] = [];
  planByFormato[e.formato].push(e);
}
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
    onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) processExcel(f); }}
    style={{ margin: "14px 20px 0", border: `2px dashed ${dragging ? "#2563eb" : "#2e3247"}`, borderRadius: 10, padding: "13px 18px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", cursor: "pointer", background: dragging ? "rgba(37,99,235,.06)" : "transparent", transition: "border-color .2s" }}
  >
    <div style={{ fontSize: 24 }}>📂</div>
    <div style={{ flex: 1, minWidth: 180 }}>
      <div style={{ fontSize: 13, fontWeight: 500 }}>Subir Excel de stock</div>
      <div style={{ fontSize: 11, color: "#8b8fa8", marginTop: 2 }}>
        Arrastra el archivo o haz clic para seleccionarlo
      </div>
    </div>
    <button onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}
      style={{ padding: "7px 16px", background: "#2563eb", border: "none", borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer", flexShrink: 0 }}>
      Seleccionar Excel
    </button>
    <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
      onChange={e => { const f = e.target.files?.[0]; if (f) { processExcel(f); e.target.value = ""; } }} />
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
          <div style={{ marginTop: 10, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
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

            {/* ── BOTÓN PROCESAR ─────────────────────────────────────── */}
            {storedItems.filter(i => i.subinv === selectedSubInv).length > 0 && (
              <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                {procesadoInfo?.subinv === selectedSubInv ? (
                  <div style={{ background: "#0f2a0f", border: "1px solid #22c55e", borderRadius: 8, padding: "10px 16px", fontSize: 12, color: "#4ade80", textAlign: "center" as const }}>
                    ✅ {procesadoInfo.count} líneas en revisión<br />
                    <span style={{ fontSize: 10, color: "#86efac" }}>→ ir a Órdenes para aprobar</span>
                  </div>
                ) : (
                  <button
                    onClick={procesarComoLineas}
                    disabled={procesando}
                    style={{
                      background: procesando ? "#374151" : "#16a34a",
                      border: "none", color: "#fff",
                      fontSize: 13, fontWeight: 700, letterSpacing: 1,
                      padding: "12px 24px", borderRadius: 8, cursor: procesando ? "wait" : "pointer",
                      opacity: procesando ? 0.7 : 1,
                      boxShadow: "0 2px 8px rgba(22,163,74,0.4)",
                    }}
                  >
                    {procesando ? "⟳ Procesando…" : `▶ ENVIAR ${storedItems.filter(i => i.subinv === selectedSubInv).length} LÍNEAS A REVISIÓN`}
                  </button>
                )}
                <span style={{ fontSize: 10, color: "#5a5e75", textAlign: "right" as const }}>
                  Crea las líneas como pendientes para revisión del supervisor
                </span>
              </div>
            )}
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

    {/* ── PANEL CONSOLIDACIÓN ─────────────────────────────────────── */}
    <div style={{ background: "#0d1a0d", border: "1px solid #166534", borderRadius: 10, marginBottom: 12, overflow: "hidden" }}>
      <div style={{ background: "#1a2e1a", padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 16 }}>🔀</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#86efac" }}>Consolidación de Stock</div>
            <div style={{ fontSize: 11, color: "#4ade80", marginTop: 1 }}>Lotes dispersos con saldo bajo → mover al localizador principal</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 11, color: "#86efac" }}>Umbral:</label>
          <input type="number" min={1} max={20} value={umbralConsol}
            onChange={e => setUmbralConsol(Number(e.target.value))}
            style={{ width: 52, fontSize: 12, padding: "4px 6px", border: "1px solid #166534", borderRadius: 5, background: "#0f1117", color: "#e8eaf0", outline: "none" }} />
          <span style={{ fontSize: 11, color: "#4ade80" }}>pallets</span>
          <button onClick={loadConsolidacion} disabled={loadingConsol}
            style={{ padding: "5px 14px", fontSize: 12, border: "none", borderRadius: 6, background: loadingConsol ? "#374151" : "#16a34a", color: "#fff", cursor: loadingConsol ? "wait" : "pointer", fontWeight: 600 }}>
            {loadingConsol ? "⟳ Calculando…" : "Calcular"}
          </button>
          {consolidacion !== null && (
            <button onClick={() => setShowConsol(v => !v)}
              style={{ padding: "5px 12px", fontSize: 12, border: "1px solid #166534", borderRadius: 6, background: showConsol ? "#166534" : "transparent", color: "#86efac", cursor: "pointer" }}>
              {showConsol ? "Ocultar" : `Ver ${consolidacion.length} movimientos`}
            </button>
          )}
        </div>
      </div>

      {consolidacion !== null && !loadingConsol && (
        <div style={{ padding: "10px 16px" }}>
          {/* Stats */}
          <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            {[
              { v: consolidacion.length,                                                            l: "Movimientos" },
              { v: new Set(consolidacion.map(m => `${m.codigo}|||${m.lote}`)).size,                l: "Lotes únicos" },
              { v: consolidacion.reduce((s, m) => s + m.origen_pallets, 0),                        l: "Pallets a mover" },
            ].map(s => (
              <div key={s.l} style={{ background: "#0f1117", borderRadius: 7, padding: "8px 14px" }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#4ade80" }}>{s.v}</div>
                <div style={{ fontSize: 10, color: "#8b8fa8" }}>{s.l}</div>
              </div>
            ))}
            <input value={consolFilter} onChange={e => setConsolFilter(e.target.value.toUpperCase())}
              placeholder="Filtrar código / lote / loc…"
              style={{ fontSize: 11, padding: "5px 10px", border: "1px solid #166534", borderRadius: 6, background: "#0f1117", color: "#e8eaf0", outline: "none", marginLeft: "auto", width: 210 }} />
          </div>

          {showConsol && (
            <div style={{ maxHeight: 420, overflowY: "auto", border: "1px solid #1a3a1a", borderRadius: 8, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ background: "#1a2e1a", position: "sticky", top: 0 }}>
                    {["Código","Lote","Origen","Plt","→","Destino","Plt destino"].map(h => (
                      <th key={h} style={{ padding: "7px 10px", textAlign: "left", color: "#86efac", fontWeight: 600, whiteSpace: "nowrap", borderBottom: "1px solid #166534" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {consolFiltrado.map((m, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #1a2e1a", background: i % 2 === 0 ? "transparent" : "#111a11" }}>
                      <td style={{ padding: "5px 10px", fontWeight: 600, color: "#e8eaf0" }}>{m.codigo}</td>
                      <td style={{ padding: "5px 10px", color: "#93c5fd" }}>{m.lote}</td>
                      <td style={{ padding: "5px 10px", color: "#f87171", fontFamily: "monospace" }}>{m.origen_localizador}</td>
                      <td style={{ padding: "5px 10px", color: "#f87171", fontWeight: 700 }}>{m.origen_pallets}</td>
                      <td style={{ padding: "5px 10px", color: "#5a5e75", textAlign: "center" }}>→</td>
                      <td style={{ padding: "5px 10px", color: "#4ade80", fontFamily: "monospace" }}>{m.destino_localizador}</td>
                      <td style={{ padding: "5px 10px", color: "#4ade80", fontWeight: 700 }}>{m.destino_pallets}</td>
                    </tr>
                  ))}
                  {consolFiltrado.length === 0 && (
                    <tr><td colSpan={7} style={{ padding: 24, textAlign: "center", color: "#5a5e75" }}>Sin resultados para el filtro</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>

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
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }} className="analisis-content-row">

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
          <div className="analisis-side-panel" style={{ width: 235, flexShrink: 0, background: "#1a1d27", border: "1px solid #4a5175", borderRadius: 10, padding: "15px", position: "sticky", top: 80 }}>
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