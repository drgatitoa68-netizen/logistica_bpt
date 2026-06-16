"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { getBrowserClient } from "@/lib/supabase/browser";
import { debounce } from "@/lib/utils/debounce";
import { Linea } from "@/lib/shared/ordenes";
import { aprobarLineaDirecta, rechazarLinea, fraccionarLinea, actualizarResponsable, crearLineas } from "@/app/actions/ordenes";
import * as XLSX from "xlsx";

const db = getBrowserClient();

type Filtro = "pendiente" | "aprobada" | "rechazada" | "todas";

interface Operador { id: string; nombre: string; email?: string; rol?: string; }

interface FraccionForm {
  lineaId:  string;
  original: Linea;
  p1:       number;
  c1:       number;
  dest1:    string;
  dest2:    string;
}

interface InvItem {
  id: string;
  cod_org_inv: string;
  codigo: string;
  descripcion: string;
  lote: string;
  localizador: string;
  subinventario: string;
  pallets: number;
  cajas: number;
  cantidad_fisica: number;
  inv_pe?: number;
  conteo?: number;
}

interface RowDest { loc: string; subinv: string; responsable: string; inv_pe: string; conteo: string; }

function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

function fmt(v: number | null | undefined, dec = 2) {
  if (v == null) return "—";
  return Number(v).toFixed(dec);
}

