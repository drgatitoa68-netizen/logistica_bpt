"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { getBrowserClient } from "@/lib/supabase/browser";
import * as XLSX from "xlsx";

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

  // Nueva zona / localizadores
  const [showNuevaZona, setShowNuevaZona] = useState(false);
  const [nzZona, setNzZona]             = useState("");
  const [nzDesde, setNzDesde]           = useState(1);
  const [nzHasta, setNzHasta]           = useState(10);
  const [nzFilas, setNzFilas]           = useState(1);
  const [nzCols, setNzCols]             = useState(1);
  const [nzCapacidad, setNzCapacidad]   = useState(20);
  const [nzFormato, setNzFormato]       = useState("Mezcla");
  const [nzPreview, setNzPreview]       = useState<string[]>([]);
  const [savingZona, setSavingZona]     = useState(false);

  // Catálogo de metraje
  const [catalogCount,    setCatalogCount]    = useState<number | null>(null);
  const [catalogLoading,  setCatalogLoading]  = useState(false);
  const [catalogDragging, setCatalogDragging] = useState(false);
  const catalogRef = useRef<HTMLInputElement>(null);

  // Operadores
  interface Operador { id: string; nombre: string; cedula: string; email: string; activo: boolean; }
  const [operadores,    setOperadores]    = useState<Operador[]>([]);
  const [opLoading,     setOpLoading]     = useState(false);
  const [opImporting,   setOpImporting]   = useState(false);
  const [showOpForm,    setShowOpForm]    = useState(false);
  const [newOp, setNewOp] = useState({ nombre: "", cedula: "", email: "" });
  const opFileRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => { load(); fetchCatalogCount(); loadOperadores(); }, [load]);

  async function fetchCatalogCount() {
    const { count } = await db
      .from("catalogo_metraje")
      .select("codigo", { count: "exact", head: true });
    setCatalogCount(count ?? 0);
  }

  async function loadOperadores() {
    setOpLoading(true);
    const { data } = await db.from("operadores").select("id,nombre,cedula,email,activo").order("nombre");
    if (data) setOperadores(data as Operador[]);
    setOpLoading(false);
  }

  async function agregarOperador() {
    if (!newOp.nombre.trim()) { showFlash("⚠ El nombre es obligatorio", false); return; }
    const { error } = await db.from("operadores").insert({
      nombre: newOp.nombre.trim(),
      cedula: newOp.cedula.trim() || null,
      email:  newOp.email.trim()  || null,
      activo: true,
    });
    if (error) { showFlash(`❌ ${error.message}`, false); return; }
    showFlash(`✓ Operador ${newOp.nombre} registrado`);
    setNewOp({ nombre: "", cedula: "", email: "" });
    setShowOpForm(false);
    loadOperadores();
  }

  async function toggleOperador(op: Operador) {
    const { error } = await db.from("operadores").update({ activo: !op.activo }).eq("id", op.id);
    if (!error) setOperadores(p => p.map(o => o.id === op.id ? { ...o, activo: !o.activo } : o));
    else showFlash(`❌ ${error.message}`, false);
  }

  async function importarOperadores(file: File) {
    setOpImporting(true);
    try {
      const buf  = await file.arrayBuffer();
      const wb   = XLSX.read(buf, { type: "array" });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];

      const norm = (v: unknown) =>
        String(v).trim().toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

      // Auto-detect header
      let hi = -1, niIdx = -1, ciIdx = -1, eiIdx = -1;
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const row = (rows[i] as unknown[]).map(norm);
        const ni = row.findIndex(c => c === "NOMBRE" || c === "OPERADOR" || c.startsWith("NOMB"));
        if (ni >= 0) {
          hi = i; niIdx = ni;
          ciIdx = row.findIndex((c, idx) => idx !== ni && (c === "CEDULA" || c === "IDENTIFICACION" || c === "CI" || c.startsWith("CED")));
          eiIdx = row.findIndex((c, idx) => idx !== ni && idx !== ciIdx && (c === "EMAIL" || c === "CORREO" || c.startsWith("MAIL")));
          break;
        }
      }
      if (hi < 0 || niIdx < 0) {
        showFlash("⚠ No se encontró columna NOMBRE en el archivo", false);
        setOpImporting(false);
        return;
      }

      const records: { nombre: string; cedula?: string; email?: string; activo: boolean }[] = [];
      for (let i = hi + 1; i < rows.length; i++) {
        const r = rows[i] as unknown[];
        const nombre = String(r[niIdx] || "").trim();
        if (!nombre) continue;
        records.push({
          nombre,
          cedula: ciIdx >= 0 ? String(r[ciIdx] || "").trim() || undefined : undefined,
          email:  eiIdx >= 0 ? String(r[eiIdx] || "").trim() || undefined : undefined,
          activo: true,
        });
      }
      if (!records.length) { showFlash("⚠ No se encontraron filas válidas", false); setOpImporting(false); return; }

      const BATCH = 200;
      let done = 0, errors = 0;
      for (let i = 0; i < records.length; i += BATCH) {
        const { error } = await db.from("operadores")
          .upsert(records.slice(i, i + BATCH), { onConflict: "cedula", ignoreDuplicates: false });
        if (error) errors++;
        else done += Math.min(BATCH, records.length - i);
      }
      setOpImporting(false);
      if (!errors) { showFlash(`✓ ${done} operadores importados`); loadOperadores(); }
      else showFlash(`⚠ ${done} importados, ${errors} lotes con error`, false);
    } catch (e) {
      setOpImporting(false);
      showFlash(`❌ ${e instanceof Error ? e.message : String(e)}`, false);
    }
  }

  async function uploadCatalog(file: File) {
    setCatalogLoading(true);
    showFlash("Leyendo catálogo…");
    try {
      const buf  = await file.arrayBuffer();
      const wb   = XLSX.read(buf, { type: "array" });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];

      // Auto-detectar columnas
      const norm = (v: unknown) =>
        String(v).trim().toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Z0-9 ]/g, "");

      let headerIdx = -1, codIdx = -1, metIdx = -1, descIdx = -1;
      for (let i = 0; i < Math.min(20, rows.length); i++) {
        const row = (rows[i] as unknown[]).map(norm);
        const ci = row.findIndex(c =>
          c === "CODIGO" || c === "COD" || c === "CODART" || c === "ITEM" ||
          c === "SKU" || c.startsWith("COD") || c === "ARTICULO"
        );
        const mi = row.findIndex(c =>
          c === "METRAJE" || c === "M2" || c === "M " || c === "METROS" ||
          c === "AREA" || c.includes("METRO") || c.includes("METRAJE")
        );
        if (ci >= 0 && mi >= 0) {
          headerIdx = i; codIdx = ci; metIdx = mi;
          descIdx = row.findIndex((c, idx) =>
            idx !== ci && idx !== mi && (c.startsWith("DESC") || c === "NOMBRE" || c === "PRODUCTO")
          );
          break;
        }
      }

      if (headerIdx < 0 || codIdx < 0 || metIdx < 0) {
        showFlash("⚠ No se encontraron columnas CÓDIGO y METRAJE en el archivo", false);
        setCatalogLoading(false);
        return;
      }

      const records: { codigo: string; metraje_por_pallet: number; descripcion?: string }[] = [];
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const r   = rows[i] as unknown[];
        const cod = String(r[codIdx] || "").trim();
        const raw = parseFloat(String(r[metIdx] || "0").replace(",", ".")) || 0;
        if (!cod || raw <= 0) continue;
        records.push({
          codigo:             cod.toUpperCase(),
          metraje_por_pallet: Math.round(raw * 10000) / 10000,
          ...(descIdx >= 0 ? { descripcion: String(r[descIdx] || "").trim() } : {}),
        });
      }

      if (!records.length) {
        showFlash("⚠ No se encontraron filas válidas (código + metraje > 0)", false);
        setCatalogLoading(false);
        return;
      }

      // Upsert en lotes de 500
      const BATCH = 500;
      let done = 0, errors = 0;
      for (let i = 0; i < records.length; i += BATCH) {
        const { error } = await db.from("catalogo_metraje")
          .upsert(records.slice(i, i + BATCH), { onConflict: "codigo" });
        if (error) errors++;
        else done += Math.min(BATCH, records.length - i);
      }

      setCatalogLoading(false);
      if (errors === 0) {
        showFlash(`✓ Catálogo cargado: ${done} productos con metraje`);
        fetchCatalogCount();
      } else {
        showFlash(`⚠ ${done} cargados, ${errors} lotes con error`, false);
      }
    } catch (e) {
      setCatalogLoading(false);
      showFlash(`❌ ${e instanceof Error ? e.message : String(e)}`, false);
    }
  }

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

  // ── Generate localizador codes for preview ───────────────────────────────
  function generarLocalizadores(zona: string, desde: number, hasta: number, filas: number, cols: number): string[] {
    const locs: string[] = [];
    const z = zona.replace(/\s+/g, "").padStart(2, "0");
    for (let n = desde; n <= hasta; n++) {
      for (let f = 1; f <= filas; f++) {
        for (let c = 1; c <= cols; c++) {
          const loc = `${z}.${String(n).padStart(2,"0")}.${String(f).padStart(2,"0")}.${String(c).padStart(2,"0")}`;
          locs.push(loc);
        }
      }
    }
    return locs;
  }

  function actualizarPreview() {
    if (!nzZona.trim()) { setNzPreview([]); return; }
    const locs = generarLocalizadores(nzZona, nzDesde, nzHasta, nzFilas, nzCols);
    setNzPreview(locs.slice(0, 30));
  }

  async function crearZona() {
    if (!nzZona.trim()) { showFlash("⚠ Ingresa el nombre de la zona", false); return; }
    const locs = generarLocalizadores(nzZona, nzDesde, nzHasta, nzFilas, nzCols);
    if (!locs.length) { showFlash("⚠ No se generaron localizadores", false); return; }
    setSavingZona(true);
    const records = locs.map(loc => ({
      zona: nzZona.trim().toUpperCase(),
      localizador: loc,
      formato: nzFormato || "Mezcla",
      capacidad: nzCapacidad,
      ocupado: 0,
      disponible: nzCapacidad,
      pct_ocupacion: 0,
      activo: true,
    }));
    const BATCH = 200;
    let errors = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      const { error } = await db.from("localizadores").upsert(records.slice(i, i + BATCH), { onConflict: "zona,localizador" });
      if (error) errors++;
    }
    setSavingZona(false);
    if (errors > 0) showFlash(`⚠ ${errors} lotes con error`, false);
    else showFlash(`✓ Zona ${nzZona.toUpperCase()} creada con ${locs.length} localizadores`);
    setShowNuevaZona(false);
    setNzZona(""); setNzDesde(1); setNzHasta(10); setNzFilas(1); setNzCols(1); setNzPreview([]);
    load();
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
    setRows(prev => prev.map(r =>
      r.zona === edit.zona && r.localizador === edit.localizador
        ? { ...r, [edit.field]: edit.value }
        : r
    ));
    showFlash(`✓ ${edit.localizador} — ${edit.field} actualizado`);
    setEdit(null);
  }

  async function toggleBlock(r: Localizador) {
    setSaving(true);
    const newActivo = !r.activo;
    const { error } = await db
      .from("localizadores")
      .update({ activo: newActivo })
      .eq("zona", r.zona)
      .eq("localizador", r.localizador);
    setSaving(false);
    if (error) { showFlash("❌ " + error.message, false); return; }
    setRows(prev => prev.map(row =>
      row.zona === r.zona && row.localizador === r.localizador
        ? { ...row, activo: newActivo }
        : row
    ));
    showFlash(`✓ ${r.localizador} ${r.activo ? "bloqueado" : "desbloqueado"}`);
  }

  async function applyBulk() {
    if (bulkActivo === null && bulkCapacidad === "") { showFlash("⚠ Define al menos un cambio", false); return; }
    const newCapacidad = bulkCapacidad !== "" ? Number(bulkCapacidad) : undefined;

    const targets = filtered.filter(r => {
      if (!selected.has(key(r))) return false;
      if (bulkActivo !== null && r.activo !== bulkActivo) return true;
      if (newCapacidad !== undefined && r.capacidad !== newCapacidad) return true;
      return false;
    });
    if (!targets.length) { showFlash("⚠ Selecciona al menos una fila (o no hay cambios reales)", false); return; }

    setSaving(true);
    const payload = targets.map(r => ({
      ...r,
      ...(bulkActivo !== null ? { activo: bulkActivo } : {}),
      ...(newCapacidad !== undefined ? { capacidad: newCapacidad } : {}),
    }));
    const { error } = await db.from("localizadores").upsert(payload, { onConflict: "zona,localizador" });
    setSaving(false);
    if (error) { showFlash(`❌ ${error.message}`, false); return; }
    setRows(prev => prev.map(r => {
      const updated = payload.find(p => p.zona === r.zona && p.localizador === r.localizador);
      return updated ?? r;
    }));
    showFlash(`✓ ${targets.length} ubicaciones actualizadas`);
    setSelected(new Set());
    setBulkActivo(null);
    setBulkCapacidad("");
    setShowBulk(false);
  }

  const stats = {
    total: rows.length,
    activas: rows.filter(r => r.activo).length,
    bloqueadas: rows.filter(r => !r.activo).length,
    conStock: rows.filter(r => r.ocupado > 0).length,
    libres: rows.reduce((s, r) => s + Math.max(0, r.disponible || 0), 0),
  };

  return (
    <div style={s.root} className="page-root">
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
            {selected.size > 0 && (
              <button style={s.btnBulk} onClick={() => setShowBulk(true)}>
                ✎ Editar {selected.size} seleccionadas
              </button>
            )}
            <button style={{ ...s.btnBulk, background: "#0c4a6e", borderColor: "#0ea5e9" }} onClick={() => { setShowNuevaZona(true); setNzPreview([]); }}>
              + NUEVA ZONA
            </button>
            <button style={s.btnRefresh} onClick={load}>↻ Recargar</button>
          </div>
        </div>
      </div>

      {/* ── CATÁLOGO DE METRAJE ─────────────────────────────────────────── */}
      <div
        style={{ ...s.catalogBox, borderColor: catalogDragging ? "#f97316" : "rgba(249,115,22,0.2)", background: catalogDragging ? "rgba(249,115,22,0.04)" : "#f8fafc" }}
        onDragOver={e => { e.preventDefault(); setCatalogDragging(true); }}
        onDragLeave={() => setCatalogDragging(false)}
        onDrop={e => { e.preventDefault(); setCatalogDragging(false); const f = e.dataTransfer.files[0]; if (f) uploadCatalog(f); }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, flexWrap: "wrap" as const }}>
          <span style={{ fontSize: 18 }}>📐</span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a", letterSpacing: 0.5 }}>
              Catálogo de Metraje
              {catalogCount !== null && (
                <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: catalogCount > 0 ? "#4ade80" : "#94a3b8" }}>
                  {catalogCount > 0 ? `✓ ${catalogCount.toLocaleString()} productos` : "Sin datos — sube el catálogo"}
                </span>
              )}
            </div>
            <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
              Excel con columnas <code style={{ color: "#f97316" }}>CÓDIGO</code> y <code style={{ color: "#f97316" }}>METRAJE</code> (m² por pallet) · Arrastra o haz clic en subir
            </div>
          </div>
        </div>
        <button
          style={{ ...s.btnBulk, background: catalogLoading ? "#374151" : "#c2410c", borderColor: "transparent", opacity: catalogLoading ? 0.6 : 1, flexShrink: 0 }}
          onClick={() => catalogRef.current?.click()}
          disabled={catalogLoading}
        >
          {catalogLoading ? "⟳ Cargando…" : "↑ SUBIR CATÁLOGO"}
        </button>
        <input ref={catalogRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
          onChange={e => { const f = e.target.files?.[0]; if (f) { uploadCatalog(f); e.target.value = ""; } }} />
      </div>

      {/* ── OPERADORES ───────────────────────────────────────────────────── */}
      <div style={s.opSection}>
        {/* Header de la sección */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a", letterSpacing: 0.5 }}>
              👷 Operadores
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: operadores.filter(o => o.activo).length > 0 ? "#4ade80" : "#94a3b8" }}>
                {operadores.filter(o => o.activo).length} activos · {operadores.length} total
              </span>
            </div>
            <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
              Importa desde Excel (columnas: NOMBRE, CÉDULA, EMAIL) o agrega manualmente
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ ...s.btnBulk, background: "#166534", borderColor: "#22c55e" }}
              onClick={() => setShowOpForm(v => !v)}>
              + AGREGAR
            </button>
            <button style={{ ...s.btnBulk, background: "#c2410c", borderColor: "transparent" }}
              onClick={() => opFileRef.current?.click()} disabled={opImporting}>
              {opImporting ? "⟳ Importando…" : "↑ IMPORTAR EXCEL"}
            </button>
            <input ref={opFileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) { importarOperadores(f); e.target.value = ""; } }} />
          </div>
        </div>

        {/* Formulario nuevo operador */}
        {showOpForm && (
          <div style={s.opFormBox}>
            <div style={{ fontSize: 9, letterSpacing: 2, color: "#f97316", fontWeight: 600, marginBottom: 12 }}>NUEVO OPERADOR</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 14px", marginBottom: 12 }}>
              <div>
                <label style={s.fieldLabel}>NOMBRE *</label>
                <input style={s.fieldInput} value={newOp.nombre} placeholder="Juan Pérez"
                  onChange={e => setNewOp(p => ({ ...p, nombre: e.target.value }))} />
              </div>
              <div>
                <label style={s.fieldLabel}>CÉDULA</label>
                <input style={s.fieldInput} value={newOp.cedula} placeholder="0912345678"
                  onChange={e => setNewOp(p => ({ ...p, cedula: e.target.value }))} />
              </div>
              <div>
                <label style={s.fieldLabel}>EMAIL</label>
                <input style={s.fieldInput} value={newOp.email} placeholder="juan@empresa.com"
                  onChange={e => setNewOp(p => ({ ...p, email: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ ...s.btnBulk, background: "#166534", borderColor: "#22c55e" }}
                onClick={agregarOperador}>GUARDAR →</button>
              <button style={s.btnRefresh} onClick={() => { setShowOpForm(false); setNewOp({ nombre: "", cedula: "", email: "" }); }}>Cancelar</button>
            </div>
          </div>
        )}

        {/* Lista de operadores */}
        {opLoading ? (
          <div style={{ fontSize: 11, color: "#64748b", padding: 16 }}>Cargando operadores…</div>
        ) : operadores.length === 0 ? (
          <div style={{ fontSize: 11, color: "#94a3b8", padding: "16px 0", textAlign: "center" as const }}>
            Sin operadores registrados — importa el Excel del otro proyecto o agrega manualmente
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8 }}>
            {operadores.map(op => (
              <div key={op.id} style={{ ...s.opCard, opacity: op.activo ? 1 : 0.5 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{op.nombre}</div>
                  <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
                    {op.cedula && <span style={{ marginRight: 8 }}>CI: {op.cedula}</span>}
                    {op.email  && <span>{op.email}</span>}
                  </div>
                </div>
                <button
                  style={{ ...s.actionBtn, borderColor: op.activo ? "rgba(248,113,113,0.4)" : "rgba(74,222,128,0.4)", color: op.activo ? "#f87171" : "#4ade80", flexShrink: 0 }}
                  onClick={() => toggleOperador(op)}
                >
                  {op.activo ? "Desactivar" : "Activar"}
                </button>
              </div>
            ))}
          </div>
        )}
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
        <span style={{ fontSize: 11, color: "#64748b", marginLeft: "auto" }}>
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
                          style={{ color: "#64748b", cursor: "pointer", borderBottom: "1px dashed rgba(249,115,22,0.3)" }}
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
                          style={{ color: "#1e293b", cursor: "pointer", borderBottom: "1px dashed rgba(249,115,22,0.3)", fontWeight: 700 }}
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
            <p style={{ fontSize: 11, color: "#64748b", margin: "0 0 16px" }}>
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

      {/* Modal Nueva Zona */}
      {showNuevaZona && (
        <div style={s.overlay} onClick={() => setShowNuevaZona(false)}>
          <div style={{ ...s.modalBox, maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div style={{ ...s.modalTitle, color: "#0ea5e9" }}>+ AGREGAR ZONA A LA BASE DE DATOS</div>
            <p style={{ fontSize: 11, color: "#64748b", margin: "0 0 18px" }}>
              Genera localizadores automáticamente con el patrón <code style={{ color: "#f97316" }}>ZONA.POS.FILA.COL</code>
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 16px" }}>
              <div>
                <label style={s.fieldLabel}>NOMBRE DE ZONA *</label>
                <input style={s.fieldInput} placeholder="Ej: ZONA16" value={nzZona}
                  onChange={e => setNzZona(e.target.value.toUpperCase())} />
              </div>
              <div>
                <label style={s.fieldLabel}>FORMATO / TIPO</label>
                <input style={s.fieldInput} placeholder="Mezcla" value={nzFormato}
                  onChange={e => setNzFormato(e.target.value)} />
              </div>
              <div>
                <label style={s.fieldLabel}>POSICIÓN DESDE</label>
                <input style={s.fieldInput} type="number" min={1} value={nzDesde}
                  onChange={e => setNzDesde(Number(e.target.value))} />
              </div>
              <div>
                <label style={s.fieldLabel}>POSICIÓN HASTA</label>
                <input style={s.fieldInput} type="number" min={1} value={nzHasta}
                  onChange={e => setNzHasta(Number(e.target.value))} />
              </div>
              <div>
                <label style={s.fieldLabel}>FILAS POR POSICIÓN</label>
                <input style={s.fieldInput} type="number" min={1} value={nzFilas}
                  onChange={e => setNzFilas(Number(e.target.value))} />
              </div>
              <div>
                <label style={s.fieldLabel}>COLUMNAS POR FILA</label>
                <input style={s.fieldInput} type="number" min={1} value={nzCols}
                  onChange={e => setNzCols(Number(e.target.value))} />
              </div>
              <div>
                <label style={s.fieldLabel}>CAPACIDAD (pallets)</label>
                <input style={s.fieldInput} type="number" min={1} value={nzCapacidad}
                  onChange={e => setNzCapacidad(Number(e.target.value))} />
              </div>
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button style={{ ...s.modalBtn, background: "#1e3a5f", color: "#60a5fa", border: "1px solid rgba(96,165,250,0.3)", fontSize: 10 }}
                  onClick={actualizarPreview}>
                  👁 PREVISUALIZAR
                </button>
              </div>
            </div>

            {/* Preview */}
            {nzPreview.length > 0 && (
              <div style={{ marginTop: 14, background: "#f8fafc", border: "1px solid rgba(14,165,233,0.2)", borderRadius: 3, padding: "10px 14px" }}>
                <div style={{ fontSize: 9, letterSpacing: 2, color: "#0ea5e9", marginBottom: 8 }}>
                  PREVISUALIZACIÓN — {generarLocalizadores(nzZona, nzDesde, nzHasta, nzFilas, nzCols).length} LOCALIZADORES
                  {generarLocalizadores(nzZona, nzDesde, nzHasta, nzFilas, nzCols).length > 30 && " (mostrando primeros 30)"}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 5 }}>
                  {nzPreview.map(loc => (
                    <span key={loc} style={{ background: "#1e3a5f", color: "#93c5fd", fontSize: 10, padding: "2px 7px", borderRadius: 2, fontFamily: "monospace" }}>
                      {loc}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button
                style={{ ...s.modalBtn, background: "#0c4a6e", color: "#fff", opacity: savingZona ? 0.6 : 1 }}
                onClick={crearZona}
                disabled={savingZona || !nzZona.trim()}
              >
                {savingZona ? "Creando…" : `CREAR ${generarLocalizadores(nzZona, nzDesde, nzHasta, nzFilas, nzCols).length} LOCALIZADORES →`}
              </button>
              <button style={s.modalBtnCancel} onClick={() => setShowNuevaZona(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const s: { [k: string]: React.CSSProperties } = {
  root: { padding: "28px 24px", fontFamily: "'Courier New', monospace", color: "#1e293b", minHeight: "100vh", background: "#f1f5f9", position: "relative" },
  flash: { position: "fixed", top: 20, right: 24, background: "#ffffff", border: "1px solid", padding: "10px 20px", borderRadius: 3, fontSize: 12, letterSpacing: 1, zIndex: 9999 },
  pageHeader: { marginBottom: 20 },
  badge: { display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", marginBottom: 10 },
  title: { margin: "0 0 4px", fontSize: 22, fontWeight: 700, color: "#0f172a", letterSpacing: 1 },
  sub: { margin: 0, fontSize: 11, color: "#64748b" },
  catalogBox: { border: "1px solid", borderRadius: 4, padding: "12px 16px", marginBottom: 18, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" as const, transition: "border-color .2s, background .2s" },
  opSection:  { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 4, padding: "16px 18px", marginBottom: 18 },
  opFormBox:  { background: "#fff", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 4, padding: "14px 16px", marginBottom: 14 },
  opCard:     { background: "#fff", border: "1px solid rgba(249,115,22,0.12)", borderRadius: 4, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 },
  btnBulk: { background: "#1d4ed8", border: "none", color: "#fff", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "8px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  btnRefresh: { background: "transparent", border: "1px solid rgba(249,115,22,0.2)", color: "#64748b", fontSize: 11, padding: "8px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  statsRow: { display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" as const },
  statCard: { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 3, padding: "10px 18px", flex: 1, minWidth: 100 },
  statLabel: { fontSize: 9, letterSpacing: 2, color: "#94a3b8", marginTop: 3 },
  filters: { display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" as const, alignItems: "center" },
  searchInput: { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 2, color: "#1e293b", fontSize: 11, padding: "7px 10px", fontFamily: "'Courier New', monospace", outline: "none", minWidth: 180 },
  select: { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 2, color: "#1e293b", fontSize: 11, padding: "7px 10px", fontFamily: "'Courier New', monospace", outline: "none" },
  loading: { textAlign: "center" as const, color: "#64748b", padding: 40, fontSize: 12 },
  tableWrap: { overflowX: "auto" as const, border: "1px solid rgba(249,115,22,0.25)", borderRadius: 3 },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 11 },
  thead: { borderBottom: "1px solid rgba(249,115,22,0.15)", background: "#f8fafc" },
  th: { padding: "7px 10px", textAlign: "left" as const, fontSize: 9, letterSpacing: 1.5, color: "#94a3b8", fontWeight: 700, whiteSpace: "nowrap" as const, userSelect: "none" as const },
  tr: { borderBottom: "1px solid rgba(249,115,22,0.04)" },
  td: { padding: "7px 10px", verticalAlign: "middle" as const, whiteSpace: "nowrap" as const },
  inlineInput: { background: "#f1f5f9", border: "1px solid rgba(249,115,22,0.4)", borderRadius: 2, color: "#1e293b", fontSize: 11, padding: "4px 7px", fontFamily: "'Courier New', monospace", outline: "none", width: 120 },
  btnSave: { background: "transparent", border: "1px solid rgba(74,222,128,0.4)", color: "#4ade80", fontSize: 11, padding: "4px 8px", cursor: "pointer", borderRadius: 2 },
  btnCancel: { background: "transparent", border: "1px solid rgba(248,113,113,0.4)", color: "#f87171", fontSize: 11, padding: "4px 8px", cursor: "pointer", borderRadius: 2 },
  actionBtn: { background: "transparent", border: "1px solid", fontSize: 10, padding: "4px 8px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", letterSpacing: 0.5 },
  empty: { textAlign: "center" as const, color: "#94a3b8", padding: 40, fontSize: 12 },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
  modalBox: { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.3)", borderRadius: 4, padding: "24px 28px", width: "100%", maxWidth: 480 },
  modalTitle: { fontSize: 13, fontWeight: 700, letterSpacing: 2, marginBottom: 14, color: "#f97316" },
  fieldLabel: { fontSize: 9, letterSpacing: 2, color: "#f97316", display: "block" as const, marginBottom: 6, fontWeight: 600 },
  fieldInput: { background: "#f1f5f9", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 2, color: "#1e293b", fontSize: 11, padding: "7px 9px", fontFamily: "'Courier New', monospace", width: "100%", boxSizing: "border-box" as const, outline: "none" },
  toggleOpt: { border: "1px solid rgba(249,115,22,0.3)", fontSize: 10, letterSpacing: 1, padding: "5px 10px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  modalBtn: { border: "none", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "10px 16px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  modalBtnCancel: { background: "transparent", border: "1px solid rgba(249,115,22,0.2)", color: "#6b7280", fontSize: 10, letterSpacing: 1, padding: "10px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
};
