"use client";

import { useEffect, useState, useCallback } from "react";
import { getBrowserClient } from "@/lib/supabase/browser";
import { ESTADO_COLOR, type EstadoLinea } from "@/lib/shared/ordenes";
import * as XLSX from "xlsx";

const db = getBrowserClient();

interface ReporteRow {
  id: string;
  numero_orden: string | null;
  codigo: string | null;
  descripcion: string;
  subinventario_origen: string | null;
  localizador_origen: string | null;
  subinventario_destino: string | null;
  localizador_destino: string | null;
  lote: string | null;
  pallets: number;
  cajas: number;
  metraje: number | null;
  responsable: string | null;
  operador_email: string | null;
  supervisor_email: string | null;
  estado: EstadoLinea;
  notas_supervisor: string | null;
  inicio_operador: string | null;
  fin_operador: string | null;
  duracion_minutos: number | null;
  es_fraccion: boolean | null;
  created_at: string;
  updated_at: string;
}

interface KpiResumen {
  total: number;
  completadas: number;
  rechazadas: number;
  enProceso: number;
  pendientes: number;
  palletsTotales: number;
  duracionPromedio: number | null;
}

function fmt(v: number | null | undefined, dec = 1) {
  if (v == null) return "—";
  return Number(v).toLocaleString("es", { maximumFractionDigits: dec });
}

function fmtDuracion(min: number | null | undefined) {
  if (!min) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  return `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`;
}

