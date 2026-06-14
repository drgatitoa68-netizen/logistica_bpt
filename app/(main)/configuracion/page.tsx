"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import { getBrowserClient } from "@/lib/supabase/browser";

const db = getBrowserClient();

// ── Types ────────────────────────────────────────────────────────────────────

interface Loc {
  zona: string;
  localizador: string;
  formato: string;
  capacidad: number;
  ocupado: number;
  disponible: number;
  pct_ocupacion: number;
  activo: boolean;
}

interface LocRow extends Loc {
  _key: string;
  _dirty: boolean;
  _new: boolean;
}

interface Linea {
  id: string;
  numero_orden: string | null;
  cod_org_inv: string | null;
  codigo: string | null;
  descripcion: string;
  subinventario_origen: string | null;
  localizador_origen: string | null;
  lote: string | null;
  cantidad_fisica: number;
  pallets: number;
  cajas: number;
  subinventario_destino: string | null;
  localizador_destino: string | null;
  responsable: string | null;
  inv_pe: number | null;
  notas: string | null;
  estado: string;
  created_at: string;
}

interface LineaRow extends Linea {
  _dirty: boolean;
  _new: boolean;
}

interface CatalogRow {
  codigo: string;
  descripcion: string;
  formato: string | null;
  cajas_por_piso: number | null;
  cajas_por_pallet: number | null;
  unidad_de_medida: string | null;
  m2_por_caja: number | null;
  m2_x_pe: number | null;
  _dirty: boolean;
  _new: boolean;           // existe solo en lineas, aún no en catalogo_productos
  _fmtSugerido: string;   // formato extraído de la descripción
  _emptyFields: string[];  // lista de campos críticos vacíos
}

type TabId = "loc" | "lineas" | "catalogo";

// ── Helpers ──────────────────────────────────────────────────────────────────

const N = (v: unknown) => Number(v) || 0;
const S = (v: unknown) => String(v ?? "");

function calcDisp(cap: number, occ: number) {
  return Math.max(0, cap - occ);
}
function calcPct(occ: number, cap: number) {
  return cap > 0 ? Math.min(9.9999, Math.round((occ / cap) * 10000) / 10000) : 0;
}

const CAL_LOC_HEADER_ROW = 7;
const CAL_LOC_COL = { ZONA: 1, LOC: 2, FORMATO: 3, CAPACIDAD: 10, OCUPADO: 14, DISPONIBLE: 17, PCT: 18 };

function parseCalLoc(wb: XLSX.WorkBook): Loc[] {
  const ws = wb.Sheets["CAL_LOC"];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
  const out: Loc[] = [];
  for (let i = CAL_LOC_HEADER_ROW + 1; i < rows.length; i++) {
    const r = rows[i] as unknown[];
    const zona = String(r[CAL_LOC_COL.ZONA] || "").trim();
    const loc  = String(r[CAL_LOC_COL.LOC]  || "").trim();
    if (!zona.startsWith("ZONA") || !loc) continue;
    const cap  = parseInt(String(r[CAL_LOC_COL.CAPACIDAD]))  || 0;
    const ocup = parseInt(String(r[CAL_LOC_COL.OCUPADO]))    || 0;
    const disp = parseInt(String(r[CAL_LOC_COL.DISPONIBLE])) || (cap - ocup);
    let pct    = parseFloat(String(r[CAL_LOC_COL.PCT]))      || 0;
    if (pct > 5) pct /= 100;
    out.push({
      zona, localizador: loc,
      formato:      String(r[CAL_LOC_COL.FORMATO] || "Mezcla").trim(),
      capacidad: cap, ocupado: ocup, disponible: disp,
      pct_ocupacion: Math.round(pct * 10000) / 10000,
      activo: true,
    });
  }
  return out;
}

const FMT_RE = /\b(\d{1,3}(?:[.,]\d+)?[Xx×]\d{1,3}(?:[.,]\d+)?)\b/;
function extractFormato(desc: string): string {
  const m = FMT_RE.exec(desc);
  return m ? m[1].toUpperCase().replace(/[xX×]/g, "X") : "";
}
function getCriticalEmpty(r: Pick<CatalogRow, "formato" | "cajas_por_pallet" | "m2_x_pe" | "cajas_por_piso">): string[] {
  const empty: string[] = [];
  if (!r.formato) empty.push("formato");
  if (!r.cajas_por_pallet) empty.push("cajas_x_pallet");
  if (!r.m2_x_pe) empty.push("m2_x_pe");
  if (!r.cajas_por_piso) empty.push("cajas_x_piso");
  return empty;
}