// ── Componente ────────────────────────────────────────────────────────────────
export default function OrdenesProduccionPage() {
  const [lineas,     setLineas]     = useState<Linea[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [filtro,     setFiltro]     = useState<Filtro>("pendiente");
  const [selected,   setSelected]   = useState<Set<string>>(new Set());
  const [saving,     setSaving]     = useState<string | null>(null);
  const [flash,      setFlash]      = useState<{ msg: string; ok: boolean } | null>(null);
  const [operadores, setOperadores] = useState<Operador[]>([]);

  const [rejectTarget, setRejectTarget] = useState<string[] | null>(null);
  const [rejectNota,   setRejectNota]   = useState("");
  const [fraccion,     setFraccion]     = useState<FraccionForm | null>(null);

  // ── Modal nueva línea desde inventario ────────────────────────────────────
  const [nuevaLinea,   setNuevaLinea]   = useState(false);
  const [nlOrden,      setNlOrden]      = useState("");
  const [nlZona,       setNlZona]       = useState("");
  const [nlLoc,        setNlLoc]        = useState("");
  const [nlDestLoc,    setNlDestLoc]    = useState("");
  const [nlDestSubinv, setNlDestSubinv] = useState("ALMACEN");
  const [zonas,        setZonas]        = useState<string[]>([]);
  const [locsPorZona,  setLocsPorZona]  = useState<string[]>([]);
  const [invItems,     setInvItems]     = useState<InvItem[]>([]);
  const [selInv,       setSelInv]       = useState<Set<string>>(new Set());
  const [loadingInv,   setLoadingInv]   = useState(false);
  const [rowDest,      setRowDest]      = useState<Map<string, RowDest>>(new Map());
  const [suggesting,   setSuggesting]   = useState(false);
  const [nlTipoOrden,  setNlTipoOrden]  = useState<"PRODUCCION" | "CONSOLIDACION_SALDOS" | "CONSOLIDACION_VOLUMEN">("PRODUCCION");

  const [search,       setSearch]       = useState("");
  const [fOperador,    setFOperador]    = useState("all");

  // ── Carga ─────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await db
      .from("lineas_reubicacion")
      .select("id,numero_orden,cod_org_inv,codigo,descripcion,subinventario_origen,localizador_origen,lote,cantidad_fisica,pallets,cajas,metraje,subinventario_destino,localizador_destino,responsable,inv_pe,conteo,estado,notas_supervisor,es_fraccion,created_at,updated_at")
      .in("estado", ["pendiente", "aprobada", "rechazada"])
      .order("created_at", { ascending: false });
    if (data) setLineas(data as Linea[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    db.from("usuarios_bodega").select("id,nombre,email,rol").eq("activo", true).order("nombre")
      .then(({ data }) => setOperadores((data as Operador[]) ?? []));

    const dl = debounce(load, 600);
    const ch = db.channel("ordenes_sv2")
      .on("postgres_changes", { event: "*", schema: "public", table: "lineas_reubicacion" }, dl)
      .subscribe();
    return () => { db.removeChannel(ch); };
  }, [load]);

  const showFlash = (msg: string, ok = true) => { setFlash({ msg, ok }); setTimeout(() => setFlash(null), 3500); };

  // ── Carga modal inventario ─────────────────────────────────────────────────
  async function abrirNuevaLinea() {
    setNuevaLinea(true);
    setNlOrden(""); setNlZona(""); setNlLoc(""); setNlDestLoc(""); setNlDestSubinv("ALMACEN");
    setNlTipoOrden("PRODUCCION");
    setInvItems([]); setSelInv(new Set()); setRowDest(new Map());
    const { data } = await db.from("localizadores").select("zona").eq("activo", true).order("zona");
    const zonasList = [...new Set((data ?? []).map((r: { zona: string }) => r.zona))];
    setZonas(zonasList);
  }

  async function onZonaChange(zona: string) {
    setNlZona(zona); setNlLoc(""); setInvItems([]); setSelInv(new Set());
    if (!zona) { setLocsPorZona([]); return; }
    const { data } = await db.from("localizadores").select("localizador").eq("zona", zona).eq("activo", true).order("localizador");
    setLocsPorZona((data ?? []).map((r: { localizador: string }) => r.localizador));
  }

  async function onLocChange(loc: string) {
    setNlLoc(loc); setInvItems([]); setSelInv(new Set()); setRowDest(new Map());
    if (!loc) return;
    setLoadingInv(true);
    const { data } = await db.from("inventario")
      .select("id,cod_org_inv,codigo,descripcion,lote,localizador,subinventario,pallets,cajas,cantidad_fisica,inv_pe,conteo")
      .eq("localizador", loc)
      .order("codigo");
    const items = (data as InvItem[]) ?? [];
    setInvItems(items);
    setSelInv(new Set(items.map(i => i.id)));
    const initDest = new Map<string, RowDest>();
    items.forEach(i => initDest.set(i.id, { loc: nlDestLoc, subinv: nlDestSubinv, responsable: "", inv_pe: i.inv_pe != null ? String(i.inv_pe) : "", conteo: i.conteo != null ? String(i.conteo) : "" }));
    setRowDest(initDest);
    setLoadingInv(false);
  }

  function updateRowDest(id: string, field: keyof RowDest, value: string) {
    setRowDest(p => { const n = new Map(p); const r = n.get(id) ?? { loc: "", subinv: "ALMACEN", responsable: "", inv_pe: "", conteo: "" }; n.set(id, { ...r, [field]: field === "loc" ? value.toUpperCase() : value }); return n; });
  }

  async function sugerirDestinos() {
    const items = invItems.filter(i => selInv.has(i.id));
    if (!items.length) return;
    setSuggesting(true);
    try {
      const res = await fetch("/api/plan-ubicacion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stock: items.map((i, idx) => ({
            row_idx: idx, cod_org_inv: i.cod_org_inv || "", codigo: i.codigo || "",
            descripcion: i.descripcion || "", subinventario_origen: i.subinventario || "ALMACEN",
            localizador_origen: i.localizador || "", lote: i.lote || "",
            cantidad_fisica: i.cantidad_fisica || 0, pallets: i.pallets || 0,
            cajas: i.cajas || 0, responsable: "", conteo: i.conteo ?? null,
          })),
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const assigned: { row_idx: number; localizador_destino: string; subinventario_destino: string }[] = json.assigned ?? json ?? [];
        setRowDest(p => {
          const n = new Map(p);
          assigned.forEach((a, idx) => {
            const item = items[a.row_idx ?? idx];
            if (!item) return;
            const prev = n.get(item.id) ?? { loc: "", subinv: "ALMACEN", responsable: "", inv_pe: "", conteo: "" };
            n.set(item.id, { ...prev, loc: a.localizador_destino || prev.loc, subinv: a.subinventario_destino || prev.subinv });
          });
          return n;
        });
      }
    } catch { /* ignorar errores de la API */ }
    setSuggesting(false);
  }

  async function confirmarCrearDesdeInv() {
    const items = invItems.filter(i => selInv.has(i.id));
    if (!items.length) { showFlash("Selecciona al menos una línea", false); return; }
    setSaving("nueva");
    const lines = items.map(i => {
      const dest = rowDest.get(i.id);
      return {
        numero_orden:          nlOrden.trim() || undefined,
        cod_org_inv:           i.cod_org_inv || undefined,
        codigo:                i.codigo || undefined,
        descripcion:           i.descripcion || "Sin descripción",
        lote:                  i.lote || undefined,
        subinventario_origen:  i.subinventario || "ALMACEN",
        localizador_origen:    i.localizador,
        pallets:               i.pallets || 0,
        cajas:                 i.cajas || 0,
        cantidad_fisica:       i.cantidad_fisica || undefined,
        subinventario_destino: dest?.subinv || undefined,
        localizador_destino:   dest?.loc?.trim() || undefined,
        responsable:           dest?.responsable?.trim() || undefined,
        inv_pe:                dest?.inv_pe ? Number(dest.inv_pe) : undefined,
        notas:                 nlTipoOrden ? `[${nlTipoOrden}]` : undefined,
      };
    });
    const res = await crearLineas(lines);
    setSaving(null);
    if (res?.error) { showFlash(`❌ ${res.error}`, false); return; }
    showFlash(`✓ ${items.length} línea${items.length > 1 ? "s" : ""} creada${items.length > 1 ? "s" : ""}`);
    setNuevaLinea(false);
    load();
  }

  // ── Acciones ──────────────────────────────────────────────────────────────
  async function aprobar(ids: string[]) {
    setSaving(ids.length === 1 ? ids[0] : "bulk");
    const res = await Promise.all(ids.map(id => aprobarLineaDirecta(id)));
    setSaving(null);
    const err = res.filter(r => r?.error).length;
    if (!err) {
      setLineas(p => p.map(l => ids.includes(l.id) ? { ...l, estado: "aprobada", updated_at: new Date().toISOString() } : l));
      showFlash(`✓ ${ids.length} línea${ids.length > 1 ? "s" : ""} enviada${ids.length > 1 ? "s" : ""} al operador`);
      setSelected(new Set());
    } else showFlash(`⚠ ${err} errores`, false);
  }

  async function confirmarRechazo() {
    if (!rejectTarget?.length || !rejectNota.trim()) return;
    setSaving("bulk");
    const res = await Promise.all(rejectTarget.map(id => rechazarLinea(id, rejectNota.trim())));
    setSaving(null);
    if (!res.filter(r => r?.error).length) {
      const nota = rejectNota.trim();
      setLineas(p => p.map(l => rejectTarget.includes(l.id) ? { ...l, estado: "rechazada", notas_supervisor: nota, updated_at: new Date().toISOString() } : l));
      showFlash(`✓ ${rejectTarget.length} rechazada${rejectTarget.length > 1 ? "s" : ""}`);
      setSelected(new Set());
    } else showFlash("⚠ Errores al rechazar", false);
    setRejectTarget(null); setRejectNota("");
  }

  async function asignarOperador(id: string, nombre: string) {
    setSaving(id);
    const res = await actualizarResponsable(id, nombre);
    setSaving(null);
    if (!res?.error) {
      setLineas(p => p.map(l => l.id === id ? { ...l, responsable: nombre } : l));
      showFlash(`✓ Operador asignado: ${nombre}`);
    } else showFlash(`❌ ${res.error}`, false);
  }

  async function confirmarFraccion() {
    if (!fraccion) return;
    const { original, p1, c1, dest1, dest2 } = fraccion;
    const ptotal = original.pallets || 0;
    const ctotal = original.cajas  || 0;
    const p2 = ptotal - p1;
    const c2 = ctotal - c1;
    if (p1 <= 0 || p2 <= 0) { showFlash("Cada fracción debe tener ≥ 1 pallet", false); return; }
    if (c1 < 0 || c2 < 0)   { showFlash(`Las cajas de F1 no pueden superar ${ctotal}`, false); return; }
    if (!dest1.trim())       { showFlash("Ingresa destino de la fracción 1", false); return; }
    if (!dest2.trim())       { showFlash("Ingresa destino de la fracción 2", false); return; }
    const met1 = Math.round(p1 * 1.2 * 100) / 100;
    const met2 = Math.round(p2 * 1.2 * 100) / 100;
    setSaving("bulk");
    const res = await fraccionarLinea(fraccion.lineaId,
      { pallets: p1, cajas: c1, cantidad_fisica: p1, metraje: met1, localizador_destino: dest1.trim().toUpperCase(), subinventario_destino: "ALMACEN" },
      { pallets: p2, cajas: c2, cantidad_fisica: p2, metraje: met2, localizador_destino: dest2.trim().toUpperCase(), subinventario_destino: "ALMACEN" }
    );
    setSaving(null);
    if (res?.error) { showFlash(`❌ ${res.error}`, false); return; }
    showFlash(`✓ Fraccionado: F1=${p1}plt/${c1}cj (${met1}m²) · F2=${p2}plt/${c2}cj (${met2}m²)`);
    setFraccion(null); load();
  }

  function toggleSel(id: string) {
    setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  const counts = {
    pendiente: lineas.filter(l => l.estado === "pendiente").length,
    aprobada:  lineas.filter(l => l.estado === "aprobada").length,
    rechazada: lineas.filter(l => l.estado === "rechazada").length,
  };

  const q = search.toLowerCase().trim();
  const byEstado  = filtro === "todas" ? lineas : lineas.filter(l => l.estado === filtro);
  const byOp      = fOperador === "all" ? byEstado : byEstado.filter(l => (l.responsable || "") === fOperador);
  const filtradas = q
    ? byOp.filter(l =>
        (l.codigo       || "").toLowerCase().includes(q) ||
        (l.descripcion  || "").toLowerCase().includes(q) ||
        (l.numero_orden || "").toLowerCase().includes(q) ||
        (l.localizador_origen  || "").toLowerCase().includes(q) ||
        (l.localizador_destino || "").toLowerCase().includes(q) ||
        (l.lote || "").toLowerCase().includes(q)
      )
    : byOp;

  const pendVista  = filtradas.filter(l => l.estado === "pendiente");
  const selPend    = [...selected].filter(id => pendVista.some(l => l.id === id));
  const allSelPend = pendVista.length > 0 && pendVista.every(l => selected.has(l.id));

  function exportXlsx() {
    const rows = filtradas.map(l => ({
      numero_orden: l.numero_orden, codigo: l.codigo, descripcion: l.descripcion,
      lote: l.lote, origen: l.localizador_origen, destino: l.localizador_destino,
      pallets: l.pallets, metraje: l.metraje, estado: l.estado,
      responsable: l.responsable, created_at: l.created_at,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ordenes");
    XLSX.writeFile(wb, `ordenes_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  return (
    <div style={s.root} className="page-root">
      {flash && (
        <div style={{ ...s.flash, borderColor: flash.ok ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)", color: flash.ok ? "#4ade80" : "#f87171" }}>
          {flash.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ ...s.header, display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" as const, gap: 12 }}>
        <div>
          <div style={s.badge}>SUPERVISOR — CONTROL DE CALIDAD</div>
          <h1 style={s.title}>Órdenes de Producción</h1>
          <p style={s.sub}>Verifica cada línea, asigna operador, fracciona si es necesario y aprueba.</p>
        </div>
        <button onClick={abrirNuevaLinea}
          style={{ marginTop: 24, fontSize: 11, fontWeight: 700, letterSpacing: 1.5, padding: "9px 18px", border: "1px solid rgba(249,115,22,0.5)", borderRadius: 4, background: "rgba(249,115,22,0.08)", color: "#f97316", cursor: "pointer", fontFamily: "'Courier New', monospace", whiteSpace: "nowrap" as const }}>
          + NUEVA LÍNEA
        </button>
      </div>

      {/* Stats */}
      <div style={s.statsRow} className="stats-4col">
        {[
          { v: counts.pendiente, l: "POR REVISAR", c: "#fbbf24" },
          { v: counts.aprobada,  l: "APROBADAS",   c: "#4ade80" },
          { v: counts.rechazada, l: "RECHAZADAS",  c: "#f87171" },
          { v: lineas.length,    l: "TOTAL",        c: "#94a3b8" },
        ].map(st => (
          <div key={st.l} style={s.statCard}>
            <div style={{ fontSize: 26, fontWeight: 700, color: st.c }}>{st.v}</div>
            <div style={s.statLabel}>{st.l}</div>
          </div>
        ))}
      </div>

      {/* Búsqueda y filtros */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Buscar código, descripción, orden, localizador, lote…"
          style={{ flex: "1 1 280px", fontSize: 12, padding: "7px 10px", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 4, background: "#fff", color: "#1e293b", outline: "none", fontFamily: "'Courier New', monospace" }} />
        <select value={fOperador} onChange={e => setFOperador(e.target.value)}
          style={{ fontSize: 11, padding: "7px 10px", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 4, background: "#fff", color: "#1e293b", outline: "none", fontFamily: "'Courier New', monospace", cursor: "pointer" }}>
          <option value="all">Todos los operadores</option>
          <option value="">Sin asignar</option>
          {operadores.map(op => <option key={op.id} value={op.nombre}>{op.nombre}</option>)}
        </select>
        {(search || fOperador !== "all") && (
          <button onClick={() => { setSearch(""); setFOperador("all"); }}
            style={{ fontSize: 11, padding: "7px 10px", border: "1px solid rgba(248,113,113,0.3)", borderRadius: 4, background: "transparent", color: "#f87171", cursor: "pointer", fontFamily: "'Courier New', monospace" }}>
            ✕ Limpiar
          </button>
        )}
        <button onClick={exportXlsx} disabled={!filtradas.length}
          style={{ fontSize: 11, padding: "7px 12px", border: "1px solid rgba(22,101,52,0.4)", borderRadius: 4, background: filtradas.length ? "#f0fdf4" : "transparent", color: "#166534", cursor: filtradas.length ? "pointer" : "not-allowed", fontFamily: "'Courier New', monospace", fontWeight: 600, opacity: filtradas.length ? 1 : 0.5 }}>
          ⬇ Exportar ({filtradas.length})
        </button>
        {q && <span style={{ fontSize: 11, color: "#94a3b8", fontFamily: "'Courier New', monospace" }}>{filtradas.length} resultado{filtradas.length !== 1 ? "s" : ""}</span>}
      </div>

      {/* Tabs */}
      <div style={s.tabRow}>
        {([
          { k: "pendiente", l: "POR REVISAR",  c: "#fbbf24" },
          { k: "aprobada",  l: "APROBADAS",    c: "#4ade80" },
          { k: "rechazada", l: "RECHAZADAS",   c: "#f87171" },
          { k: "todas",     l: "TODAS",         c: "#94a3b8" },
        ] as { k: Filtro; l: string; c: string }[]).map(f => (
          <button key={f.k} style={{ ...s.tab, color: filtro === f.k ? f.c : "#4a5568", borderColor: filtro === f.k ? f.c : "rgba(249,115,22,0.15)", background: filtro === f.k ? `${f.c}14` : "transparent" }}
            onClick={() => { setFiltro(f.k); setSelected(new Set()); }}>
            {f.l}
            <span style={{ ...s.tabCount, background: filtro === f.k ? `${f.c}22` : "#e2e8f0", color: filtro === f.k ? f.c : "#94a3b8" }}>
              {f.k === "todas" ? lineas.length : counts[f.k as keyof typeof counts]}
            </span>
          </button>
        ))}
        <button style={s.refreshBtn} onClick={load}>↻</button>
      </div>

      {/* Bulk bar */}
      {selPend.length > 0 && (
        <div style={s.bulkBar}>
          <span style={{ fontSize: 12, color: "#e2e8f0" }}>
            <strong style={{ color: "#fbbf24" }}>{selPend.length}</strong> seleccionadas
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ ...s.bulkBtn, background: "#166534", borderColor: "#22c55e", color: "#4ade80" }}
              onClick={() => aprobar(selPend)} disabled={saving === "bulk"}>
              {saving === "bulk" ? "⟳" : `✓ APROBAR ${selPend.length}`}
            </button>
            <button style={{ ...s.bulkBtn, background: "#7f1d1d", borderColor: "#f87171", color: "#fca5a5" }}
              onClick={() => { setRejectTarget(selPend); setRejectNota(""); }} disabled={saving === "bulk"}>
              ✗ RECHAZAR {selPend.length}
            </button>
            <button style={{ ...s.bulkBtn, background: "transparent", borderColor: "#374151", color: "#6b7280" }}
              onClick={() => setSelected(new Set())}>×</button>
          </div>
        </div>
      )}

      {filtro === "pendiente" && pendVista.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <button style={s.selAllBtn} onClick={() => setSelected(allSelPend ? new Set() : new Set(pendVista.map(l => l.id)))}>
            {allSelPend ? "☑" : "☐"} {allSelPend ? "Desmarcar" : `Seleccionar todas (${pendVista.length})`}
          </button>
        </div>
      )}

      {/* Lista */}
      {loading ? (
        <div style={s.empty}>Cargando órdenes…</div>
      ) : filtradas.length === 0 ? (
        <div style={s.empty}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>{filtro === "pendiente" ? "✓" : "—"}</div>
          {filtro === "pendiente" ? "No hay líneas pendientes" : "Sin resultados"}
          {filtro === "pendiente" && <div style={{ fontSize: 11, marginTop: 8, color: "#64748b" }}>Procesa un Excel en Análisis BPT para generar líneas</div>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filtradas.map(l => (
            <LineaCard key={l.id} l={l} selected={selected.has(l.id)} saving={saving}
              operadores={operadores}
              onToggle={toggleSel}
              onAprobar={aprobar}
              onRechazar={ids => { setRejectTarget(ids); setRejectNota(""); }}
              onFraccionar={l => setFraccion({ lineaId: l.id, original: l, p1: Math.max(1, Math.floor((l.pallets || 2) / 2)), c1: Math.floor((l.cajas || 0) / 2), dest1: l.localizador_destino || "", dest2: "" })}
              onAsignarOp={asignarOperador}
            />
          ))}
        </div>
      )}

      {/* ── MODAL NUEVA LÍNEA DESDE INVENTARIO ───────────────────────────── */}
      {nuevaLinea && (
        <div style={s.overlay} onClick={() => setNuevaLinea(false)}>
          <div style={{ ...s.modal, maxWidth: 1100, width: "100%", maxHeight: "94vh", overflowY: "auto" as const, display: "flex", flexDirection: "column" as const, gap: 14 }} onClick={e => e.stopPropagation()}>

            {/* Título */}
            <div style={{ ...s.modalTitle, color: "#f97316", marginBottom: 0 }}>+ NUEVA LÍNEA DE REUBICACIÓN</div>

            {/* Tipo de orden */}
            <div>
              <label style={s.fieldLabel}>TIPO DE ORDEN</label>
              <div style={{ display: "flex", gap: 8 }}>
                {([
                  { k: "PRODUCCION",            l: "Producción" },
                  { k: "CONSOLIDACION_SALDOS",  l: "Consolidación de Saldos" },
                  { k: "CONSOLIDACION_VOLUMEN", l: "Consolidación de Volumen" },
                ] as { k: typeof nlTipoOrden; l: string }[]).map(t => (
                  <button key={t.k} onClick={() => setNlTipoOrden(t.k)}
                    style={{ fontSize: 11, fontWeight: 700, padding: "7px 14px", border: "1px solid", borderColor: nlTipoOrden === t.k ? "#f97316" : "rgba(249,115,22,0.25)", borderRadius: 3, background: nlTipoOrden === t.k ? "rgba(249,115,22,0.12)" : "transparent", color: nlTipoOrden === t.k ? "#f97316" : "#64748b", cursor: "pointer", fontFamily: "'Courier New', monospace", letterSpacing: 0.5 }}>
                    {nlTipoOrden === t.k ? "● " : "○ "}{t.l}
                  </button>
                ))}
              </div>
            </div>

            {/* Fila: Orden + Selectores zona/loc */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <div>
                <label style={s.fieldLabel}>N° ORDEN (opcional)</label>
                <input value={nlOrden} onChange={e => setNlOrden(e.target.value)}
                  placeholder="OP-2024-001" style={s.nlInput} />
              </div>
              <div>
                <label style={s.fieldLabel}>ZONA ORIGEN</label>
                <select value={nlZona} onChange={e => onZonaChange(e.target.value)} style={{ ...s.nlInput, cursor: "pointer" }}>
                  <option value="">— Selecciona zona —</option>
                  {zonas.map(z => <option key={z} value={z}>{z}</option>)}
                </select>
              </div>
              <div>
                <label style={s.fieldLabel}>LOCALIZADOR ORIGEN</label>
                <select value={nlLoc} onChange={e => onLocChange(e.target.value)} disabled={!nlZona} style={{ ...s.nlInput, cursor: nlZona ? "pointer" : "not-allowed", opacity: nlZona ? 1 : 0.5 }}>
                  <option value="">— Selecciona loc —</option>
                  {locsPorZona.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
            </div>

            {/* Tabla de inventario */}
            {nlLoc && (
              <>
                {/* Barra superior */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "#f1f5f9", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 4, padding: "8px 14px", flexWrap: "wrap" as const }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button
                      onClick={() => {
                        const allSel = selInv.size === invItems.length;
                        setSelInv(allSel ? new Set() : new Set(invItems.map(i => i.id)));
                      }}
                      style={{ fontSize: 11, fontWeight: 700, padding: "5px 12px", border: "1px solid rgba(249,115,22,0.4)", borderRadius: 3, background: selInv.size === invItems.length ? "rgba(249,115,22,0.12)" : "transparent", color: "#f97316", cursor: "pointer", fontFamily: "'Courier New', monospace", letterSpacing: 1 }}>
                      {selInv.size === invItems.length && invItems.length > 0 ? "☑ QUITAR TODAS" : "☐ AGREGAR TODAS"}
                    </button>
                    <span style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>
                      {selInv.size} de {invItems.length} seleccionadas
                    </span>
                  </div>
                  <button onClick={sugerirDestinos} disabled={suggesting || selInv.size === 0}
                    style={{ fontSize: 11, fontWeight: 700, padding: "5px 14px", border: "1px solid rgba(96,165,250,0.4)", borderRadius: 3, background: "rgba(96,165,250,0.08)", color: "#60a5fa", cursor: selInv.size > 0 ? "pointer" : "not-allowed", fontFamily: "'Courier New', monospace", opacity: selInv.size === 0 ? 0.5 : 1, letterSpacing: 0.5 }}>
                    {suggesting ? "⟳ Calculando…" : "⚡ SUGERIR DESTINOS"}
                  </button>
                </div>

                {/* Tabla */}
                {loadingInv ? (
                  <div style={{ textAlign: "center" as const, color: "#94a3b8", padding: 30, fontSize: 12 }}>Cargando inventario…</div>
                ) : invItems.length === 0 ? (
                  <div style={{ textAlign: "center" as const, color: "#94a3b8", padding: 30, fontSize: 12, border: "1px dashed rgba(249,115,22,0.15)", borderRadius: 4 }}>
                    Sin stock en {nlLoc}
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" as const, border: "1px solid rgba(249,115,22,0.15)", borderRadius: 4 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 11, fontFamily: "'Courier New', monospace" }}>
                      <thead>
                        <tr style={{ background: "#f8fafc", borderBottom: "1px solid rgba(249,115,22,0.15)" }}>
                          <th style={s.th}></th>
                          <th style={s.th}>COD. ORG INV</th>
                          <th style={s.th}>CÓDIGO</th>
                          <th style={{ ...s.th, textAlign: "left" as const, minWidth: 160 }}>DESCRIPCIÓN</th>
                          <th style={s.th}>SUBINV. ORIGEN</th>
                          <th style={s.th}>LOC. ORIGEN</th>
                          <th style={s.th}>LOTE</th>
                          <th style={s.th}>CAN. FÍSICA</th>
                          <th style={s.th}>PALLETS</th>
                          <th style={s.th}>CAJAS</th>
                          <th style={{ ...s.th, minWidth: 100 }}>SUBINV. DESTINO</th>
                          <th style={{ ...s.th, minWidth: 130 }}>LOC. DESTINO</th>
                          <th style={{ ...s.th, minWidth: 100 }}>RESPONSABLE</th>
                          <th style={s.th}>INV-PE</th>
                          <th style={s.th}>CONTEO</th>
                        </tr>
                      </thead>
                      <tbody>
                        {invItems.map((item, idx) => {
                          const sel = selInv.has(item.id);
                          const dest = rowDest.get(item.id) ?? { loc: "", subinv: "ALMACEN", responsable: "", inv_pe: "", conteo: "" };
                          return (
                            <tr key={item.id}
                              style={{ background: sel ? "rgba(249,115,22,0.05)" : idx % 2 === 0 ? "#fff" : "#fafafa", borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
                              <td style={{ ...s.td, width: 28 }} onClick={() => setSelInv(p => { const n = new Set(p); sel ? n.delete(item.id) : n.add(item.id); return n; })}>
                                <input type="checkbox" checked={sel} readOnly style={{ accentColor: "#f97316", cursor: "pointer" }} />
                              </td>
                              <td style={{ ...s.td, color: "#6366f1" }}>{item.cod_org_inv || "—"}</td>
                              <td style={{ ...s.td, color: "#f97316", fontWeight: 700 }}>{item.codigo || "—"}</td>
                              <td style={{ ...s.td, textAlign: "left" as const, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{item.descripcion || "—"}</td>
                              <td style={{ ...s.td, color: "#64748b" }}>{item.subinventario || "—"}</td>
                              <td style={{ ...s.td, color: "#94a3b8" }}>{item.localizador || "—"}</td>
                              <td style={{ ...s.td, color: "#6366f1" }}>{item.lote || "—"}</td>
                              <td style={s.td}>{item.cantidad_fisica ?? "—"}</td>
                              <td style={{ ...s.td, color: "#fbbf24", fontWeight: 700 }}>{item.pallets ?? 0}</td>
                              <td style={s.td}>{item.cajas ?? 0}</td>
                              {/* Destino editable */}
                              <td style={{ padding: "3px 4px" }} onClick={e => e.stopPropagation()}>
                                <select value={dest.subinv} onChange={e => updateRowDest(item.id, "subinv", e.target.value)}
                                  style={{ ...s.nlInput, fontSize: 10, padding: "3px 5px", width: "100%" }}>
                                  {["ALMACEN", "PRODUCCION", "DESPACHO"].map(v => <option key={v}>{v}</option>)}
                                </select>
                              </td>
                              <td style={{ padding: "3px 4px" }} onClick={e => e.stopPropagation()}>
                                <input value={dest.loc} onChange={e => updateRowDest(item.id, "loc", e.target.value)}
                                  placeholder="ZONA.00.00.00"
                                  style={{ ...s.nlInput, fontSize: 10, padding: "3px 6px", width: "100%", minWidth: 120, borderColor: dest.loc ? "rgba(74,222,128,0.4)" : "rgba(249,115,22,0.2)", color: dest.loc ? "#166534" : "#94a3b8" }} />
                              </td>
                              <td style={{ padding: "3px 4px" }} onClick={e => e.stopPropagation()}>
                                <input value={dest.responsable} onChange={e => updateRowDest(item.id, "responsable", e.target.value)}
                                  placeholder="—" style={{ ...s.nlInput, fontSize: 10, padding: "3px 6px", width: "100%", minWidth: 90 }} />
                              </td>
                              <td style={{ padding: "3px 4px" }} onClick={e => e.stopPropagation()}>
                                <input type="number" value={dest.inv_pe} onChange={e => updateRowDest(item.id, "inv_pe", e.target.value)}
                                  placeholder="0" style={{ ...s.nlInput, fontSize: 10, padding: "3px 6px", width: 55 }} />
                              </td>
                              <td style={{ ...s.td, color: "#64748b" }}>{item.conteo ?? "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      {selInv.size > 0 && (
                        <tfoot>
                          <tr style={{ background: "#f1f5f9", borderTop: "2px solid rgba(249,115,22,0.2)" }}>
                            <td colSpan={7} style={{ ...s.td, textAlign: "right" as const, color: "#64748b", fontSize: 10, letterSpacing: 1 }}>TOTALES SELECCIÓN →</td>
                            <td style={s.td}>{invItems.filter(i => selInv.has(i.id)).reduce((a, i) => a + (i.cantidad_fisica || 0), 0)}</td>
                            <td style={{ ...s.td, color: "#fbbf24", fontWeight: 700 }}>{invItems.filter(i => selInv.has(i.id)).reduce((a, i) => a + (i.pallets || 0), 0)} plt</td>
                            <td style={s.td}>{invItems.filter(i => selInv.has(i.id)).reduce((a, i) => a + (i.cajas || 0), 0)}</td>
                            <td colSpan={5} style={{ ...s.td, color: "#60a5fa", textAlign: "left" as const }}>
                              {(invItems.filter(i => selInv.has(i.id)).reduce((a, i) => a + (i.pallets || 0), 0) * 1.2).toFixed(2)} m²
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                )}
              </>
            )}

            {/* Botones */}
            <div style={{ display: "flex", gap: 10, paddingTop: 4 }}>
              <button
                style={{ ...s.modalBtn, background: selInv.size > 0 ? "#c2410c" : "#374151", color: "#fff", flex: 1, opacity: (saving === "nueva" || selInv.size === 0) ? 0.6 : 1 }}
                onClick={confirmarCrearDesdeInv} disabled={saving === "nueva" || selInv.size === 0}>
                {saving === "nueva" ? "⟳ Creando…" : `CREAR ${selInv.size} LÍNEA${selInv.size !== 1 ? "S" : ""} [${nlTipoOrden.replace(/_/g, " ")}] →`}
              </button>
              <button style={s.modalBtnCancel} onClick={() => setNuevaLinea(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL RECHAZAR ────────────────────────────────────────────────── */}
      {rejectTarget && (
        <div style={s.overlay} onClick={() => { setRejectTarget(null); setRejectNota(""); }}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={{ ...s.modalTitle, color: "#f87171" }}>✗ RECHAZAR {rejectTarget.length > 1 ? `${rejectTarget.length} LÍNEAS` : "LÍNEA"}</div>
            <p style={{ fontSize: 11, color: "#64748b", margin: "0 0 14px" }}>El motivo queda registrado. El operador no verá esta línea.</p>
            <label style={s.fieldLabel}>MOTIVO *</label>
            <textarea autoFocus value={rejectNota} onChange={e => setRejectNota(e.target.value)}
              placeholder="Ej: Lote ya reubicado, error en localizador…" style={s.textarea} rows={3} />
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button style={{ ...s.modalBtn, background: "#7f1d1d", color: "#fca5a5", opacity: (!rejectNota.trim() || saving === "bulk") ? 0.5 : 1 }}
                onClick={confirmarRechazo} disabled={!rejectNota.trim() || saving === "bulk"}>
                {saving === "bulk" ? "⟳" : "CONFIRMAR RECHAZO →"}
              </button>
              <button style={s.modalBtnCancel} onClick={() => { setRejectTarget(null); setRejectNota(""); }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL FRACCIONAR ──────────────────────────────────────────────── */}
      {fraccion && (() => {
        const { original, p1, c1, dest1, dest2 } = fraccion;
        const ptotal = original.pallets || 0;
        const ctotal = original.cajas   || 0;
        const p2 = ptotal - p1;
        const c2 = ctotal - c1;
        const met1 = Math.round(p1 * 1.2 * 100) / 100;
        const met2 = Math.round(p2 * 1.2 * 100) / 100;
        const palOk = p1 > 0 && p2 > 0;
        const cajOk = c1 >= 0 && c2 >= 0;
        const valid = palOk && cajOk && dest1.trim() && dest2.trim();
        return (
          <div style={s.overlay} onClick={() => setFraccion(null)}>
            <div style={{ ...s.modal, maxWidth: 560 }} onClick={e => e.stopPropagation()}>
              <div style={{ ...s.modalTitle, color: "#f97316" }}>✂ FRACCIONAR LÍNEA</div>

              {/* Info original */}
              <div style={s.fracOrigBox}>
                <div style={{ fontSize: 10, letterSpacing: 2, color: "#94a3b8", marginBottom: 8 }}>LÍNEA ORIGINAL</div>
                <div style={{ display: "flex", gap: 20, flexWrap: "wrap" as const }}>
                  <div><div style={s.fracLabel}>ORIGEN</div><div style={{ fontFamily: "monospace", fontWeight: 700, color: "#f97316", fontSize: 14 }}>{original.localizador_origen || "—"}</div></div>
                  {original.lote && <div><div style={s.fracLabel}>LOTE</div><div style={{ fontWeight: 600, fontSize: 13 }}>{original.lote}</div></div>}
                  <div><div style={s.fracLabel}>PALLETS</div><div style={{ fontWeight: 700, fontSize: 22, color: "#fbbf24" }}>{ptotal}</div></div>
                  <div><div style={s.fracLabel}>CAJAS</div><div style={{ fontWeight: 700, fontSize: 22, color: "#e2e8f0" }}>{ctotal}</div></div>
                  <div><div style={s.fracLabel}>METRAJE</div><div style={{ fontWeight: 700, fontSize: 22, color: "#60a5fa" }}>{Math.round(ptotal * 1.2 * 100) / 100} m²</div></div>
                </div>
              </div>

              {/* Slider pallets */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, letterSpacing: 1.5, color: "#94a3b8", marginBottom: 6 }}>
                  <span>PALLETS FRACCIÓN 1</span><span>PALLETS FRACCIÓN 2</span>
                </div>
                <input type="range" min={1} max={ptotal - 1} value={p1}
                  onChange={e => setFraccion(f => f ? { ...f, p1: Number(e.target.value) } : f)}
                  style={{ width: "100%", accentColor: "#f97316", cursor: "pointer" }} />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <span style={{ fontSize: 11, color: "#fbbf24" }}>{p1} plt</span>
                  <span style={{ fontSize: 11, color: "#fbbf24" }}>{p2} plt</span>
                </div>
              </div>

              {/* Inputs de cajas */}
              {ctotal > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 10, letterSpacing: 1.5, color: "#94a3b8", marginBottom: 6 }}>CAJAS FRACCIÓN 1 (resto va a F2)</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input type="number" min={0} max={ctotal} value={c1}
                      onChange={e => setFraccion(f => f ? { ...f, c1: Math.min(ctotal, Math.max(0, Number(e.target.value))) } : f)}
                      style={{ ...s.fracInput, width: 80 }} />
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>F2 recibirá: <strong style={{ color: c2 >= 0 ? "#4ade80" : "#f87171" }}>{c2} cajas</strong></span>
                  </div>
                </div>
              )}

              {/* Cards F1 / F2 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {[
                  { title: "FRACCIÓN 1", plt: p1, cj: c1, met: met1, val: dest1, key: "dest1" as const },
                  { title: "FRACCIÓN 2", plt: p2, cj: c2, met: met2, val: dest2, key: "dest2" as const },
                ].map(f => (
                  <div key={f.title} style={s.fracBox}>
                    <div style={s.fracBoxTitle}>{f.title}</div>
                    <div style={s.fracStat}><span style={s.fracStatLbl}>Pallets</span><strong style={{ color: "#fbbf24" }}>{f.plt}</strong></div>
                    <div style={s.fracStat}><span style={s.fracStatLbl}>Cajas</span><strong style={{ color: "#e2e8f0" }}>{f.cj}</strong></div>
                    <div style={s.fracStat}><span style={s.fracStatLbl}>Metraje</span><strong style={{ color: "#60a5fa" }}>{f.met} m²</strong></div>
                    <label style={{ ...s.fracLabel, display: "block", marginTop: 10 }}>DESTINO *</label>
                    <input value={f.val}
                      onChange={e => setFraccion(fr => fr ? { ...fr, [f.key]: e.target.value.toUpperCase() } : fr)}
                      placeholder="ZONA7.12.01.02" style={s.fracInput} />
                  </div>
                ))}
              </div>

              {/* Resumen */}
              <div style={{ ...s.fracSumBox, marginTop: 14, borderColor: valid ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)", background: valid ? "rgba(74,222,128,0.06)" : "rgba(248,113,113,0.06)" }}>
                <span style={{ color: palOk && cajOk ? "#4ade80" : "#f87171", fontWeight: 700 }}>
                  {!palOk ? `⚠ Pallets: ${p1}+${p2} ≠ ${ptotal}` :
                   !cajOk ? `⚠ Cajas: ${c1}+${c2} ≠ ${ctotal}` :
                   `✓ ${p1}+${p2}=${ptotal} plt · ${c1}+${c2}=${ctotal} cj · ${met1}+${met2}=${Math.round((met1+met2)*100)/100} m²`}
                </span>
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button style={{ ...s.modalBtn, background: valid ? "#c2410c" : "#374151", color: "#fff", opacity: (!valid || saving === "bulk") ? 0.6 : 1, flex: 1 }}
                  onClick={confirmarFraccion} disabled={!valid || saving === "bulk"}>
                  {saving === "bulk" ? "⟳ Fraccionando…" : "CONFIRMAR FRACCIÓN →"}
                </button>
                <button style={s.modalBtnCancel} onClick={() => setFraccion(null)}>Cancelar</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Card de línea ─────────────────────────────────────────────────────────────
function LineaCard({
  l, selected, saving, operadores, onToggle, onAprobar, onRechazar, onFraccionar, onAsignarOp,
}: {
  l:           Linea;
  selected:    boolean;
  saving:      string | null;
  operadores:  Operador[];
  onToggle:    (id: string) => void;
  onAprobar:   (ids: string[]) => void;
  onRechazar:  (ids: string[]) => void;
  onFraccionar:(l: Linea) => void;
  onAsignarOp: (id: string, nombre: string) => void;
}) {
  const isPend   = l.estado === "pendiente";
  const isAprov  = l.estado === "aprobada";
  const isSaving = saving === l.id;
  const [opOpen, setOpOpen] = useState(false);
  const opRef = useRef<HTMLDivElement>(null);

  // Close op dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (opRef.current && !opRef.current.contains(e.target as Node)) setOpOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const metraje  = l.metraje ?? Math.round((l.pallets || 0) * 1.2 * 100) / 100;
  const hasDest  = !!l.localizador_destino;

  const borderColor = isAprov ? "rgba(74,222,128,0.3)"
    : l.estado === "rechazada" ? "rgba(248,113,113,0.2)"
    : selected ? "rgba(249,115,22,0.5)"
    : "rgba(0,0,0,0.08)";

  return (
    <div style={{ ...s.card, borderColor, background: selected ? "#fffbf5" : "#ffffff" }}>

      {/* ── TOP BAR ──────────────────────────────────────────────────── */}
      <div style={s.cardTop}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, flexWrap: "wrap" as const, minWidth: 0 }}>
          {isPend && (
            <input type="checkbox" checked={selected} onChange={() => onToggle(l.id)}
              style={{ width: 14, height: 14, cursor: "pointer", accentColor: "#f97316", flexShrink: 0 }} />
          )}
          <span style={{
            ...s.estadoBadge,
            background: isPend ? "#292010" : isAprov ? "#0f2a0f" : "#2a0f0f",
            color:      isPend ? "#fbbf24" : isAprov ? "#4ade80" : "#f87171",
          }}>
            {isPend ? "● PENDIENTE" : isAprov ? "✓ APROBADA" : "✗ RECHAZADA"}
          </span>
          {l.es_fraccion && <span style={{ ...s.chip, background: "rgba(139,92,246,0.08)", color: "#a78bfa", border: "1px solid rgba(139,92,246,0.25)" }}>✂ FRACCIÓN</span>}
          {l.numero_orden && <span style={{ ...s.chip, color: "#f97316", background: "transparent", border: "1px solid rgba(249,115,22,0.25)" }}>{l.numero_orden}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 10, color: "#94a3b8" }}>{timeAgo(l.created_at)}</span>
          {/* Selector de operador */}
          <div ref={opRef} style={{ position: "relative" as const }}>
            <button
              style={{ ...s.opBtn, background: l.responsable ? "#0f2a0f" : "transparent", color: l.responsable ? "#4ade80" : "#64748b", borderColor: l.responsable ? "rgba(74,222,128,0.3)" : "rgba(249,115,22,0.2)" }}
              onClick={() => setOpOpen(o => !o)}
              disabled={isSaving}
            >
              👷 {l.responsable ? l.responsable.split(" ")[0] : "ASIGNAR OP."}
            </button>
            {opOpen && (
              <div style={s.opDropdown}>
                <div style={{ fontSize: 9, letterSpacing: 2, color: "#94a3b8", padding: "8px 12px 4px", fontWeight: 600 }}>OPERADORES ACTIVOS</div>
                {operadores.length === 0 ? (
                  <div style={{ fontSize: 11, color: "#64748b", padding: "8px 12px" }}>Sin operadores registrados</div>
                ) : (
                  operadores.map(op => (
                    <button key={op.id} style={{ ...s.opItem, background: l.responsable === op.nombre ? "rgba(74,222,128,0.08)" : "transparent", color: l.responsable === op.nombre ? "#4ade80" : "#1e293b" }}
                      onClick={() => { onAsignarOp(l.id, op.nombre); setOpOpen(false); }}>
                      {l.responsable === op.nombre && "✓ "}{op.nombre}
                      {op.rol && <span style={{ fontSize: 9, color: "#94a3b8", marginLeft: 6, background: "#f1f5f9", padding: "1px 5px", borderRadius: 2 }}>{op.rol}</span>}
                    </button>
                  ))
                )}
                {l.responsable && (
                  <button style={{ ...s.opItem, color: "#f87171", borderTop: "1px solid rgba(248,113,113,0.1)" }}
                    onClick={() => { onAsignarOp(l.id, ""); setOpOpen(false); }}>
                    ✗ Quitar asignación
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── PRODUCTO ──────────────────────────────────────────────── */}
      <div style={s.productoRow}>
        {l.cod_org_inv && <div style={s.prodField}><div style={s.prodLabel}>COD. ORG INV</div><div style={{ ...s.prodVal, color: "#6366f1", fontFamily: "monospace" }}>{l.cod_org_inv}</div></div>}
        {l.codigo      && <div style={s.prodField}><div style={s.prodLabel}>CÓDIGO</div><div style={{ ...s.prodVal, color: "#f97316", fontFamily: "monospace", fontWeight: 700 }}>{l.codigo}</div></div>}
        {l.descripcion && (
          <div style={{ ...s.prodField, flex: 2, minWidth: 180 }}>
            <div style={s.prodLabel}>DESCRIPCIÓN</div>
            <div style={{ ...s.prodVal, fontWeight: 600, color: "#0f172a" }}>{l.descripcion}</div>
          </div>
        )}
        {l.lote && <div style={s.prodField}><div style={s.prodLabel}>LOTE</div><div style={{ ...s.prodVal, color: "#6366f1", fontFamily: "monospace" }}>{l.lote}</div></div>}
      </div>

      {/* ── ORIGEN → DESTINO ──────────────────────────────────────── */}
      <div style={s.routeSection}>
        <div style={s.routeGroup}>
          <div style={s.routeGroupLabel}>ORIGEN</div>
          <div style={s.routeField}><span style={s.routeFieldLabel}>SUBINV</span><span style={{ ...s.routeFieldVal, color: "#64748b" }}>{l.subinventario_origen || "—"}</span></div>
          <div style={s.routeField}><span style={s.routeFieldLabel}>LOC</span><span style={{ ...s.routeFieldVal, fontFamily: "monospace", fontWeight: 700, color: "#f97316" }}>{l.localizador_origen || "—"}</span></div>
        </div>
        <div style={s.routeArrow}>→</div>
        <div style={s.routeGroup}>
          <div style={s.routeGroupLabel}>DESTINO</div>
          <div style={s.routeField}><span style={s.routeFieldLabel}>SUBINV</span><span style={{ ...s.routeFieldVal, color: "#64748b" }}>{l.subinventario_destino || "—"}</span></div>
          <div style={s.routeField}><span style={s.routeFieldLabel}>LOC</span><span style={{ ...s.routeFieldVal, fontFamily: "monospace", fontWeight: 700, color: hasDest ? "#4ade80" : "#f87171" }}>{l.localizador_destino || "SIN ASIGNAR"}</span></div>
        </div>
      </div>

      {/* ── MÉTRICAS ──────────────────────────────────────────────── */}
      <div style={s.metricsRow}>
        {[
          { l: "CAN. FÍSICA", v: fmt(l.cantidad_fisica),      c: "#1e293b" },
          { l: "PALLETS",     v: String(l.pallets ?? 0),       c: "#fbbf24" },
          { l: "CAJAS",       v: String(l.cajas ?? 0),         c: "#1e293b" },
          { l: "METRAJE",     v: `${metraje} m²`,              c: "#60a5fa" },
          { l: "INV-PE",      v: fmt(l.inv_pe, 0),             c: "#1e293b" },
          { l: "CONTEO",      v: l.conteo != null ? String(l.conteo) : "—", c: "#1e293b" },
        ].map(m => (
          <div key={m.l} style={s.metric}>
            <div style={s.metricLabel}>{m.l}</div>
            <div style={{ ...s.metricVal, color: m.c }}>{m.v}</div>
          </div>
        ))}
      </div>

      {/* Nota de rechazo */}
      {l.notas_supervisor && l.estado === "rechazada" && (
        <div style={s.notaBox}>
          <span style={{ fontSize: 9, letterSpacing: 1.5, color: "#f87171", marginRight: 6 }}>MOTIVO:</span>
          <span style={{ fontSize: 11, color: "#94a3b8" }}>{l.notas_supervisor}</span>
        </div>
      )}

      {/* Acciones */}
      {isPend && (
        <div style={s.actionsRow}>
          <button style={{ ...s.btn, ...s.btnAprobar, opacity: isSaving ? 0.6 : 1 }}
            onClick={() => onAprobar([l.id])} disabled={isSaving}>
            {isSaving ? "⟳" : "✓ APROBAR"}
          </button>
          <button style={{ ...s.btn, ...s.btnFracc, opacity: isSaving ? 0.6 : 1 }}
            onClick={() => onFraccionar(l)} disabled={isSaving || (l.pallets ?? 0) < 2}>
            ✂ FRACCIONAR
          </button>
          <button style={{ ...s.btn, ...s.btnRechazar, opacity: isSaving ? 0.6 : 1 }}
            onClick={() => onRechazar([l.id])} disabled={isSaving}>
            ✗ RECHAZAR
          </button>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s: { [k: string]: React.CSSProperties } = {
  root:       { padding: "28px 24px", fontFamily: "'Courier New', monospace", color: "#1e293b", minHeight: "100vh", background: "#f1f5f9", position: "relative" },
  flash:      { position: "fixed", top: 20, right: 24, background: "#fff", border: "1px solid", padding: "10px 20px", borderRadius: 3, fontSize: 12, letterSpacing: 1, zIndex: 9999 },
  header:     { marginBottom: 20 },
  badge:      { display: "inline-block", fontSize: 10, letterSpacing: 3, color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", marginBottom: 10 },
  title:      { margin: "0 0 4px", fontSize: 22, fontWeight: 700, color: "#0f172a", letterSpacing: 1 },
  sub:        { margin: 0, fontSize: 11, color: "#64748b" },
  statsRow:   { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 18 },
  statCard:   { background: "#fff", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 4, padding: "12px 16px" },
  statLabel:  { fontSize: 9, letterSpacing: 2, color: "#94a3b8", marginTop: 3, fontWeight: 600 },
  tabRow:     { display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" as const, alignItems: "center" },
  tab:        { border: "1px solid", fontSize: 10, letterSpacing: 1.5, padding: "6px 12px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 },
  tabCount:   { fontSize: 10, padding: "1px 6px", borderRadius: 10, fontWeight: 700, minWidth: 18, textAlign: "center" as const },
  refreshBtn: { marginLeft: "auto", background: "transparent", border: "1px solid rgba(249,115,22,0.2)", color: "#64748b", fontSize: 14, padding: "5px 12px", cursor: "pointer", borderRadius: 2 },
  bulkBar:    { background: "#1e293b", border: "1px solid rgba(249,115,22,0.3)", borderRadius: 4, padding: "10px 16px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 10 },
  bulkBtn:    { border: "1px solid", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "7px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  selAllBtn:  { background: "transparent", border: "none", color: "#64748b", fontSize: 11, cursor: "pointer", fontFamily: "'Courier New', monospace", padding: 0 },
  empty:      { textAlign: "center" as const, color: "#94a3b8", padding: 50, fontSize: 13, border: "1px dashed rgba(249,115,22,0.1)", borderRadius: 4 },

  /* Card */
  card:         { border: "1px solid", borderRadius: 6, overflow: "hidden", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" },
  cardTop:      { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px", background: "#f8fafc", borderBottom: "1px solid rgba(0,0,0,0.06)", flexWrap: "wrap" as const, gap: 6 },
  estadoBadge:  { fontSize: 9, letterSpacing: 2, fontWeight: 700, padding: "3px 8px", borderRadius: 2 },
  chip:         { fontSize: 9, letterSpacing: 1, fontWeight: 600, padding: "2px 7px", borderRadius: 2 },

  /* Operador */
  opBtn:        { fontSize: 10, letterSpacing: 0.5, fontWeight: 600, padding: "4px 10px", cursor: "pointer", borderRadius: 2, border: "1px solid", fontFamily: "'Courier New', monospace", whiteSpace: "nowrap" as const },
  opDropdown:   { position: "absolute" as const, top: "calc(100% + 4px)", right: 0, background: "#fff", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 4, minWidth: 200, zIndex: 500, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", overflow: "hidden" },
  opItem:       { display: "block", width: "100%", textAlign: "left" as const, padding: "8px 12px", fontSize: 12, cursor: "pointer", border: "none", fontFamily: "'Courier New', monospace", letterSpacing: 0.3 },

  /* Producto */
  productoRow:  { display: "flex", gap: 20, padding: "10px 14px", flexWrap: "wrap" as const, borderBottom: "1px solid rgba(0,0,0,0.05)", background: "#fafafa" },
  prodField:    { display: "flex", flexDirection: "column" as const, gap: 2, flex: 1, minWidth: 80 },
  prodLabel:    { fontSize: 8, letterSpacing: 2, color: "#94a3b8", fontWeight: 600 },
  prodVal:      { fontSize: 13, fontWeight: 500 },

  /* Ruta */
  routeSection: { display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 14px", flexWrap: "wrap" as const, borderBottom: "1px solid rgba(0,0,0,0.05)" },
  routeGroup:   { display: "flex", flexDirection: "column" as const, gap: 4, flex: 1, minWidth: 140 },
  routeGroupLabel: { fontSize: 8, letterSpacing: 2, color: "#94a3b8", fontWeight: 700, marginBottom: 2 },
  routeField:   { display: "flex", gap: 8, alignItems: "baseline" },
  routeFieldLabel: { fontSize: 8, letterSpacing: 1.5, color: "#94a3b8", fontWeight: 600, minWidth: 36 },
  routeFieldVal:{ fontSize: 13 },
  routeArrow:   { fontSize: 20, color: "#cbd5e1", alignSelf: "center", padding: "10px 0", flexShrink: 0 },

  /* Métricas */
  metricsRow:  { display: "flex", gap: 20, padding: "10px 14px", flexWrap: "wrap" as const },
  metric:      { display: "flex", flexDirection: "column" as const, gap: 2 },
  metricLabel: { fontSize: 8, letterSpacing: 2, color: "#94a3b8", fontWeight: 600 },
  metricVal:   { fontSize: 18, fontWeight: 700, lineHeight: 1 },

  notaBox:     { padding: "8px 14px", background: "rgba(248,113,113,0.04)", borderTop: "1px solid rgba(248,113,113,0.08)" },

  /* Acciones */
  actionsRow:  { display: "flex", borderTop: "1px solid rgba(0,0,0,0.06)" },
  btn:         { flex: 1, border: "none", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "11px 0", cursor: "pointer", fontFamily: "'Courier New', monospace", textAlign: "center" as const, borderRight: "1px solid rgba(0,0,0,0.06)" },
  btnAprobar:  { background: "#f0fdf4", color: "#166534" },
  btnFracc:    { background: "#fff7ed", color: "#c2410c" },
  btnRechazar: { background: "#fef2f2", color: "#991b1b", borderRight: "none" },

  /* Modales */
  overlay:         { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
  modal:           { background: "#f8fafc", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 6, padding: "24px 28px", width: "100%", maxWidth: 480 },
  modalTitle:      { fontSize: 13, fontWeight: 700, letterSpacing: 2, marginBottom: 14 },
  fieldLabel:      { fontSize: 9, letterSpacing: 2, color: "#f97316", display: "block" as const, marginBottom: 6, fontWeight: 600 },
  textarea:        { width: "100%", background: "#f1f5f9", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 2, color: "#1e293b", fontSize: 12, padding: "10px", fontFamily: "'Courier New', monospace", outline: "none", resize: "vertical" as const, boxSizing: "border-box" as const },
  modalBtn:        { border: "none", fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: "10px 16px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },
  modalBtnCancel:  { background: "transparent", border: "1px solid rgba(249,115,22,0.2)", color: "#6b7280", fontSize: 10, letterSpacing: 1, padding: "10px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" },

  /* Nueva línea */
  nlInput: { width: "100%", background: "#f1f5f9", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 2, color: "#1e293b", fontSize: 12, padding: "7px 10px", fontFamily: "'Courier New', monospace", outline: "none", boxSizing: "border-box" as const },
  th: { fontSize: 9, letterSpacing: 1.5, color: "#94a3b8", fontWeight: 700, padding: "6px 8px", textAlign: "center" as const, whiteSpace: "nowrap" as const, borderRight: "1px solid rgba(0,0,0,0.06)" },
  td: { fontSize: 11, padding: "6px 8px", textAlign: "center" as const, borderRight: "1px solid rgba(0,0,0,0.04)" },

  /* Fracción */
  fracOrigBox:  { background: "#f1f5f9", border: "1px solid rgba(249,115,22,0.15)", borderRadius: 4, padding: "12px 16px", marginBottom: 16 },
  fracBox:      { background: "#f1f5f9", border: "1px solid rgba(249,115,22,0.15)", borderRadius: 4, padding: "12px 14px" },
  fracBoxTitle: { fontSize: 9, letterSpacing: 2, fontWeight: 700, color: "#f97316", marginBottom: 10 },
  fracLabel:    { fontSize: 9, letterSpacing: 1.5, color: "#94a3b8", fontWeight: 600 },
  fracStat:     { display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 12, marginBottom: 4 },
  fracStatLbl:  { color: "#64748b", fontSize: 10 },
  fracInput:    { width: "100%", background: "#fff", border: "1px solid rgba(249,115,22,0.3)", borderRadius: 2, color: "#1e293b", fontSize: 12, padding: "7px 9px", fontFamily: "monospace", outline: "none", boxSizing: "border-box" as const, marginTop: 4 },
  fracSumBox:   { border: "1px solid", borderRadius: 4, padding: "10px 14px", textAlign: "center" as const, marginTop: 14, fontSize: 11, fontFamily: "monospace" },
};