function fmtFecha(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-EC", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

type RangoFecha = "hoy" | "semana" | "mes" | "todo";

const PAGE_SIZE = 80;

export default function ReportesPage() {
  const [rows,      setRows]      = useState<ReporteRow[]>([]);
  const [total,     setTotal]     = useState(0);
  const [loading,   setLoading]   = useState(true);
  const [page,      setPage]      = useState(0);
  const [exporting, setExporting] = useState(false);

  const [kpis, setKpis] = useState<KpiResumen>({
    total: 0, completadas: 0, rechazadas: 0, enProceso: 0, pendientes: 0,
    palletsTotales: 0, duracionPromedio: null,
  });

  const [rango,        setRango]        = useState<RangoFecha>("semana");
  const [fEstado,      setFEstado]      = useState<EstadoLinea | "todas">("todas");
  const [fOperador,    setFOperador]    = useState("todas");
  const [fSearch,      setFSearch]      = useState("");
  const [operadores,   setOperadores]   = useState<string[]>([]);

  function rangoFecha(r: RangoFecha): string | null {
    const now = new Date();
    if (r === "hoy") {
      now.setHours(0, 0, 0, 0);
      return now.toISOString();
    }
    if (r === "semana") {
      now.setDate(now.getDate() - 7);
      return now.toISOString();
    }
    if (r === "mes") {
      now.setMonth(now.getMonth() - 1);
      return now.toISOString();
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildQuery = useCallback((q: any) => {
    const desde = rangoFecha(rango);
    if (desde) q = q.gte("updated_at", desde);
    if (fEstado !== "todas") q = q.eq("estado", fEstado);
    if (fOperador !== "todas") q = q.eq("responsable", fOperador);
    if (fSearch) q = q.or(`codigo.ilike.%${fSearch}%,descripcion.ilike.%${fSearch}%,numero_orden.ilike.%${fSearch}%,localizador_origen.ilike.%${fSearch}%`);
    return q;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rango, fEstado, fOperador, fSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    const base = db.from("lineas_reubicacion").select(
      "id,numero_orden,codigo,descripcion,subinventario_origen,localizador_origen,subinventario_destino,localizador_destino,lote,pallets,cajas,metraje,responsable,operador_email,supervisor_email,estado,notas_supervisor,inicio_operador,fin_operador,duracion_minutos,es_fraccion,created_at,updated_at",
      { count: "exact" }
    );
    const { data, count } = await buildQuery(base)
      .order("updated_at", { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    setRows((data as ReporteRow[]) ?? []);
    setTotal(count ?? 0);
    setLoading(false);
  }, [buildQuery, page]);

  const loadKpis = useCallback(async () => {
    const base = db.from("lineas_reubicacion").select("estado,pallets,duracion_minutos");
    const { data } = await buildQuery(base);
    const all = (data as { estado: string; pallets: number; duracion_minutos: number | null }[]) ?? [];
    const completadas = all.filter(r => r.estado === "completada");
    const duraciones = completadas.map(r => r.duracion_minutos).filter((v): v is number => v != null);
    setKpis({
      total:           all.length,
      completadas:     completadas.length,
      rechazadas:      all.filter(r => r.estado === "rechazada").length,
      enProceso:       all.filter(r => r.estado === "en_proceso").length,
      pendientes:      all.filter(r => r.estado === "pendiente").length,
      palletsTotales:  all.reduce((s, r) => s + (r.pallets || 0), 0),
      duracionPromedio: duraciones.length > 0
        ? duraciones.reduce((a, b) => a + b, 0) / duraciones.length
        : null,
    });
  }, [buildQuery]);

  const loadOperadores = useCallback(async () => {
    const { data } = await db.from("lineas_reubicacion").select("responsable").not("responsable", "is", null);
    const ops = [...new Set((data ?? []).map((r: { responsable: string }) => r.responsable).filter(Boolean))].sort();
    setOperadores(ops as string[]);
  }, []);

  useEffect(() => { loadOperadores(); }, [loadOperadores]);
  useEffect(() => { setPage(0); }, [rango, fEstado, fOperador, fSearch]);
  useEffect(() => { load(); loadKpis(); }, [load, loadKpis]);

  async function exportarExcel() {
    setExporting(true);
    const base = db.from("lineas_reubicacion").select(
      "numero_orden,codigo,descripcion,subinventario_origen,localizador_origen,subinventario_destino,localizador_destino,lote,pallets,cajas,metraje,responsable,operador_email,supervisor_email,estado,notas_supervisor,inicio_operador,fin_operador,duracion_minutos,es_fraccion,created_at,updated_at"
    );
    const { data } = await buildQuery(base).order("updated_at", { ascending: false });
    const rows = (data ?? []).map((r: Record<string, unknown>) => ({
      "N° Orden":       r.numero_orden ?? "",
      "Código":         r.codigo ?? "",
      "Descripción":    r.descripcion,
      "Sub. Origen":    r.subinventario_origen ?? "",
      "Loc. Origen":    r.localizador_origen ?? "",
      "Sub. Destino":   r.subinventario_destino ?? "",
      "Loc. Destino":   r.localizador_destino ?? "",
      "Lote":           r.lote ?? "",
      "Pallets":        r.pallets,
      "Cajas":          r.cajas,
      "Metraje m²":     r.metraje ?? "",
      "Responsable":    r.responsable ?? "",
      "Operador Email": r.operador_email ?? "",
      "Supervisor":     r.supervisor_email ?? "",
      "Estado":         r.estado,
      "Notas Sup.":     r.notas_supervisor ?? "",
      "Inicio Op.":     r.inicio_operador ? new Date(r.inicio_operador as string).toLocaleString("es-EC") : "",
      "Fin Op.":        r.fin_operador    ? new Date(r.fin_operador    as string).toLocaleString("es-EC") : "",
      "Duración (min)": r.duracion_minutos ?? "",
      "Fracción":       r.es_fraccion ? "Sí" : "No",
      "Creado":         new Date(r.created_at as string).toLocaleString("es-EC"),
      "Actualizado":    new Date(r.updated_at as string).toLocaleString("es-EC"),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Reportes");
    const label = rango === "todo" ? "todo" : rango;
    XLSX.writeFile(wb, `reporte_${label}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    setExporting(false);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const sel: React.CSSProperties = { fontSize: 12, padding: "6px 10px", border: "1px solid #2e3247", borderRadius: 6, background: "#1a1d27", color: "#e8eaf0", outline: "none" };

  const kpiCards = [
    { label: "Total líneas",       value: kpis.total,            color: "#8b8fa8" },
    { label: "Completadas",        value: kpis.completadas,      color: "#4ade80" },
    { label: "En proceso",         value: kpis.enProceso,        color: "#60a5fa" },
    { label: "Pendientes",         value: kpis.pendientes,       color: "#fbbf24" },
    { label: "Rechazadas",         value: kpis.rechazadas,       color: "#f87171" },
    { label: "Pallets movidos",    value: kpis.palletsTotales,   color: "#a78bfa" },
    { label: "Duración prom.",     value: fmtDuracion(kpis.duracionPromedio), color: "#34d399" },
  ];

  const rangoOptions: { v: RangoFecha; l: string }[] = [
    { v: "hoy",    l: "Hoy" },
    { v: "semana", l: "Últimos 7 días" },
    { v: "mes",    l: "Último mes" },
    { v: "todo",   l: "Todo" },
  ];

  const estadoOptions: { v: EstadoLinea | "todas"; l: string }[] = [
    { v: "todas",      l: "Todos los estados" },
    { v: "completada", l: "Completadas" },
    { v: "en_proceso", l: "En proceso" },
    { v: "aprobada",   l: "Aprobadas" },
    { v: "pendiente",  l: "Pendientes" },
    { v: "rechazada",  l: "Rechazadas" },
  ];

  return (
    <div style={{ background: "#0f1117", minHeight: "100%", color: "#e8eaf0", fontFamily: "'Segoe UI', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ background: "#1a1d27", borderBottom: "1px solid #2e3247", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 34, height: 34, background: "#059669", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📊</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Reportes</div>
            <div style={{ fontSize: 11, color: "#8b8fa8" }}>Historial de operaciones · rendimiento por operador</div>
          </div>
        </div>
        <button onClick={exportarExcel} disabled={exporting || total === 0}
          style={{ padding: "7px 16px", background: exporting ? "#1a2e1a" : "#166534", border: "none", borderRadius: 7, color: "#fff", fontSize: 12, fontWeight: 600, cursor: total ? "pointer" : "not-allowed", opacity: total ? 1 : 0.5 }}>
          {exporting ? "⏳ Exportando…" : "⬇ Exportar Excel"}
        </button>
      </div>

      {/* KPI summary */}
      <div style={{ padding: "12px 20px", display: "flex", gap: 10, flexWrap: "wrap" }}>
        {kpiCards.map(k => (
          <div key={k.label} style={{ flex: "1 1 120px", background: "#1a1d27", border: "1px solid #2e3247", borderRadius: 10, padding: "10px 14px" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: k.color, lineHeight: 1 }}>{typeof k.value === "number" ? k.value.toLocaleString("es") : k.value}</div>
            <div style={{ fontSize: 10, color: "#8b8fa8", marginTop: 3 }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div style={{ padding: "8px 20px 12px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", borderBottom: "1px solid #2e3247" }}>
        {/* Rango */}
        <div style={{ display: "flex", gap: 0, border: "1px solid #2e3247", borderRadius: 6, overflow: "hidden" }}>
          {rangoOptions.map(o => (
            <button key={o.v} onClick={() => setRango(o.v)}
              style={{ padding: "6px 12px", fontSize: 11, border: "none", cursor: "pointer", fontWeight: rango === o.v ? 700 : 400,
                background: rango === o.v ? "#f97316" : "#1a1d27", color: rango === o.v ? "#000" : "#8b8fa8" }}>
              {o.l}
            </button>
          ))}
        </div>

        <select value={fEstado} onChange={e => setFEstado(e.target.value as typeof fEstado)} style={sel}>
          {estadoOptions.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>

        <select value={fOperador} onChange={e => setFOperador(e.target.value)} style={sel}>
          <option value="todas">Todos los operadores</option>
          {operadores.map(op => <option key={op} value={op}>{op}</option>)}
        </select>

        <input value={fSearch} onChange={e => setFSearch(e.target.value)}
          placeholder="Buscar orden / código / descripción / loc…"
          style={{ ...sel, width: 260 }} />

        {(fEstado !== "todas" || fOperador !== "todas" || fSearch) && (
          <button onClick={() => { setFEstado("todas"); setFOperador("todas"); setFSearch(""); }}
            style={{ ...sel, cursor: "pointer", color: "#f87171", borderColor: "#7f1d1d" }}>✕ Limpiar</button>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#5a5e75" }}>
          {total.toLocaleString()} registros
        </span>
      </div>

      {/* Tabla */}
      <div style={{ padding: "0 20px 20px" }}>
        <div style={{ overflowX: "auto", border: "1px solid #2e3247", borderRadius: 10, marginTop: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: "#1a1d27", borderBottom: "1px solid #2e3247" }}>
                {[
                  "Estado", "N° Orden", "Código", "Descripción", "Origen → Destino",
                  "Pallets", "Metraje", "Responsable", "Duración", "Actualizado",
                ].map(h => (
                  <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: "#8b8fa8", fontWeight: 500, whiteSpace: "nowrap", fontSize: 11 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array(8).fill(0).map((_, i) => (
                    <tr key={i}><td colSpan={10} style={{ padding: "8px 10px" }}>
                      <div style={{ height: 14, background: "#222535", borderRadius: 4, animation: "pulse 1.5s infinite", width: `${50 + (i * 11) % 40}%` }} />
                    </td></tr>
                  ))
                : rows.map((r, i) => {
                    const ec = ESTADO_COLOR[r.estado] ?? { bg: "#1e2235", color: "#8b8fa8", label: r.estado };
                    return (
                      <tr key={r.id} style={{ borderBottom: "1px solid #1e2235", background: i % 2 === 0 ? "transparent" : "#1c1f2d" }}>
                        <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>
                          <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 4, fontWeight: 700, background: ec.bg, color: ec.color }}>
                            {ec.label}
                          </span>
                        </td>
                        <td style={{ padding: "6px 10px", color: "#8b8fa8", whiteSpace: "nowrap", fontFamily: "monospace" }}>
                          {r.numero_orden ?? "—"}
                        </td>
                        <td style={{ padding: "6px 10px", fontWeight: 600, color: "#93c5fd", fontFamily: "monospace", whiteSpace: "nowrap" }}>
                          {r.codigo ?? "—"}
                        </td>
                        <td style={{ padding: "6px 10px", color: "#c8cad8", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.descripcion}>
                          {r.descripcion}
                          {r.es_fraccion && <span style={{ marginLeft: 4, fontSize: 9, color: "#f97316" }}>⚡fracción</span>}
                        </td>
                        <td style={{ padding: "6px 10px", whiteSpace: "nowrap", color: "#8b8fa8", fontSize: 10 }}>
                          <span style={{ color: "#c8cad8" }}>{r.localizador_origen ?? "?"}</span>
                          <span style={{ color: "#4b5563" }}> → </span>
                          <span style={{ color: r.localizador_destino ? "#4ade80" : "#4b5563" }}>{r.localizador_destino ?? "—"}</span>
                        </td>
                        <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700, color: r.pallets > 0 ? "#a78bfa" : "#5a5e75" }}>
                          {r.pallets}
                        </td>
                        <td style={{ padding: "6px 10px", textAlign: "right", color: "#8b8fa8" }}>
                          {r.metraje ? `${fmt(r.metraje)} m²` : "—"}
                        </td>
                        <td style={{ padding: "6px 10px", color: "#8b8fa8", whiteSpace: "nowrap", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }} title={r.responsable ?? ""}>
                          {r.responsable ?? "—"}
                        </td>
                        <td style={{ padding: "6px 10px", whiteSpace: "nowrap", color: r.duracion_minutos ? "#34d399" : "#5a5e75" }}>
                          {fmtDuracion(r.duracion_minutos)}
                        </td>
                        <td style={{ padding: "6px 10px", color: "#5a5e75", fontSize: 10, whiteSpace: "nowrap" }}>
                          {fmtFecha(r.updated_at)}
                        </td>
                      </tr>
                    );
                  })
              }
              {!loading && rows.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 40, textAlign: "center", color: "#5a5e75" }}>
                  Sin resultados para los filtros seleccionados
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Paginación */}
        {totalPages > 1 && (
          <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", marginTop: 12 }}>
            <button onClick={() => setPage(0)} disabled={page === 0}
              style={{ ...sel, cursor: page > 0 ? "pointer" : "not-allowed", opacity: page > 0 ? 1 : 0.4 }}>«</button>
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              style={{ ...sel, cursor: page > 0 ? "pointer" : "not-allowed", opacity: page > 0 ? 1 : 0.4 }}>‹</button>
            <span style={{ fontSize: 12, color: "#8b8fa8" }}>Página {page + 1} de {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
              style={{ ...sel, cursor: page < totalPages - 1 ? "pointer" : "not-allowed", opacity: page < totalPages - 1 ? 1 : 0.4 }}>›</button>
            <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}
              style={{ ...sel, cursor: page < totalPages - 1 ? "pointer" : "not-allowed", opacity: page < totalPages - 1 ? 1 : 0.4 }}>»</button>
          </div>
        )}
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:.8} }`}</style>
    </div>
  );
}
