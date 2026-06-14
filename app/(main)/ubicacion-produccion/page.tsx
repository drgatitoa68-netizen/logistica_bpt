"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import * as XLSX from "xlsx";
import { getBrowserClient } from "@/lib/supabase/browser";
import type { AssignedLine, LocationSuggestion } from "@/app/api/plan-ubicacion/route";
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
  const [showSuggestions, setShowSuggestions] = useState<number | null>(null);
  const [showConfirmCreate, setShowConfirmCreate] = useState(false);
  const [pendingOrders, setPendingOrders] = useState<any[]>([]);
  const [zonas,     setZonas]     = useState<string[]>([]);
  const [zonaSeleccionada, setZonaSeleccionada] = useState<string>("");
  const [loadingZonas, setLoadingZonas] = useState(true);
  const [zonaStats, setZonaStats] = useState<Map<string, { disponible: number; capacidad: number }>>(new Map());
  const [productosAgrupados, setProductosAgrupados] = useState<Map<string, { codigo: string; lote: string; cantidad: number; pallets: number; cajas: number; items: any[] }>>(new Map());
  const [tableFiltro, setTablFiltro] = useState<"todas" | "problemas" | "sin_espacio" | "fragmentadas">("todas");
  const [efficiencyMetrics, setEfficiencyMetrics] = useState<{
    espacioUtilizado: number;
    espacioTotal: number;
    porcentajeUso: number;
    fragmentacionCount: number;
    consolidacionCount: number;
    porZona: Map<string, { usado: number; total: number; porcentaje: number }>;
  } | null>(null);

  const addLog = useCallback((msg: string, cls: LogLine["cls"] = "") => {
    setLog(p => [...p, { msg, cls }]);
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, []);

  // ── Cargar zonas disponibles con estadísticas ────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await db
          .from("localizadores")
          .select("zona,disponible,capacidad")
          .eq("activo", true)
          .order("zona");
        if (error) throw error;
        const rows = (data ?? []) as { zona: string; disponible: number; capacidad: number }[];
        const uniqueZonas = [...new Set(rows.map(l => l.zona))].sort();
        setZonas(uniqueZonas);
        if (uniqueZonas.length > 0) setZonaSeleccionada(uniqueZonas[0]);

        const stats = new Map<string, { disponible: number; capacidad: number }>();
        for (const row of rows) {
          const cur = stats.get(row.zona) ?? { disponible: 0, capacidad: 0 };
          stats.set(row.zona, {
            disponible: cur.disponible + Math.max(0, row.disponible ?? 0),
            capacidad:  cur.capacidad  + (row.capacidad ?? 0),
          });
        }
        setZonaStats(stats);
      } catch (e) {
        console.error("Error cargando zonas:", e);
      } finally {
        setLoadingZonas(false);
      }
    })();
  }, []);

  const showFlash = (msg: string, ok = true) => {
    setFlash({ msg, ok });
    setTimeout(() => setFlash(null), 4000);
  };

  const applySuggestion = (rowIdx: number, suggestion: LocationSuggestion) => {
    const map = new Map(editDest);
    map.set(rowIdx, suggestion.localizador);
    setEditDest(map);
    setShowSuggestions(null);
    showFlash(`✓ Ubicación actualizada a ${suggestion.localizador}`);
  };

  // ── Calcular métricas de eficiencia ────────────────────────────────────────
  function calculateEfficiencyMetrics(assignedPlan: AssignedLine[], allLocations: any[]) {
    const porZona = new Map<string, { usado: number; total: number; porcentaje: number }>();
    
    // Inicializar por zona
    for (const loc of allLocations) {
      if (!porZona.has(loc.zona)) {
        porZona.set(loc.zona, { usado: 0, total: 0, porcentaje: 0 });
      }
      const zoneData = porZona.get(loc.zona)!;
      zoneData.total += loc.capacidad;
    }

    let fragmentacionCount = 0;
    let consolidacionCount = 0;
    let espacioUtilizado = 0;

    for (const line of assignedPlan) {
      if (line.sin_espacio || line.localizador_destino === "SIN PALLETS") continue;
      
      const palletsEfec = line.pallets_efectivos || 0;
      espacioUtilizado += palletsEfec;

      if (line.is_fragment) fragmentacionCount++;
      if (line.sugerencias?.some(s => s.es_consolidacion)) consolidacionCount++;

      if (porZona.has(line.subinventario_destino)) {
        porZona.get(line.subinventario_destino)!.usado += palletsEfec;
      }
    }

    // Calcular porcentajes
    let espacioTotal = 0;
    for (const zoneData of porZona.values()) {
      zoneData.porcentaje = zoneData.total > 0 ? Math.round((zoneData.usado / zoneData.total) * 100) : 0;
      espacioTotal += zoneData.total;
    }

    const porcentajeUso = espacioTotal > 0 ? Math.round((espacioUtilizado / espacioTotal) * 100) : 0;

    return {
      espacioUtilizado,
      espacioTotal,
      porcentajeUso,
      fragmentacionCount,
      consolidacionCount,
      porZona,
    };
  }

  // ── Excel parsing y procesamiento por zona ────────────────────────────────
  async function processFile(file: File) {
    if (!zonaSeleccionada) {
      showFlash("⚠ Selecciona una zona primero", false);
      return;
    }

    setLoading(true);
    setProgress(0);
    setProgLabel("");
    setLog([]);
    setPlan([]);
    setStats(null);
    setProductosAgrupados(new Map());

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
          else if (c === "FORMATO" || c.includes("FORMAT"))                                         col.formato = col.formato ?? idx;
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
          formato:              col.formato !== undefined ? String(get(r, "formato")).trim() : "",
        });
      }

      if (!items.length) throw new Error("No se encontraron filas con datos");
      addLog(`✓ ${items.length} líneas de producción leídas`);
      
      // Detectar si hay formatos en los datos
      const conFormato = items.filter(it => it.formato && it.formato.length > 0).length;
      if (conFormato > 0) {
        const formatosUnicos = new Set(items.filter(it => it.formato).map(it => it.formato));
        addLog(`✓ Detectado: ${conFormato}/${items.length} productos con FORMATO · Formatos: ${[...formatosUnicos].join(", ")}`, "ok");
      } else {
        addLog(`⚠ No se detectó columna FORMATO en el Excel · Se asignarán sin validar formato`, "warn");
      }
      setProgress(25);

      // ── Agrupar por lote y código ──────────────────────────────────────────
      const agrupado = new Map<string, { codigo: string; lote: string; cantidad: number; pallets: number; cajas: number; items: any[] }>();
      for (const item of items) {
        const key = `${item.codigo}|||${item.lote}`;
        if (!agrupado.has(key)) {
          agrupado.set(key, {
            codigo: item.codigo,
            lote: item.lote,
            cantidad: 0,
            pallets: 0,
            cajas: 0,
            items: [],
          });
        }
        const g = agrupado.get(key)!;
        g.cantidad += item.cantidad_fisica;
        g.pallets += item.pallets;
        g.cajas += item.cajas;
        g.items.push(item);
      }
      setProductosAgrupados(agrupado);
      addLog(`✓ ${agrupado.size} grupos únicos (código + lote)`, "ok");
      setProgress(35);

      // Load warehouse map from Supabase (solo de la zona seleccionada)
      addLog(`⟳ Cargando localizadores de zona "${zonaSeleccionada}"…`);
      const { data: locs, error: locErr } = await db
        .from("localizadores")
        .select("zona,localizador,formato,capacidad,ocupado,disponible")
        .eq("activo", true)
        .eq("zona", zonaSeleccionada);
      if (locErr) throw new Error("BD localizadores: " + locErr.message);
      
      // Log de formatos disponibles en la zona
      const formatosZona = new Set((locs ?? []).filter(l => l.formato).map(l => l.formato));
      if (formatosZona.size > 0) {
        addLog(`✓ Formatos disponibles en zona "${zonaSeleccionada}": ${[...formatosZona].join(", ")}`);
      }
      addLog(`✓ ${(locs ?? []).length} localizadores en zona "${zonaSeleccionada}"`);
      setProgress(50);

      // Call planning API con zona seleccionada
      addLog("⟳ Ejecutando algoritmo de consolidación por zona…");
      const resp = await fetch("/api/plan-ubicacion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, locations: locs ?? [], zona: zonaSeleccionada }),
      });
      const result = await resp.json();
      if (!result.ok) throw new Error("Plan: " + result.error);

      const p: AssignedLine[] = result.plan;
      const s = result.stats;
      setPlan(p);
      setStats(s);
      
      // Calcular métricas de eficiencia
      const metrics = calculateEfficiencyMetrics(p, locs ?? []);
      setEfficiencyMetrics(metrics);
      
      setProgress(100);
      setProgLabel(`✅ Plan generado: ${s.asignados} asignadas · ${s.sinEspacio} sin espacio · ${s.fragmentos} fragmentos`);
      addLog(`✅ Plan listo: ${s.asignados}/${s.total} líneas asignadas`, "ok");
      if (s.sinEspacio > 0) addLog(`⚠ ${s.sinEspacio} líneas sin espacio disponible`, "warn");
      if (s.fragmentos > 0) addLog(`⚠ ${s.fragmentos} líneas fragmentadas`, "warn");

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
    const toCreate = plan
      .filter(l => !l.sin_espacio && l.localizador_destino !== "SIN PALLETS")
      .map(l => ({
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
      }));

    if (!toCreate.length) {
      showFlash("⚠ No hay líneas para crear", false);
      return;
    }

    setPendingOrders(toCreate);
    setShowConfirmCreate(true);
  }

  async function confirmarCrearOrdenes() {
    setCreating(true);
    setShowConfirmCreate(false);
    const res = await crearLineas(pendingOrders);
    setCreating(false);
    if (res?.error) showFlash(`❌ Error: ${res.error}`, false);
    else {
      showFlash(`✓ ${pendingOrders.length} órdenes creadas → Órdenes de Producción`);
      setPendingOrders([]);
    }
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

      {/* Selector de Zona */}
      {!loadingZonas && zonas.length > 0 && (
        <div style={s.zoneSelector}>
          <label style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: 1 }}>
            📍 SELECCIONA UNA ZONA:
          </label>
          <select
            value={zonaSeleccionada}
            onChange={e => setZonaSeleccionada(e.target.value)}
            disabled={loading}
            style={{
              fontSize: 13,
              fontWeight: 600,
              padding: "8px 12px",
              border: "1px solid rgba(249,115,22,0.4)",
              borderRadius: 3,
              background: "#ffffff",
              color: zonaSeleccionada ? "#0f172a" : "#94a3b8",
              cursor: loading ? "not-allowed" : "pointer",
              fontFamily: "'Courier New', monospace",
              minWidth: 200,
              outline: "none",
            }}
          >
            <option value="">-- Selecciona zona --</option>
            {zonas.map(zona => {
              const zs = zonaStats.get(zona);
              const label = zs
                ? `${zona}  ·  ${zs.disponible} plt libres / ${zs.capacidad} total`
                : zona;
              return <option key={zona} value={zona}>{label}</option>;
            })}
          </select>
          {zonaSeleccionada && (() => {
            const zs = zonaStats.get(zonaSeleccionada);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 10, color: "#4ade80", fontWeight: 700, letterSpacing: 1 }}>
                  ✓ Zona "{zonaSeleccionada}" seleccionada
                </span>
                {zs && (
                  <span style={{ fontSize: 10, color: "#64748b" }}>
                    {zs.disponible} pallets libres · {zs.capacidad > 0 ? Math.round(((zs.capacidad - zs.disponible) / zs.capacidad) * 100) : 0}% ocupado
                  </span>
                )}
              </div>
            );
          })()}
        </div>
      )}

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

      {/* Panel de Eficiencia */}
      {efficiencyMetrics && plan.length > 0 && (
        <div style={{ background: "linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)", border: "1px solid rgba(96,165,250,0.2)", borderRadius: 4, padding: "14px 16px", marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#0f172a", marginBottom: 10, letterSpacing: 1 }}>
            📊 ANÁLISIS DE EFICIENCIA
          </div>
          
          {/* Main metrics */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 12 }}>
            {/* Uso de espacio */}
            <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 3, padding: "10px 12px" }}>
              <div style={{ fontSize: 9, color: "#64748b", marginBottom: 4, fontWeight: 600, letterSpacing: 1 }}>ESPACIO UTILIZADO</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#2563eb" }}>{efficiencyMetrics.porcentajeUso}%</div>
              <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 2 }}>
                {efficiencyMetrics.espacioUtilizado}/{efficiencyMetrics.espacioTotal} plt
              </div>
              <div style={{ width: "100%", height: 4, background: "#e2e8f0", borderRadius: 2, marginTop: 6, overflow: "hidden" }}>
                <div style={{ width: `${efficiencyMetrics.porcentajeUso}%`, height: "100%", background: "#2563eb", transition: "width 0.3s" }} />
              </div>
            </div>

            {/* Fragmentación */}
            <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 3, padding: "10px 12px" }}>
              <div style={{ fontSize: 9, color: "#64748b", marginBottom: 4, fontWeight: 600, letterSpacing: 1 }}>FRAGMENTACIÓN</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: efficiencyMetrics.fragmentacionCount > stats?.fragmentos! / 2 ? "#ef4444" : "#f59e0b" }}>
                {efficiencyMetrics.fragmentacionCount}
              </div>
              <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 2 }}>líneas fragmentadas</div>
            </div>

            {/* Consolidación */}
            <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 3, padding: "10px 12px" }}>
              <div style={{ fontSize: 9, color: "#64748b", marginBottom: 4, fontWeight: 600, letterSpacing: 1 }}>CONSOLIDACIÓN</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#16a34a" }}>
                {efficiencyMetrics.consolidacionCount}
              </div>
              <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 2 }}>lotes consolidados</div>
            </div>
          </div>

          {/* Por zona */}
          {efficiencyMetrics.porZona.size > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, paddingTop: 10, borderTop: "1px solid #e2e8f0" }}>
              {Array.from(efficiencyMetrics.porZona.entries()).map(([zona, data]) => (
                <div key={zona} style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 2, padding: "8px 10px" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#0f172a", marginBottom: 4 }}>Zona {zona}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: data.porcentaje > 80 ? "#ef4444" : data.porcentaje > 60 ? "#f59e0b" : "#16a34a" }}>
                    {data.porcentaje}%
                  </div>
                  <div style={{ fontSize: 8, color: "#94a3b8" }}>{data.usado}/{data.total} plt</div>
                </div>
              ))}
            </div>
          )}
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

      {/* Resumen de Consolidación por Lote */}
      {productosAgrupados.size > 0 && plan.length === 0 && (
        <div style={{ background: "#ffffff", border: "1px solid rgba(74,222,128,0.25)", borderRadius: 3, padding: "14px", marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#0f172a", marginBottom: 10, letterSpacing: 1 }}>
            📦 PRODUCTOS CONSOLIDADOS POR LOTE Y CÓDIGO
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 8 }}>
            {Array.from(productosAgrupados.values())
              .sort((a, b) => (b.pallets + b.cajas) - (a.pallets + a.cajas))
              .map((prod, idx) => (
                <div key={idx} style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 2, padding: "8px 10px", fontSize: 10 }}>
                  <div style={{ fontWeight: 700, color: "#f97316", marginBottom: 4, fontFamily: "monospace" }}>
                    {prod.codigo}
                  </div>
                  <div style={{ color: "#475569", marginBottom: 3, fontSize: 9 }}>
                    <strong>Lote:</strong> {prod.lote || "—"}
                  </div>
                  <div style={{ display: "flex", gap: 8, fontSize: 9, color: "#6b7280" }}>
                    <span>🔹 {prod.pallets} plt + {prod.cajas} cj</span>
                    <span>📊 {prod.cantidad.toFixed(0)} unid</span>
                  </div>
                  <div style={{ color: "#94a3b8", fontSize: 8, marginTop: 4 }}>
                    {prod.items.length} línea{prod.items.length !== 1 ? 's' : ''}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Plan table */}
      {plan.length > 0 && (() => {
        const planFiltrado = plan.filter(l => {
          if (tableFiltro === "sin_espacio")  return l.sin_espacio;
          if (tableFiltro === "fragmentadas") return l.is_fragment;
          if (tableFiltro === "problemas")    return l.sin_espacio || l.is_fragment;
          return true;
        });
        const cntSinEsp = plan.filter(l => l.sin_espacio).length;
        const cntFrag   = plan.filter(l => l.is_fragment).length;
        return (
        <>
          {/* Filtros de tabla */}
          <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" as const, alignItems: "center" }}>
            {([
              { k: "todas",       l: `Todas (${plan.length})`,            c: "#94a3b8" },
              { k: "problemas",   l: `Problemas (${cntSinEsp + cntFrag})`, c: "#fbbf24" },
              { k: "sin_espacio", l: `Sin espacio (${cntSinEsp})`,          c: "#f87171" },
              { k: "fragmentadas",l: `Fragmentadas (${cntFrag})`,           c: "#f97316" },
            ] as const).map(f => (
              <button
                key={f.k}
                onClick={() => setTablFiltro(f.k)}
                style={{
                  background: tableFiltro === f.k ? `${f.c}18` : "transparent",
                  border: `1px solid ${tableFiltro === f.k ? f.c : "rgba(249,115,22,0.2)"}`,
                  color: tableFiltro === f.k ? f.c : "#64748b",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 1,
                  padding: "5px 10px",
                  cursor: "pointer",
                  borderRadius: 2,
                  fontFamily: "'Courier New', monospace",
                }}
              >
                {f.l}
              </button>
            ))}
            <span style={{ marginLeft: "auto", fontSize: 10, color: "#94a3b8" }}>
              {planFiltrado.length} fila{planFiltrado.length !== 1 ? "s" : ""} mostrada{planFiltrado.length !== 1 ? "s" : ""}
            </span>
          </div>

          <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr style={s.thead}>
                {["ORD.#", "COD.ORG", "CÓDIGO", "DESCRIPCIÓN", "SI ORIGEN", "LOC ORIGEN", "LOTE", "CAN.FÍS.", "PLT", "CAJAS", "PLT.EFEC.", "SI DESTINO", "LOC DESTINO", "SUGERENCIAS", "RESPONSABLE", "INV-PE", "CONTEO", "EST."].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {planFiltrado.map((l, i) => {
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
                    {/* Sugerencias */}
                    <td style={s.td}>
                      {l.sugerencias && l.sugerencias.length > 0 && (
                        <button
                          style={{
                            background: "#1e40af",
                            border: "none",
                            color: "#60a5fa",
                            fontSize: 9,
                            fontWeight: 700,
                            padding: "3px 7px",
                            cursor: "pointer",
                            borderRadius: 2,
                            fontFamily: "monospace",
                          }}
                          onClick={() => setShowSuggestions(l.row_idx)}
                        >
                          {l.sugerencias.length} opciones
                        </button>
                      )}
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
        </>
        );
      })()}

      {!plan.length && !loading && !progLabel && (
        <div style={s.empty}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 13, color: "#64748b" }}>Sube el Excel de Producción para ver el plan de ubicación</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8, maxWidth: 440, textAlign: "center" as const }}>
            El algoritmo agrupa por código + lote, prioriza localizadores con formato compatible y mantiene la consistencia de zona por producto.
          </div>
        </div>
      )}

      {/* ── Modal de sugerencias ──────────────────────────────────────────── */}
      {showSuggestions !== null && (() => {
        const line = plan.find(l => l.row_idx === showSuggestions);
        if (!line?.sugerencias?.length) return null;
        return (
          <div style={s.modalOverlay} onClick={() => setShowSuggestions(null)}>
            <div style={s.modalContent} onClick={e => e.stopPropagation()}>

              {/* Header */}
              <div style={s.modalHeader}>
                <div>
                  <div style={{ fontSize: 9, letterSpacing: 2, color: "#f97316", marginBottom: 4 }}>SUGERENCIAS DE UBICACIÓN</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
                    <span style={{ fontFamily: "monospace", color: "#f97316" }}>{line.codigo || "—"}</span>
                    {" · "}{line.descripcion.slice(0, 42)}{line.descripcion.length > 42 ? "…" : ""}
                  </div>
                  <div style={{ fontSize: 11, color: "#64748b", marginTop: 3 }}>
                    Lote: <strong>{line.lote || "—"}</strong> · {line.pallets_efectivos} plt efectivos · {line.pallets} plt + {line.cajas} cj
                  </div>
                </div>
                <button onClick={() => setShowSuggestions(null)} style={{ background: "transparent", border: "none", fontSize: 18, color: "#94a3b8", cursor: "pointer", padding: "2px 6px", lineHeight: 1 }}>
                  ✕
                </button>
              </div>

              {/* Suggestion cards */}
              <div style={s.modalBody}>
                {line.sugerencias.map((sg, idx) => (
                  <div key={sg.localizador} style={{
                    ...s.suggestionItem,
                    borderColor: sg.es_consolidacion
                      ? "rgba(74,222,128,0.45)"
                      : idx === 0
                      ? "rgba(249,115,22,0.4)"
                      : "rgba(226,232,240,0.8)",
                    background: sg.es_consolidacion
                      ? "#f0fdf4"
                      : idx === 0
                      ? "#fffaf5"
                      : "#f8fafc",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {idx === 0 && !sg.es_consolidacion && (
                          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, background: "#f97316", color: "#fff", padding: "2px 6px", borderRadius: 2 }}>MEJOR</span>
                        )}
                        {sg.es_consolidacion && (
                          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, background: "#16a34a", color: "#fff", padding: "2px 6px", borderRadius: 2 }}>CONSOLIDA LOTE</span>
                        )}
                        <span style={{ fontSize: 15, fontWeight: 700, fontFamily: "monospace", color: "#0f172a" }}>
                          {sg.localizador}
                        </span>
                        <span style={{ fontSize: 11, color: "#64748b" }}>Zona {sg.zona}</span>
                      </div>
                      <button
                        onClick={() => applySuggestion(showSuggestions, sg)}
                        style={{ background: "#16a34a", border: "none", color: "#fff", fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: "6px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" }}
                      >
                        APLICAR →
                      </button>
                    </div>

                    <div style={{ display: "flex", gap: 18, flexWrap: "wrap" as const }}>
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: "#2563eb", lineHeight: 1 }}>{sg.capacidad_disponible}</div>
                        <div style={{ fontSize: 10, color: "#94a3b8" }}>plt disponibles</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: "#d97706", lineHeight: 1 }}>{sg.score.toLocaleString("es")}</div>
                        <div style={{ fontSize: 10, color: "#94a3b8" }}>score</div>
                      </div>
                      <div style={{ flex: 1, fontSize: 11, color: "#475569", alignSelf: "center" as const, lineHeight: 1.5 }}>
                        {sg.reason}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Footer */}
              <div style={{ padding: "10px 16px 14px", borderTop: "1px solid #f1f5f9", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 10, color: "#94a3b8" }}>
                  También puedes editar directamente el campo "LOC DESTINO" en la tabla
                </span>
                <button onClick={() => setShowSuggestions(null)}
                  style={{ background: "transparent", border: "1px solid #e2e8f0", color: "#64748b", fontSize: 11, padding: "6px 14px", cursor: "pointer", borderRadius: 3 }}>
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal de confirmación pre-creación */}
      {showConfirmCreate && pendingOrders.length > 0 && (
        <div style={s.modalOverlay} onClick={() => setShowConfirmCreate(false)}>
          <div
            style={s.modalContent}
            onClick={e => e.stopPropagation()}
          >
            <div style={s.modalHeader}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a", letterSpacing: 1 }}>
                  ✓ CONFIRMAR CREACIÓN
                </div>
                <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>Resumen de órdenes a crear</div>
              </div>
              <button onClick={() => setShowConfirmCreate(false)} style={{ background: "transparent", border: "none", fontSize: 18, color: "#94a3b8", cursor: "pointer", padding: "2px 6px", lineHeight: 1 }}>
                ✕
              </button>
            </div>

            <div style={s.modalBody}>
              {/* Summary stats */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 3, padding: "10px 12px" }}>
                  <div style={{ fontSize: 9, color: "#64748b", marginBottom: 4, fontWeight: 600, letterSpacing: 1 }}>ÓRDENES A CREAR</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#16a34a" }}>{pendingOrders.length}</div>
                </div>
                <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 3, padding: "10px 12px" }}>
                  <div style={{ fontSize: 9, color: "#64748b", marginBottom: 4, fontWeight: 600, letterSpacing: 1 }}>PALLETS</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#2563eb" }}>
                    {pendingOrders.reduce((s, o) => s + (o.pallets || 0), 0)}
                  </div>
                </div>
              </div>

              {/* Detalles principales */}
              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 3, padding: "12px", marginBottom: 14, fontSize: 11 }}>
                <div style={{ fontWeight: 700, color: "#0f172a", marginBottom: 8 }}>Detalles:</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <div>
                    <div style={{ color: "#94a3b8", fontSize: 9, marginBottom: 2 }}>CÓDIGOS ÚNICOS</div>
                    <div style={{ fontWeight: 700 }}>{new Set(pendingOrders.map(o => o.codigo)).size}</div>
                  </div>
                  <div>
                    <div style={{ color: "#94a3b8", fontSize: 9, marginBottom: 2 }}>LOTES</div>
                    <div style={{ fontWeight: 700 }}>{new Set(pendingOrders.map(o => o.lote)).size}</div>
                  </div>
                  <div>
                    <div style={{ color: "#94a3b8", fontSize: 9, marginBottom: 2 }}>TOTAL CAJAS</div>
                    <div style={{ fontWeight: 700 }}>{pendingOrders.reduce((s, o) => s + (o.cajas || 0), 0)}</div>
                  </div>
                  <div>
                    <div style={{ color: "#94a3b8", fontSize: 9, marginBottom: 2 }}>ZONA</div>
                    <div style={{ fontWeight: 700 }}>{zonaSeleccionada || "—"}</div>
                  </div>
                </div>
              </div>

              {/* Validaciones */}
              <div style={{ background: "#fffaf5", border: "1px solid rgba(249,115,22,0.2)", borderRadius: 3, padding: "10px 12px", marginBottom: 14, fontSize: 10 }}>
                <div style={{ fontWeight: 700, color: "#92400e", marginBottom: 6 }}>⚠ Validaciones:</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ color: "#b45309" }}>✓ Todas las líneas tienen destino asignado</div>
                  {efficiencyMetrics && efficiencyMetrics.porcentajeUso > 90 && (
                    <div style={{ color: "#dc2626" }}>⚠ Alto nivel de ocupación ({efficiencyMetrics.porcentajeUso}%)</div>
                  )}
                  {efficiencyMetrics && efficiencyMetrics.fragmentacionCount > pendingOrders.length * 0.3 && (
                    <div style={{ color: "#ea580c" }}>⚠ Alta fragmentación ({efficiencyMetrics.fragmentacionCount} lotes fragmentados)</div>
                  )}
                </div>
              </div>

              {/* Botones */}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button
                  onClick={() => setShowConfirmCreate(false)}
                  style={{ background: "transparent", border: "1px solid #e2e8f0", color: "#64748b", fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: "8px 14px", cursor: "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace" }}
                >
                  CANCELAR
                </button>
                <button
                  onClick={confirmarCrearOrdenes}
                  disabled={creating}
                  style={{ background: "#16a34a", border: "none", color: "#fff", fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: "8px 16px", cursor: creating ? "not-allowed" : "pointer", borderRadius: 2, fontFamily: "'Courier New', monospace", opacity: creating ? 0.6 : 1 }}
                >
                  {creating ? "CREANDO…" : "CREAR ÓRDENES →"}
                </button>
              </div>
            </div>
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
  modalOverlay:  { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000 },
  modalContent:  { background: "#ffffff", borderRadius: 4, boxShadow: "0 10px 40px rgba(0,0,0,0.2)", maxWidth: 500, width: "90%", maxHeight: "80vh", overflowY: "auto" as const },
  modalHeader:   { display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "14px 16px", borderBottom: "1px solid rgba(249,115,22,0.15)" },
  modalBody:     { padding: "14px 16px" },
  suggestionItem: { border: "1px solid", borderRadius: 3, padding: "10px 12px", marginBottom: 8, cursor: "pointer", transition: "all 0.2s", background: "#f8fafc" },
  zoneSelector:  { display: "flex", alignItems: "center", gap: 12, marginBottom: 16, background: "#ffffff", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 3, padding: "10px 14px" },
};