function getEstadoStyle(estado: string): React.CSSProperties {
  const map: Record<string, React.CSSProperties> = {
    pendiente:   { background: "#1e3a5f", color: "#60a5fa" },
    aprobada:    { background: "#1a2e1a", color: "#4ade80" },
    rechazada:   { background: "#450a0a", color: "#f87171" },
    en_proceso:  { background: "#2d1a00", color: "#fbbf24" },
    completada:  { background: "#1a2520", color: "#34d399" },
  };
  return map[estado] ?? { background: "#1e2235", color: "#6b7280" };
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ConfiguracionPage() {
  const [tab, setTab] = useState<TabId>("loc");

  // Localizadores
  const [zones, setZones]             = useState<string[]>([]);
  const [zoneFilter, setZoneFilter]   = useState("ALL");
  const [locs, setLocs]               = useState<LocRow[]>([]);
  const [loadingLoc, setLoadingLoc]   = useState(false);
  const [savingLoc, setSavingLoc]     = useState(false);

  // Range update – Locs
  const [showRangeLoc, setShowRangeLoc]         = useState(false);
  const [rangeFromLoc, setRangeFromLoc]         = useState("1");
  const [rangeToLoc, setRangeToLoc]             = useState("10");
  const [rangeFieldLoc, setRangeFieldLoc]       = useState("formato");
  const [rangeValueLoc, setRangeValueLoc]       = useState("");

  // File diff – Locs
  const [showDiff, setShowDiff]         = useState(false);
  const [diffLoading, setDiffLoading]   = useState(false);
  const [applyingDiff, setApplyingDiff] = useState(false);
  const [diffData, setDiffData]         = useState<{
    changed: Loc[]; newRows: Loc[]; unchanged: number;
  } | null>(null);
  const fileRefLoc = useRef<HTMLInputElement>(null);

  // Lineas
  const [lineas, setLineas]                 = useState<LineaRow[]>([]);
  const [loadingLineas, setLoadingLineas]   = useState(false);
  const [savingLineas, setSavingLineas]     = useState(false);
  const [estadoFilter, setEstadoFilter]     = useState("ALL");
  const [uploadingLineas, setUploadingLineas] = useState(false);

  // Range update – Lineas
  const [showRangeLineas, setShowRangeLineas]     = useState(false);
  const [rangeFromLineas, setRangeFromLineas]     = useState("1");
  const [rangeToLineas, setRangeToLineas]         = useState("10");
  const [rangeFieldLineas, setRangeFieldLineas]   = useState("responsable");
  const [rangeValueLineas, setRangeValueLineas]   = useState("");

  const fileRefLineas = useRef<HTMLInputElement>(null);

  // Catálogo
  const [catalog, setCatalog]               = useState<CatalogRow[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [savingCatalog, setSavingCatalog]   = useState(false);
  const [catFilter, setCatFilter]           = useState<"all" | "empty">("all");

  // Toast
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Load zones ──────────────────────────────────────────────────────────────
  useEffect(() => {
    db.from("localizadores").select("zona").order("zona").then(({ data }) => {
      if (data) {
        const unique = [...new Set((data as { zona: string }[]).map(r => r.zona))];
        setZones(unique);
      }
    });
  }, []);

  // ── Load localizadores ──────────────────────────────────────────────────────
  const loadLocs = useCallback(async () => {
    setLoadingLoc(true);
    let q = db.from("localizadores")
      .select("zona,localizador,formato,capacidad,ocupado,disponible,pct_ocupacion,activo")
      .order("zona").order("localizador");
    if (zoneFilter !== "ALL") q = q.eq("zona", zoneFilter);
    const { data, error } = await (q as ReturnType<typeof q.limit>).limit(1000);
    if (error) showToast("Error al cargar localizadores: " + error.message, false);
    else {
      setLocs((data as Loc[]).map(r => ({
        ...r,
        _key: `${r.zona}|${r.localizador}`,
        _dirty: false,
        _new: false,
      })));
    }
    setLoadingLoc(false);
  }, [zoneFilter, showToast]);

  useEffect(() => { loadLocs(); }, [loadLocs]);

  // ── Load lineas ─────────────────────────────────────────────────────────────
  const loadLineas = useCallback(async () => {
    setLoadingLineas(true);
    let q = db.from("lineas_reubicacion")
      .select("id,numero_orden,cod_org_inv,codigo,descripcion,subinventario_origen,localizador_origen,lote,cantidad_fisica,pallets,cajas,subinventario_destino,localizador_destino,responsable,inv_pe,notas,estado,created_at")
      .order("created_at", { ascending: false });
    if (estadoFilter !== "ALL") q = q.eq("estado", estadoFilter);
    const { data, error } = await (q as ReturnType<typeof q.limit>).limit(300);
    if (error) showToast("Error al cargar líneas: " + error.message, false);
    else {
      setLineas((data as Linea[]).map(r => ({ ...r, _dirty: false, _new: false })));
    }
    setLoadingLineas(false);
  }, [estadoFilter, showToast]);

  useEffect(() => { loadLineas(); }, [loadLineas]);

  // ── Load catálogo ────────────────────────────────────────────────────────────
  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    const { data: catData, error: catErr } = await db
      .from("catalogo_productos")
      .select("codigo,descripcion,formato,cajas_por_piso,cajas_por_pallet,unidad_de_medida,m2_por_caja,m2_x_pe")
      .order("codigo");
    if (catErr) {
      showToast("Error al cargar catálogo: " + catErr.message, false);
      setLoadingCatalog(false);
      return;
    }

    const { data: lineaData } = await db
      .from("lineas_reubicacion")
      .select("codigo,descripcion")
      .not("codigo", "is", null);

    const catMap = new Map<string, CatalogRow>();
    for (const c of (catData as Record<string, unknown>[]) ?? []) {
      const fmt = extractFormato(String(c.descripcion ?? ""));
      catMap.set(String(c.codigo), {
        codigo: String(c.codigo),
        descripcion: String(c.descripcion ?? ""),
        formato: (c.formato as string | null) ?? null,
        cajas_por_piso: (c.cajas_por_piso as number | null) ?? null,
        cajas_por_pallet: (c.cajas_por_pallet as number | null) ?? null,
        unidad_de_medida: (c.unidad_de_medida as string | null) ?? null,
        m2_por_caja: (c.m2_por_caja as number | null) ?? null,
        m2_x_pe: (c.m2_x_pe as number | null) ?? null,
        _dirty: false, _new: false,
        _fmtSugerido: fmt,
        _emptyFields: getCriticalEmpty(c as Parameters<typeof getCriticalEmpty>[0]),
      });
    }

    for (const l of (lineaData as Record<string, unknown>[]) ?? []) {
      const cod = String(l.codigo ?? "").trim();
      if (!cod || catMap.has(cod)) continue;
      const fmt = extractFormato(String(l.descripcion ?? ""));
      catMap.set(cod, {
        codigo: cod,
        descripcion: String(l.descripcion ?? ""),
        formato: null, cajas_por_piso: null, cajas_por_pallet: null,
        unidad_de_medida: null, m2_por_caja: null, m2_x_pe: null,
        _dirty: false, _new: true,
        _fmtSugerido: fmt,
        _emptyFields: ["formato", "cajas_x_pallet", "m2_x_pe", "cajas_x_piso"],
      });
    }

    setCatalog([...catMap.values()]);
    setLoadingCatalog(false);
  }, [showToast]);

  useEffect(() => { if (tab === "catalogo") loadCatalog(); }, [tab, loadCatalog]);

  // ── Edit helpers ────────────────────────────────────────────────────────────
  function editLoc(key: string, field: keyof Loc, value: unknown) {
    setLocs(prev => prev.map(r => {
      if (r._key !== key) return r;
      const next = { ...r, [field]: value, _dirty: true };
      if (field === "ocupado" || field === "capacidad") {
        const occ = field === "ocupado"   ? N(value) : N(next.ocupado);
        const cap = field === "capacidad" ? N(value) : N(next.capacidad);
        next.disponible    = calcDisp(cap, occ);
        next.pct_ocupacion = calcPct(occ, cap);
      }
      return next;
    }));
  }

  function editLinea(id: string, field: keyof Linea, value: unknown) {
    setLineas(prev => prev.map(r =>
      r.id === id ? { ...r, [field]: value, _dirty: true } : r
    ));
  }

  // ── Add rows ────────────────────────────────────────────────────────────────
  function addLocRow() {
    const newRow: LocRow = {
      zona: zones[0] || "ZONA 1",
      localizador: "",
      formato: "Mezcla",
      capacidad: 0, ocupado: 0, disponible: 0, pct_ocupacion: 0,
      activo: true,
      _key: `NEW_${Date.now()}`,
      _dirty: true,
      _new: true,
    };
    setLocs(prev => [...prev, newRow]);
  }

  function addLineaRow() {
    const newRow: LineaRow = {
      id: `NEW_${Date.now()}`,
      numero_orden: null, cod_org_inv: null, codigo: null,
      descripcion: "",
      subinventario_origen: null, localizador_origen: null, lote: null,
      cantidad_fisica: 0, pallets: 0, cajas: 0,
      subinventario_destino: null, localizador_destino: null,
      responsable: null, inv_pe: null, notas: null,
      estado: "pendiente",
      created_at: new Date().toISOString(),
      _dirty: true, _new: true,
    };
    setLineas(prev => [...prev, newRow]);
  }

  // ── Save locs ───────────────────────────────────────────────────────────────
  async function saveLocs() {
    const dirty = locs.filter(r => r._dirty);
    if (!dirty.length) return showToast("No hay cambios para guardar");
    setSavingLoc(true);
    let errors = 0;
    for (const r of dirty) {
      const payload: Loc = {
        zona: r.zona, localizador: r.localizador, formato: r.formato,
        capacidad: r.capacidad, ocupado: r.ocupado, disponible: r.disponible,
        pct_ocupacion: r.pct_ocupacion, activo: r.activo,
      };
      const { error } = await db.from("localizadores")
        .upsert(payload, { onConflict: "zona,localizador" });
      if (error) errors++;
    }
    setSavingLoc(false);
    if (errors) showToast(`${errors} errores al guardar`, false);
    else { showToast(`${dirty.length} localizadores guardados`); loadLocs(); }
  }

  // ── Save lineas ─────────────────────────────────────────────────────────────
  async function saveLineas() {
    const dirty = lineas.filter(r => r._dirty);
    if (!dirty.length) return showToast("No hay cambios para guardar");
    setSavingLineas(true);
    let errors = 0;
    const now = new Date().toISOString();
    for (const r of dirty) {
      if (r._new) {
        const { error } = await db.from("lineas_reubicacion").insert({
          numero_orden: r.numero_orden, cod_org_inv: r.cod_org_inv, codigo: r.codigo,
          descripcion: r.descripcion,
          subinventario_origen: r.subinventario_origen, localizador_origen: r.localizador_origen,
          lote: r.lote, cantidad_fisica: r.cantidad_fisica, pallets: r.pallets, cajas: r.cajas,
          subinventario_destino: r.subinventario_destino, localizador_destino: r.localizador_destino,
          responsable: r.responsable, inv_pe: r.inv_pe, notas: r.notas,
          estado: "pendiente", created_at: now, updated_at: now,
        });
        if (error) errors++;
      } else {
        const { error } = await db.from("lineas_reubicacion")
          .update({
            numero_orden: r.numero_orden, cod_org_inv: r.cod_org_inv, codigo: r.codigo,
            descripcion: r.descripcion,
            subinventario_origen: r.subinventario_origen, localizador_origen: r.localizador_origen,
            lote: r.lote, cantidad_fisica: r.cantidad_fisica, pallets: r.pallets, cajas: r.cajas,
            subinventario_destino: r.subinventario_destino, localizador_destino: r.localizador_destino,
            responsable: r.responsable, inv_pe: r.inv_pe, notas: r.notas,
            updated_at: now,
          })
          .eq("id", r.id);
        if (error) errors++;
      }
    }
    setSavingLineas(false);
    if (errors) showToast(`${errors} errores al guardar`, false);
    else { showToast(`${dirty.length} líneas guardadas`); loadLineas(); }
  }

  // ── Range update – Locs ─────────────────────────────────────────────────────
  function applyRangeLoc() {
    const from = Math.max(0, parseInt(rangeFromLoc) - 1);
    const to   = Math.min(locs.length - 1, parseInt(rangeToLoc) - 1);
    if (isNaN(from) || isNaN(to) || from > to) return showToast("Rango inválido", false);
    let count = 0;
    setLocs(prev => prev.map((r, i) => {
      if (i < from || i > to) return r;
      count++;
      const next = { ...r, _dirty: true };
      if (rangeFieldLoc === "activo") {
        next.activo = rangeValueLoc === "true" || rangeValueLoc === "1";
      } else if (rangeFieldLoc === "capacidad" || rangeFieldLoc === "ocupado") {
        (next as Record<string, unknown>)[rangeFieldLoc] = N(rangeValueLoc);
        const cap = rangeFieldLoc === "capacidad" ? N(rangeValueLoc) : r.capacidad;
        const occ = rangeFieldLoc === "ocupado"   ? N(rangeValueLoc) : r.ocupado;
        next.disponible    = calcDisp(cap, occ);
        next.pct_ocupacion = calcPct(occ, cap);
      } else {
        (next as Record<string, unknown>)[rangeFieldLoc] = rangeValueLoc;
      }
      return next;
    }));
    showToast(`Valor aplicado a ${count} filas. Presiona GUARDAR para confirmar.`);
  }

  // ── Range update – Lineas ───────────────────────────────────────────────────
  function applyRangeLineas() {
    const from = Math.max(0, parseInt(rangeFromLineas) - 1);
    const to   = Math.min(lineas.length - 1, parseInt(rangeToLineas) - 1);
    if (isNaN(from) || isNaN(to) || from > to) return showToast("Rango inválido", false);
    let count = 0;
    setLineas(prev => prev.map((r, i) => {
      if (i < from || i > to) return r;
      count++;
      const next = { ...r, _dirty: true };
      const numFields = ["pallets", "cajas", "cantidad_fisica", "inv_pe"];
      if (numFields.includes(rangeFieldLineas)) {
        (next as Record<string, unknown>)[rangeFieldLineas] = N(rangeValueLineas) || null;
      } else {
        (next as Record<string, unknown>)[rangeFieldLineas] = rangeValueLineas || null;
      }
      return next;
    }));
    showToast(`Valor aplicado a ${count} filas. Presiona GUARDAR para confirmar.`);
  }

  // ── Catalog helpers ─────────────────────────────────────────────────────────
  function editCatalog(codigo: string, field: keyof CatalogRow, value: unknown) {
    setCatalog(prev => prev.map(r => {
      if (r.codigo !== codigo) return r;
      const next = { ...r, [field]: value, _dirty: true };
      next._emptyFields = getCriticalEmpty(next);
      return next;
    }));
  }

  async function saveCatalog() {
    const dirty = catalog.filter(r => r._dirty);
    if (!dirty.length) return showToast("No hay cambios para guardar");
    setSavingCatalog(true);
    let errors = 0;
    for (const r of dirty) {
      const { error } = await db.from("catalogo_productos").upsert({
        codigo: r.codigo,
        descripcion: r.descripcion,
        formato: r.formato || null,
        cajas_por_piso: r.cajas_por_piso || null,
        cajas_por_pallet: r.cajas_por_pallet || null,
        unidad_de_medida: r.unidad_de_medida || null,
        m2_por_caja: r.m2_por_caja || null,
        m2_x_pe: r.m2_x_pe || null,
      }, { onConflict: "codigo" });
      if (error) errors++;
    }
    setSavingCatalog(false);
    if (errors) showToast(`${errors} errores al guardar`, false);
    else { showToast(`${dirty.length} productos guardados`); loadCatalog(); }
  }

  function autoDetectFormatos() {
    let count = 0;
    setCatalog(prev => prev.map(r => {
      if (r.formato || !r._fmtSugerido) return r;
      count++;
      const next = { ...r, formato: r._fmtSugerido, _dirty: true };
      next._emptyFields = getCriticalEmpty(next);
      return next;
    }));
    if (count === 0) showToast("No hay formatos por detectar");
    else showToast(`${count} formatos detectados automáticamente. Presiona GUARDAR para confirmar.`);
  }

  // ── File diff – CAL_LOC ─────────────────────────────────────────────────────
  async function handleLocFile(file: File) {
    setDiffLoading(true);
    setDiffData(null);
    try {
      const buf = await file.arrayBuffer();
      const wb  = XLSX.read(buf, { type: "array" });
      if (!wb.SheetNames.includes("CAL_LOC")) {
        showToast("El archivo no contiene hoja CAL_LOC", false);
        setDiffLoading(false);
        return;
      }
      const incoming = parseCalLoc(wb);
      const { data: dbData, error } = await db.from("localizadores")
        .select("zona,localizador,formato,capacidad,ocupado,disponible,pct_ocupacion,activo");
      if (error) throw new Error(error.message);
      const dbMap: Record<string, Loc> = {};
      (dbData as Loc[]).forEach(r => { dbMap[`${r.zona}|${r.localizador}`] = r; });

      const changed: Loc[] = [];
      const newRows: Loc[] = [];
      let unchanged = 0;
      for (const row of incoming) {
        const existing = dbMap[`${row.zona}|${row.localizador}`];
        if (!existing) {
          newRows.push(row);
        } else if (existing.formato !== row.formato || existing.capacidad !== row.capacidad) {
          changed.push(row);
        } else {
          unchanged++;
        }
      }
      setDiffData({ changed, newRows, unchanged });
    } catch (e) {
      showToast("Error al procesar: " + (e instanceof Error ? e.message : String(e)), false);
    }
    setDiffLoading(false);
  }

  async function applyDiff() {
    if (!diffData) return;
    setApplyingDiff(true);
    const toApply = [...diffData.changed, ...diffData.newRows];
    const BATCH = 200;
    let errors = 0;
    for (let i = 0; i < toApply.length; i += BATCH) {
      const { error } = await db.from("localizadores")
        .upsert(toApply.slice(i, i + BATCH), { onConflict: "zona,localizador" });
      if (error) errors++;
    }
    setApplyingDiff(false);
    if (errors) showToast("Errores al aplicar", false);
    else { showToast(`${toApply.length} registros actualizados`); setDiffData(null); loadLocs(); }
  }

  // ── File upload – Lineas ────────────────────────────────────────────────────
  async function handleLineasFile(file: File) {
    setUploadingLineas(true);
    try {
      const { data: session } = await db.auth.getSession();
      const token = session?.session?.access_token;
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("http://localhost:8000/upload/excel", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.detail || "Error del servidor");
      showToast(`${result.count} registros procesados (${result.type})`);
      if (result.type === "produccion") loadLineas();
    } catch (e) {
      showToast("Error: " + (e instanceof Error ? e.message : String(e)), false);
    }
    setUploadingLineas(false);
  }

  // ── Derived ──────────────────────────────────────────────────────────────────
  const dirtyLocs    = locs.filter(r => r._dirty).length;
  const dirtyLineas  = lineas.filter(r => r._dirty).length;
  const dirtyCatalog = catalog.filter(r => r._dirty).length;
  const visibleCatalog = catFilter === "empty"
    ? catalog.filter(r => r._emptyFields.length > 0)
    : catalog;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      {toast && (
        <div style={{
          ...s.toast,
          background:   toast.ok ? "#14532d" : "#450a0a",
          borderColor:  toast.ok ? "#22c55e"  : "#ef4444",
        }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={s.header}>
        <div style={s.badge}>ADMIN CONFIG</div>
        <h1 style={s.title}>Panel de Configuración</h1>
        <p style={s.sub}>Gestión de datos maestros · sin eliminación de registros</p>
      </div>

      {/* Tab bar */}
      <div style={s.tabBar}>
        <button
          style={{ ...s.tab, ...(tab === "loc" ? s.tabActive : {}) }}
          onClick={() => setTab("loc")}
        >
          ⬡ LOCALIZADORES
          {dirtyLocs > 0 && <span style={s.dirtyBadge}>{dirtyLocs}</span>}
        </button>
        <button
          style={{ ...s.tab, ...(tab === "lineas" ? s.tabActive : {}) }}
          onClick={() => setTab("lineas")}
        >
          📋 LÍNEAS REUBICACIÓN
          {dirtyLineas > 0 && <span style={s.dirtyBadge}>{dirtyLineas}</span>}
        </button>
        <button
          style={{ ...s.tab, ...(tab === "catalogo" ? s.tabActive : {}) }}
          onClick={() => setTab("catalogo")}
        >
          📦 CATÁLOGO PRODUCTOS
          {dirtyCatalog > 0 && <span style={s.dirtyBadge}>{dirtyCatalog}</span>}
        </button>
      </div>

      {/* ══ LOCALIZADORES ══════════════════════════════════════════════════════ */}
      {tab === "loc" && (
        <div>
          {/* Controls */}
          <div style={s.controls}>
            <select style={s.sel} value={zoneFilter} onChange={e => setZoneFilter(e.target.value)}>
              <option value="ALL">Todas las zonas</option>
              {zones.map(z => <option key={z} value={z}>{z}</option>)}
            </select>

            <button style={s.btnOrange} onClick={addLocRow}>+ AGREGAR FILA</button>

            <button
              style={{ ...s.btnOrange, opacity: dirtyLocs ? 1 : 0.4 }}
              onClick={saveLocs}
              disabled={savingLoc}
            >
              {savingLoc ? "Guardando…" : `GUARDAR CAMBIOS${dirtyLocs ? ` (${dirtyLocs})` : ""}`}
            </button>

            <button style={s.btnGray} onClick={() => setShowRangeLoc(v => !v)}>
              {showRangeLoc ? "▲" : "▼"} RANGO
            </button>

            <button style={s.btnGray} onClick={() => { setShowDiff(v => !v); setDiffData(null); }}>
              {showDiff ? "▲" : "▼"} SUBIR ARCHIVO
            </button>
          </div>

          {/* Range panel – Locs */}
          {showRangeLoc && (
            <div style={s.panel}>
              <div style={s.panelTitle}>ACTUALIZAR POR RANGO</div>
              <div style={s.rangeRow}>
                <label style={s.rangeLabel}>Filas</label>
                <input style={{ ...s.inp, width: 64 }} type="number" min="1"
                  value={rangeFromLoc} onChange={e => setRangeFromLoc(e.target.value)} placeholder="desde" />
                <span style={s.rangeLabel}>—</span>
                <input style={{ ...s.inp, width: 64 }} type="number" min="1"
                  value={rangeToLoc} onChange={e => setRangeToLoc(e.target.value)} placeholder="hasta" />

                <label style={s.rangeLabel}>Campo</label>
                <select style={s.sel} value={rangeFieldLoc} onChange={e => setRangeFieldLoc(e.target.value)}>
                  <option value="formato">Formato</option>
                  <option value="capacidad">Capacidad</option>
                  <option value="ocupado">Ocupado</option>
                  <option value="activo">Activo</option>
                </select>

                <label style={s.rangeLabel}>Valor</label>
                {rangeFieldLoc === "activo" ? (
                  <select style={s.sel} value={rangeValueLoc} onChange={e => setRangeValueLoc(e.target.value)}>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input style={s.inp} value={rangeValueLoc}
                    onChange={e => setRangeValueLoc(e.target.value)} placeholder="nuevo valor" />
                )}

                <button style={s.btnOrange} onClick={applyRangeLoc}>APLICAR</button>
              </div>
              <p style={s.hint}>
                Los cambios se marcan en naranja · presiona GUARDAR CAMBIOS para confirmar en BD
              </p>
            </div>
          )}

          {/* Diff panel */}
          {showDiff && (
            <div style={s.panel}>
              <div style={s.panelTitle}>SUBIR ARCHIVO CAL_LOC — DETECCIÓN DE CAMBIOS</div>
              <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
                <button style={s.btnOrange} disabled={diffLoading}
                  onClick={() => fileRefLoc.current?.click()}>
                  {diffLoading ? "Analizando…" : "SELECCIONAR EXCEL"}
                </button>
                <input ref={fileRefLoc} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) { handleLocFile(f); e.target.value = ""; } }} />
                <span style={{ fontSize: 11, color: "#6b7280" }}>Requiere hoja CAL_LOC</span>
              </div>

              {diffData && (
                <div style={s.diffBox}>
                  <div style={s.diffStats}>
                    <div style={{ color: "#fbbf24" }}>~ {diffData.changed.length} modificados</div>
                    <div style={{ color: "#4ade80" }}>+ {diffData.newRows.length} nuevos</div>
                    <div style={{ color: "#6b7280" }}>=  {diffData.unchanged} sin cambios</div>
                  </div>
                  {diffData.changed.length + diffData.newRows.length === 0 ? (
                    <p style={{ fontSize: 12, color: "#4ade80", marginTop: 10 }}>
                      ✓ Sin cambios — la BD ya está actualizada
                    </p>
                  ) : (
                    <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                      <button style={s.btnOrange} onClick={applyDiff} disabled={applyingDiff}>
                        {applyingDiff
                          ? "Aplicando…"
                          : `APLICAR CAMBIOS (${diffData.changed.length + diffData.newRows.length})`}
                      </button>
                      <button style={s.btnGray} onClick={() => setDiffData(null)}>DESCARTAR</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Table */}
          <div style={s.tableWrap}>
            {loadingLoc ? (
              <div style={s.loading}>Cargando localizadores…</div>
            ) : (
              <table style={s.table}>
                <thead>
                  <tr>
                    {["#","ZONA","LOCALIZADOR","FORMATO","CAPACIDAD","OCUPADO","DISPONIBLE","PCT %","ACTIVO",""].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {locs.map((r, i) => (
                    <tr key={r._key} style={{
                      background: r._dirty
                        ? "rgba(249,115,22,0.07)"
                        : i % 2 === 0 ? "#0d1117" : "#080c14",
                    }}>
                      <td style={{ ...s.td, color: "#4a5568", width: 36 }}>{i + 1}</td>
                      <td style={s.td}>
                        {r._new ? (
                          <select style={s.cellSel} value={r.zona}
                            onChange={e => editLoc(r._key, "zona", e.target.value)}>
                            {zones.map(z => <option key={z} value={z}>{z}</option>)}
                          </select>
                        ) : (
                          <span style={{ color: "#f97316", fontSize: 11 }}>{r.zona}</span>
                        )}
                      </td>
                      <td style={s.td}>
                        {r._new ? (
                          <input style={{ ...s.cellInp, width: 80 }} value={r.localizador}
                            onChange={e => editLoc(r._key, "localizador", e.target.value)}
                            placeholder="LOC" />
                        ) : (
                          <span style={{ color: "#e2e8f0", fontSize: 11 }}>{r.localizador}</span>
                        )}
                      </td>
                      <td style={s.td}>
                        <input style={{ ...s.cellInp, width: 90 }} value={r.formato}
                          onChange={e => editLoc(r._key, "formato", e.target.value)} />
                      </td>
                      <td style={s.td}>
                        <input style={{ ...s.cellInp, width: 68 }} type="number" value={r.capacidad}
                          onChange={e => editLoc(r._key, "capacidad", N(e.target.value))} />
                      </td>
                      <td style={s.td}>
                        <input style={{ ...s.cellInp, width: 68 }} type="number" value={r.ocupado}
                          onChange={e => editLoc(r._key, "ocupado", N(e.target.value))} />
                      </td>
                      <td style={{ ...s.td, color: "#6b7280", fontSize: 11 }}>{r.disponible}</td>
                      <td style={{
                        ...s.td, fontSize: 11,
                        color: r.pct_ocupacion > 0.8 ? "#f87171" : r.pct_ocupacion > 0.6 ? "#fbbf24" : "#4ade80",
                      }}>
                        {(r.pct_ocupacion * 100).toFixed(1)}%
                      </td>
                      <td style={s.td}>
                        <input type="checkbox" checked={r.activo}
                          onChange={e => editLoc(r._key, "activo", e.target.checked)} />
                      </td>
                      <td style={{ ...s.td, width: 16 }}>
                        {r._dirty && <span style={{ color: "#f97316", fontSize: 10 }}>●</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p style={s.footer}>{locs.length} registros · ● cambios sin guardar · disponible y % se calculan automáticamente</p>
        </div>
      )}

      {/* ══ LINEAS REUBICACIÓN ══════════════════════════════════════════════════ */}
      {tab === "lineas" && (
        <div>
          {/* Controls */}
          <div style={s.controls}>
            <select style={s.sel} value={estadoFilter} onChange={e => setEstadoFilter(e.target.value)}>
              <option value="ALL">Todos los estados</option>
              {["pendiente","aprobada","rechazada","en_proceso","completada"].map(e => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>

            <button style={s.btnOrange} onClick={addLineaRow}>+ AGREGAR FILA</button>

            <button
              style={{ ...s.btnOrange, opacity: dirtyLineas ? 1 : 0.4 }}
              onClick={saveLineas}
              disabled={savingLineas}
            >
              {savingLineas ? "Guardando…" : `GUARDAR CAMBIOS${dirtyLineas ? ` (${dirtyLineas})` : ""}`}
            </button>

            <button style={s.btnGray} onClick={() => setShowRangeLineas(v => !v)}>
              {showRangeLineas ? "▲" : "▼"} RANGO
            </button>

            <button style={s.btnGray} disabled={uploadingLineas}
              onClick={() => fileRefLineas.current?.click()}>
              {uploadingLineas ? "Subiendo…" : "SUBIR PRODUCCIÓN"}
            </button>
            <input ref={fileRefLineas} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) { handleLineasFile(f); e.target.value = ""; } }} />
          </div>

          {/* Range panel – Lineas */}
          {showRangeLineas && (
            <div style={s.panel}>
              <div style={s.panelTitle}>ACTUALIZAR POR RANGO</div>
              <div style={s.rangeRow}>
                <label style={s.rangeLabel}>Filas</label>
                <input style={{ ...s.inp, width: 64 }} type="number" min="1"
                  value={rangeFromLineas} onChange={e => setRangeFromLineas(e.target.value)} placeholder="desde" />
                <span style={s.rangeLabel}>—</span>
                <input style={{ ...s.inp, width: 64 }} type="number" min="1"
                  value={rangeToLineas} onChange={e => setRangeToLineas(e.target.value)} placeholder="hasta" />

                <label style={s.rangeLabel}>Campo</label>
                <select style={s.sel} value={rangeFieldLineas} onChange={e => setRangeFieldLineas(e.target.value)}>
                  <option value="responsable">Responsable</option>
                  <option value="subinventario_destino">Subinv. Destino</option>
                  <option value="localizador_destino">Loc. Destino</option>
                  <option value="lote">Lote</option>
                  <option value="notas">Notas</option>
                  <option value="pallets">Pallets</option>
                  <option value="cajas">Cajas</option>
                </select>

                <label style={s.rangeLabel}>Valor</label>
                <input style={s.inp} value={rangeValueLineas}
                  onChange={e => setRangeValueLineas(e.target.value)} placeholder="nuevo valor" />

                <button style={s.btnOrange} onClick={applyRangeLineas}>APLICAR</button>
              </div>
              <p style={s.hint}>
                Los cambios se marcan en naranja · presiona GUARDAR CAMBIOS para confirmar en BD
              </p>
            </div>
          )}

          {/* Table – wide, scrollable */}
          <div style={{ ...s.tableWrap, overflowX: "auto" }}>
            {loadingLineas ? (
              <div style={s.loading}>Cargando líneas…</div>
            ) : (
              <table style={{ ...s.table, minWidth: 1500 }}>
                <thead>
                  <tr>
                    {["#","ORDEN","COD ORG","CÓDIGO","DESCRIPCIÓN","SUBINV ORI","LOC ORI","LOTE",
                      "CANT FÍS","PALLETS","CAJAS","SUBINV DEST","LOC DEST","RESPONSABLE",
                      "INV-PE","NOTAS","ESTADO",""].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lineas.map((r, i) => (
                    <tr key={r.id} style={{
                      background: r._dirty
                        ? "rgba(249,115,22,0.07)"
                        : i % 2 === 0 ? "#0d1117" : "#080c14",
                    }}>
                      <td style={{ ...s.td, color: "#4a5568" }}>{i + 1}</td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 80 }}
                        value={S(r.numero_orden)}
                        onChange={e => editLinea(r.id, "numero_orden", e.target.value || null)} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 78 }}
                        value={S(r.cod_org_inv)}
                        onChange={e => editLinea(r.id, "cod_org_inv", e.target.value || null)} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 78 }}
                        value={S(r.codigo)}
                        onChange={e => editLinea(r.id, "codigo", e.target.value || null)} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 160 }}
                        value={r.descripcion}
                        onChange={e => editLinea(r.id, "descripcion", e.target.value)} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 100 }}
                        value={S(r.subinventario_origen)}
                        onChange={e => editLinea(r.id, "subinventario_origen", e.target.value || null)} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 78 }}
                        value={S(r.localizador_origen)}
                        onChange={e => editLinea(r.id, "localizador_origen", e.target.value || null)} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 78 }}
                        value={S(r.lote)}
                        onChange={e => editLinea(r.id, "lote", e.target.value || null)} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 66 }} type="number"
                        value={r.cantidad_fisica}
                        onChange={e => editLinea(r.id, "cantidad_fisica", N(e.target.value))} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 58 }} type="number"
                        value={r.pallets}
                        onChange={e => editLinea(r.id, "pallets", N(e.target.value))} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 58 }} type="number"
                        value={r.cajas}
                        onChange={e => editLinea(r.id, "cajas", N(e.target.value))} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 100 }}
                        value={S(r.subinventario_destino)}
                        onChange={e => editLinea(r.id, "subinventario_destino", e.target.value || null)} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 78 }}
                        value={S(r.localizador_destino)}
                        onChange={e => editLinea(r.id, "localizador_destino", e.target.value || null)} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 100 }}
                        value={S(r.responsable)}
                        onChange={e => editLinea(r.id, "responsable", e.target.value || null)} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 56 }} type="number"
                        value={S(r.inv_pe)}
                        onChange={e => editLinea(r.id, "inv_pe", N(e.target.value) || null)} /></td>
                      <td style={s.td}><input style={{ ...s.cellInp, width: 120 }}
                        value={S(r.notas)}
                        onChange={e => editLinea(r.id, "notas", e.target.value || null)} /></td>
                      <td style={s.td}>
                        <span style={{ ...s.estadoBadge, ...getEstadoStyle(r.estado) }}>{r.estado}</span>
                      </td>
                      <td style={{ ...s.td, width: 16 }}>
                        {r._dirty && <span style={{ color: "#f97316", fontSize: 10 }}>●</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p style={s.footer}>{lineas.length} registros · ● cambios sin guardar · estado sigue el flujo de aprobación</p>
        </div>
      )}

      {/* ══ CATÁLOGO PRODUCTOS ══════════════════════════════════════════════════ */}
      {tab === "catalogo" && (
        <div>
          {/* Controls */}
          <div style={s.controls}>
            <select style={s.sel} value={catFilter}
              onChange={e => setCatFilter(e.target.value as "all" | "empty")}>
              <option value="all">Todos los productos</option>
              <option value="empty">⚠ Con campos vacíos</option>
            </select>

            <button style={s.btnGray} onClick={autoDetectFormatos}>
              ⚡ AUTO-DETECTAR FORMATOS
            </button>

            <button
              style={{ ...s.btnOrange, opacity: dirtyCatalog ? 1 : 0.4 }}
              onClick={saveCatalog}
              disabled={savingCatalog}
            >
              {savingCatalog ? "Guardando…" : `GUARDAR CAMBIOS${dirtyCatalog ? ` (${dirtyCatalog})` : ""}`}
            </button>

            <button style={s.btnGray} onClick={loadCatalog} disabled={loadingCatalog}>
              ↻ RECARGAR
            </button>

            <span style={{ fontSize: 11, color: "#4a5568", marginLeft: 8 }}>
              {catalog.filter(r => r._emptyFields.length > 0).length} con campos vacíos ·{" "}
              {catalog.filter(r => r._new).length} nuevos (solo en lineas)
            </span>
          </div>

          {/* Legend */}
          <div style={s.catLegend}>
            <span style={s.legendNew}>◆ NUEVO</span>
            <span style={s.legendWarn}>⚠ CAMPO VACÍO</span>
            <span style={{ fontSize: 10, color: "#4a5568" }}>
              Haz clic en ⚠ para rellenar el formato sugerido desde la descripción
            </span>
          </div>

          {/* Table */}
          <div style={{ ...s.tableWrap, overflowX: "auto" }}>
            {loadingCatalog ? (
              <div style={s.loading}>Cargando catálogo…</div>
            ) : (
              <table style={{ ...s.table, minWidth: 1100 }}>
                <thead>
                  <tr>
                    {["#","ESTADO","CÓDIGO","DESCRIPCIÓN","FORMATO","CJ/PISO","CJ/PALLET","UNIDAD","M²/CAJA","M²/PE",""].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleCatalog.map((r, i) => (
                    <tr key={r.codigo} style={{
                      background: r._dirty
                        ? "rgba(249,115,22,0.07)"
                        : i % 2 === 0 ? "#0d1117" : "#080c14",
                    }}>
                      <td style={{ ...s.td, color: "#4a5568", width: 36 }}>{i + 1}</td>

                      {/* Estado badge */}
                      <td style={{ ...s.td, width: 72 }}>
                        {r._new ? (
                          <span style={s.catBadgeNew}>NUEVO</span>
                        ) : r._emptyFields.length > 0 ? (
                          <span style={s.catBadgeWarn}>
                            ⚠ {r._emptyFields.length}
                          </span>
                        ) : (
                          <span style={s.catBadgeOk}>✓</span>
                        )}
                      </td>

                      <td style={s.td}>
                        <span style={{ color: "#f97316", fontSize: 11, whiteSpace: "nowrap" }}>{r.codigo}</span>
                      </td>

                      <td style={s.td}>
                        <span style={{ color: "#e2e8f0", fontSize: 11 }}>{r.descripcion}</span>
                      </td>

                      {/* Formato – editable, con sugerencia */}
                      <td style={s.td}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <input
                            style={{ ...s.cellInp, width: 90,
                              borderColor: !r.formato ? "rgba(251,191,36,0.5)" : "rgba(249,115,22,0.1)" }}
                            value={r.formato ?? ""}
                            placeholder={r._fmtSugerido || "—"}
                            onChange={e => editCatalog(r.codigo, "formato", e.target.value || null)}
                          />
                          {!r.formato && r._fmtSugerido && (
                            <button
                              title={`Usar: ${r._fmtSugerido}`}
                              style={s.warnBtn}
                              onClick={() => editCatalog(r.codigo, "formato", r._fmtSugerido)}
                            >⚠</button>
                          )}
                        </div>
                      </td>

                      {/* Cajas por piso */}
                      <td style={s.td}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <input
                            style={{ ...s.cellInp, width: 58,
                              borderColor: !r.cajas_por_piso ? "rgba(251,191,36,0.5)" : "rgba(249,115,22,0.1)" }}
                            type="number" min="0"
                            value={r.cajas_por_piso ?? ""}
                            placeholder="—"
                            onChange={e => editCatalog(r.codigo, "cajas_por_piso", N(e.target.value) || null)}
                          />
                          {!r.cajas_por_piso && <span style={s.emptyDot}>⚠</span>}
                        </div>
                      </td>

                      {/* Cajas por pallet */}
                      <td style={s.td}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <input
                            style={{ ...s.cellInp, width: 58,
                              borderColor: !r.cajas_por_pallet ? "rgba(251,191,36,0.5)" : "rgba(249,115,22,0.1)" }}
                            type="number" min="0"
                            value={r.cajas_por_pallet ?? ""}
                            placeholder="—"
                            onChange={e => editCatalog(r.codigo, "cajas_por_pallet", N(e.target.value) || null)}
                          />
                          {!r.cajas_por_pallet && <span style={s.emptyDot}>⚠</span>}
                        </div>
                      </td>

                      {/* Unidad de medida */}
                      <td style={s.td}>
                        <input
                          style={{ ...s.cellInp, width: 60 }}
                          value={r.unidad_de_medida ?? ""}
                          placeholder="—"
                          onChange={e => editCatalog(r.codigo, "unidad_de_medida", e.target.value || null)}
                        />
                      </td>

                      {/* M² por caja */}
                      <td style={s.td}>
                        <input
                          style={{ ...s.cellInp, width: 62 }}
                          type="number" step="0.01" min="0"
                          value={r.m2_por_caja ?? ""}
                          placeholder="—"
                          onChange={e => editCatalog(r.codigo, "m2_por_caja", N(e.target.value) || null)}
                        />
                      </td>

                      {/* M² x PE */}
                      <td style={s.td}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <input
                            style={{ ...s.cellInp, width: 62,
                              borderColor: !r.m2_x_pe ? "rgba(251,191,36,0.5)" : "rgba(249,115,22,0.1)" }}
                            type="number" step="0.01" min="0"
                            value={r.m2_x_pe ?? ""}
                            placeholder="—"
                            onChange={e => editCatalog(r.codigo, "m2_x_pe", N(e.target.value) || null)}
                          />
                          {!r.m2_x_pe && <span style={s.emptyDot}>⚠</span>}
                        </div>
                      </td>

                      <td style={{ ...s.td, width: 16 }}>
                        {r._dirty && <span style={{ color: "#f97316", fontSize: 10 }}>●</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p style={s.footer}>
            {visibleCatalog.length} / {catalog.length} registros · ⚠ campos críticos vacíos afectan el análisis
            · ● cambios sin guardar
          </p>
        </div>
      )}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const s: { [k: string]: React.CSSProperties } = {
  root: {
    padding: "32px",
    fontFamily: "'Courier New', monospace",
    color: "#e2e8f0",
    minHeight: "100vh",
    background: "#0a0e17",
    position: "relative",
  },
  toast: {
    position: "fixed", top: 20, right: 20, zIndex: 9999,
    padding: "12px 20px", borderRadius: 4, border: "1px solid",
    fontSize: 12, letterSpacing: 1, fontFamily: "'Courier New', monospace",
    maxWidth: 360,
  },
  header: { marginBottom: 24 },
  badge: {
    display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316",
    border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", marginBottom: 10,
  },
  title: { margin: "0 0 6px", fontSize: 26, fontWeight: 700, color: "#fff", letterSpacing: 1 },
  sub:   { margin: 0, fontSize: 12, color: "#4a5568" },

  tabBar: { display: "flex", borderBottom: "1px solid rgba(249,115,22,0.15)", marginBottom: 20 },
  tab: {
    background: "transparent", border: "none", borderBottom: "2px solid transparent",
    color: "#6b7280", fontSize: 11, letterSpacing: 2, padding: "10px 20px",
    cursor: "pointer", fontFamily: "'Courier New', monospace",
    display: "flex", alignItems: "center", gap: 6,
  },
  tabActive: { color: "#f97316", borderBottom: "2px solid #f97316" },
  dirtyBadge: {
    background: "#f97316", color: "#000", fontSize: 9, borderRadius: "50%",
    width: 16, height: 16, display: "inline-flex", alignItems: "center",
    justifyContent: "center", fontWeight: 700,
  },

  controls: { display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" as const },
  sel: {
    background: "#0d1117", border: "1px solid rgba(249,115,22,0.2)",
    color: "#e2e8f0", fontSize: 11, padding: "7px 10px",
    fontFamily: "'Courier New', monospace", borderRadius: 2, cursor: "pointer",
  },
  btnOrange: {
    background: "#f97316", border: "none", color: "#000",
    fontSize: 11, fontWeight: 700, letterSpacing: 1.5, padding: "8px 16px",
    cursor: "pointer", fontFamily: "'Courier New', monospace", borderRadius: 2,
    whiteSpace: "nowrap" as const,
  },
  btnGray: {
    background: "transparent", border: "1px solid rgba(249,115,22,0.2)",
    color: "#6b7280", fontSize: 11, letterSpacing: 1.5, padding: "8px 14px",
    cursor: "pointer", fontFamily: "'Courier New', monospace", borderRadius: 2,
  },

  panel: {
    background: "#0d1117", border: "1px solid rgba(249,115,22,0.15)",
    borderRadius: 4, padding: "16px 20px", marginBottom: 14,
  },
  panelTitle: { fontSize: 10, letterSpacing: 3, color: "#f97316", marginBottom: 12 },
  rangeRow: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" as const },
  rangeLabel: { fontSize: 11, color: "#6b7280", letterSpacing: 0.5 },
  inp: {
    background: "#080c14", border: "1px solid rgba(249,115,22,0.2)",
    color: "#e2e8f0", fontSize: 11, padding: "6px 9px",
    fontFamily: "'Courier New', monospace", borderRadius: 2, width: 120,
  },
  hint: { fontSize: 10, color: "#4a5568", margin: "10px 0 0", letterSpacing: 0.3 },

  diffBox: {
    background: "#080c14", border: "1px solid rgba(249,115,22,0.1)",
    borderRadius: 3, padding: "14px 18px",
  },
  diffStats: { display: "flex", gap: 28, fontSize: 13, fontWeight: 700 },

  tableWrap: {
    overflowY: "auto", maxHeight: "62vh",
    border: "1px solid rgba(249,115,22,0.1)", borderRadius: 4,
  },
  loading: { padding: 40, textAlign: "center" as const, color: "#4a5568", fontSize: 12 },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 11 },
  th: {
    background: "#080c14", color: "#f97316", fontSize: 9, letterSpacing: 2,
    padding: "10px 10px", textAlign: "left" as const,
    position: "sticky" as const, top: 0,
    whiteSpace: "nowrap" as const, borderBottom: "1px solid rgba(249,115,22,0.2)",
    zIndex: 1,
  },
  td: {
    padding: "3px 7px", borderBottom: "1px solid rgba(255,255,255,0.03)",
    verticalAlign: "middle" as const,
  },
  cellInp: {
    background: "#080c14", border: "1px solid rgba(249,115,22,0.1)",
    color: "#e2e8f0", fontSize: 11, padding: "3px 6px",
    fontFamily: "'Courier New', monospace", borderRadius: 2,
  },
  cellSel: {
    background: "#080c14", border: "1px solid rgba(249,115,22,0.1)",
    color: "#e2e8f0", fontSize: 11, padding: "2px 4px",
    fontFamily: "'Courier New', monospace", borderRadius: 2,
  },
  estadoBadge: { padding: "2px 8px", borderRadius: 3, fontSize: 10, letterSpacing: 0.5 },
  footer: { fontSize: 11, color: "#4a5568", marginTop: 8 },

  catLegend: {
    display: "flex", gap: 20, alignItems: "center",
    fontSize: 10, marginBottom: 10, padding: "6px 0",
    borderBottom: "1px solid rgba(249,115,22,0.08)",
  },
  legendNew:  { color: "#60a5fa", letterSpacing: 1 },
  legendWarn: { color: "#fbbf24", letterSpacing: 1 },
  catBadgeNew: {
    background: "#1e3a5f", color: "#60a5fa",
    padding: "2px 7px", borderRadius: 3, fontSize: 9, letterSpacing: 1,
  },
  catBadgeWarn: {
    background: "#422006", color: "#fbbf24",
    padding: "2px 7px", borderRadius: 3, fontSize: 9, letterSpacing: 1,
  },
  catBadgeOk: {
    color: "#4ade80", fontSize: 12, paddingLeft: 6,
  },
  warnBtn: {
    background: "rgba(251,191,36,0.15)", border: "1px solid rgba(251,191,36,0.4)",
    color: "#fbbf24", fontSize: 10, padding: "2px 5px", cursor: "pointer",
    borderRadius: 2, fontFamily: "'Courier New', monospace",
  },
  emptyDot: {
    color: "rgba(251,191,36,0.4)", fontSize: 10,
  },
};
