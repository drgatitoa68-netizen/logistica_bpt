"use client";

import { useEffect, useState, useCallback } from "react";
import { getBrowserClient } from "@/lib/supabase/browser";
import * as XLSX from "xlsx";

const db = getBrowserClient();

interface InvRow {
  id: string; codigo: string; descripcion: string; lote: string;
  localizador: string; subinventario: string; pallets: number; cajas: number;
  cantidad_fisica: number; formato: string; um: string; estado: string;
  lote_status: string; calidad: string; marca: string; updated_at: string;
}

interface Kpis { registros: number; pallets: number; cajas: number; m2: number; }

type SortKey = keyof InvRow;

const PAGE_SIZE = 100;

const COLS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "codigo",       label: "Código" },
  { key: "descripcion",  label: "Descripción" },
  { key: "lote",         label: "Lote" },
  { key: "localizador",  label: "Localizador" },
  { key: "subinventario",label: "Subinventario" },
  { key: "pallets",      label: "Pallets",  align: "right" },
  { key: "cajas",        label: "Cajas",    align: "right" },
  { key: "cantidad_fisica", label: "M²",   align: "right" },
  { key: "um",           label: "UM" },
  { key: "formato",      label: "Formato" },
  { key: "estado",       label: "Estado" },
  { key: "lote_status",  label: "Lote Status" },
];

export default function InventarioPage() {
  const [rows,    setRows]    = useState<InvRow[]>([]);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [page,    setPage]    = useState(0);
  const [kpis,    setKpis]    = useState<Kpis>({ registros: 0, pallets: 0, cajas: 0, m2: 0 });
  const [exporting, setExporting] = useState(false);

  const [fSubinv, setFSubinv] = useState("all");
  const [fUm,     setFUm]     = useState("all");
  const [fEstado, setFEstado] = useState("all");
  const [fSearch, setFSearch] = useState("");

  const [sortKey, setSortKey] = useState<SortKey>("subinventario");
  const [sortAsc, setSortAsc] = useState(true);

  const [subinvs, setSubinvs] = useState<string[]>([]);
  const [ums,     setUms]     = useState<string[]>([]);
  const [estados, setEstados] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    let q = db.from("inventario").select(
      "id,codigo,descripcion,lote,localizador,subinventario,pallets,cajas,cantidad_fisica,formato,um,estado,lote_status,calidad,marca,updated_at",
      { count: "exact" }
    );
    if (fSubinv !== "all") q = q.eq("subinventario", fSubinv);
    if (fUm     !== "all") q = q.eq("um", fUm);
    if (fEstado !== "all") q = q.eq("estado", fEstado);
    if (fSearch) q = q.or(`codigo.ilike.%${fSearch}%,descripcion.ilike.%${fSearch}%,lote.ilike.%${fSearch}%,localizador.ilike.%${fSearch}%`);
    const { data, count } = await q
      .order(sortKey, { ascending: sortAsc })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    setRows((data as InvRow[]) || []);
    setTotal(count ?? 0);
    setLoading(false);
  }, [fSubinv, fUm, fEstado, fSearch, sortKey, sortAsc, page]);

  // KPIs — aggregate with current filters
  const loadKpis = useCallback(async () => {
    let q = db.from("inventario").select("pallets,cajas,cantidad_fisica");
    if (fSubinv !== "all") q = q.eq("subinventario", fSubinv);
    if (fUm     !== "all") q = q.eq("um", fUm);
    if (fEstado !== "all") q = q.eq("estado", fEstado);
    if (fSearch) q = q.or(`codigo.ilike.%${fSearch}%,descripcion.ilike.%${fSearch}%,lote.ilike.%${fSearch}%,localizador.ilike.%${fSearch}%`);
    const { data } = await q;
    const agg = (data as { pallets: number; cajas: number; cantidad_fisica: number }[]) || [];
    setKpis({
      registros: agg.length,
      pallets: agg.reduce((s, r) => s + (r.pallets || 0), 0),
      cajas:   agg.reduce((s, r) => s + (r.cajas   || 0), 0),
      m2:      agg.reduce((s, r) => s + (r.cantidad_fisica || 0), 0),
    });
  }, [fSubinv, fUm, fEstado, fSearch]);

  // Load filter options once
  useEffect(() => {
    db.from("inventario").select("subinventario").then(({ data }) => {
      const s = [...new Set((data || []).map((r: { subinventario: string }) => r.subinventario).filter(Boolean))].sort();
      setSubinvs(s);
    });
    db.from("inventario").select("um").then(({ data }) => {
      const s = [...new Set((data || []).map((r: { um: string }) => r.um).filter(Boolean))].sort();
      setUms(s);
    });
    db.from("inventario").select("estado").then(({ data }) => {
      const s = [...new Set((data || []).map((r: { estado: string }) => r.estado).filter(Boolean))].sort();
      setEstados(s);
    });
  }, []);

  useEffect(() => { setPage(0); }, [fSubinv, fUm, fEstado, fSearch]);
  useEffect(() => { load(); loadKpis(); }, [load, loadKpis]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
    setPage(0);
  }

  async function exportAll() {
    setExporting(true);
    let q = db.from("inventario").select("codigo,descripcion,lote,localizador,subinventario,pallets,cajas,cantidad_fisica,formato,um,estado,lote_status,calidad,marca,updated_at");
    if (fSubinv !== "all") q = q.eq("subinventario", fSubinv);
    if (fUm     !== "all") q = q.eq("um", fUm);
    if (fEstado !== "all") q = q.eq("estado", fEstado);
    if (fSearch) q = q.or(`codigo.ilike.%${fSearch}%,descripcion.ilike.%${fSearch}%,lote.ilike.%${fSearch}%,localizador.ilike.%${fSearch}%`);
    const { data } = await q.order(sortKey, { ascending: sortAsc });
    const ws = XLSX.utils.json_to_sheet((data || []) as object[]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Inventario");
    XLSX.writeFile(wb, `inventario_${new Date().toISOString().slice(0, 10)}.xlsx`);
    setExporting(false);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const sel = { fontSize: 12, padding: "5px 8px", border: "1px solid #2e3247", borderRadius: 6, background: "#1a1d27", color: "#e8eaf0", outline: "none" } as const;

  const kpiCards = [
    { label: "Registros",  value: total.toLocaleString(),                              icon: "📋", color: "#3b82f6" },
    { label: "Pallets",    value: kpis.pallets.toLocaleString(),                        icon: "🟦", color: "#8b5cf6" },
    { label: "Cajas",      value: kpis.cajas.toLocaleString(),                          icon: "📦", color: "#f59e0b" },
    { label: "M² físicos", value: kpis.m2 > 0 ? kpis.m2.toLocaleString("es", { maximumFractionDigits: 1 }) : "—", icon: "📐", color: "#10b981" },
  ];

  return (
    <div style={{ background: "#0f1117", minHeight: "100%", color: "#e8eaf0", fontFamily: "'Segoe UI', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ background: "#1a1d27", borderBottom: "1px solid #2e3247", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 34, height: 34, background: "#2563eb", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📦</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Inventario</div>
            <div style={{ fontSize: 11, color: "#8b8fa8" }}>Stock actual · actualizado por el último import</div>
          </div>
        </div>
        <button onClick={exportAll} disabled={exporting || !total}
          style={{ padding: "7px 16px", background: exporting ? "#1a2e1a" : "#166534", border: "none", borderRadius: 7, color: "#fff", fontSize: 12, fontWeight: 600, cursor: total ? "pointer" : "not-allowed", opacity: total ? 1 : 0.5 }}>
          {exporting ? "⏳ Exportando…" : "⬇ Exportar todo"}
        </button>
      </div>

      {/* KPI cards */}
      <div style={{ padding: "12px 20px", display: "flex", gap: 10, flexWrap: "wrap" }}>
        {kpiCards.map(k => (
          <div key={k.label} style={{ flex: "1 1 140px", background: "#1a1d27", border: "1px solid #2e3247", borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 36, height: 36, background: k.color + "22", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{k.icon}</div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: k.color, lineHeight: 1 }}>{k.value}</div>
              <div style={{ fontSize: 11, color: "#8b8fa8", marginTop: 2 }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div style={{ padding: "8px 20px 12px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", borderBottom: "1px solid #2e3247" }}>
        <input value={fSearch} onChange={e => setFSearch(e.target.value)} placeholder="Buscar código / descripción / lote / loc…"
          style={{ ...sel, width: 280 }} />
        <select value={fSubinv} onChange={e => setFSubinv(e.target.value)} style={sel}>
          <option value="all">Todos los subinventarios</option>
          {subinvs.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={fUm} onChange={e => setFUm(e.target.value)} style={sel}>
          <option value="all">Todas las UMs</option>
          {ums.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <select value={fEstado} onChange={e => setFEstado(e.target.value)} style={sel}>
          <option value="all">Todos los estados</option>
          {estados.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
        {(fSubinv !== "all" || fUm !== "all" || fEstado !== "all" || fSearch) && (
          <button onClick={() => { setFSubinv("all"); setFUm("all"); setFEstado("all"); setFSearch(""); }}
            style={{ ...sel, cursor: "pointer", color: "#f87171", borderColor: "#7f1d1d" }}>✕ Limpiar</button>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#5a5e75" }}>
          {rows.length} de {total.toLocaleString()} registros
        </span>
      </div>

      {/* Tabla */}
      <div style={{ padding: "0 20px 20px" }}>
        <div style={{ overflowX: "auto", border: "1px solid #2e3247", borderRadius: 10, marginTop: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: "#1a1d27", borderBottom: "1px solid #2e3247" }}>
                {COLS.map(col => (
                  <th key={col.key} onClick={() => toggleSort(col.key)}
                    style={{ padding: "8px 10px", textAlign: col.align ?? "left", color: sortKey === col.key ? "#93c5fd" : "#8b8fa8", fontWeight: 500, whiteSpace: "nowrap", fontSize: 11, cursor: "pointer", userSelect: "none" }}>
                    {col.label} {sortKey === col.key ? (sortAsc ? "↑" : "↓") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array(10).fill(0).map((_, i) => (
                    <tr key={i}><td colSpan={COLS.length} style={{ padding: "8px 10px" }}>
                      <div style={{ height: 14, background: "#222535", borderRadius: 4, animation: "pulse 1.5s infinite", width: `${60 + (i * 7) % 30}%` }} />
                    </td></tr>
                  ))
                : rows.map((r, i) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid #1e2235", background: i % 2 === 0 ? "transparent" : "#1c1f2d" }}>
                      <td style={{ padding: "6px 10px", fontWeight: 600, color: "#93c5fd", fontFamily: "monospace", whiteSpace: "nowrap" }}>{r.codigo}</td>
                      <td style={{ padding: "6px 10px", color: "#c8cad8", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.descripcion}>{r.descripcion || "—"}</td>
                      <td style={{ padding: "6px 10px", color: "#8b8fa8", whiteSpace: "nowrap" }}>{r.lote || "—"}</td>
                      <td style={{ padding: "6px 10px", fontFamily: "monospace", whiteSpace: "nowrap" }}>{r.localizador}</td>
                      <td style={{ padding: "6px 10px", color: "#8b8fa8" }}>{r.subinventario}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700, color: r.pallets > 0 ? "#4ade80" : "#5a5e75" }}>{r.pallets}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", color: r.cajas > 0 ? "#c8cad8" : "#5a5e75" }}>{r.cajas || "—"}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", color: "#a78bfa" }}>{r.cantidad_fisica ? r.cantidad_fisica.toLocaleString("es", { maximumFractionDigits: 1 }) : "—"}</td>
                      <td style={{ padding: "6px 10px", color: "#8b8fa8" }}>{r.um || "—"}</td>
                      <td style={{ padding: "6px 10px", color: "#8b8fa8" }}>{r.formato && r.formato !== "-" ? r.formato : "—"}</td>
                      <td style={{ padding: "6px 10px" }}>
                        <span style={{
                          fontSize: 10, padding: "2px 7px", borderRadius: 4, fontWeight: 600,
                          background: r.estado === "Active" ? "#14532d" : r.estado?.startsWith("Riesgo") ? "#7c2d12" : "#1e2235",
                          color:      r.estado === "Active" ? "#4ade80" : r.estado?.startsWith("Riesgo") ? "#f97316" : "#8b8fa8",
                        }}>{r.estado || "—"}</span>
                      </td>
                      <td style={{ padding: "6px 10px", color: "#5a5e75", fontSize: 10 }}>{r.lote_status || "—"}</td>
                    </tr>
                  ))
              }
              {!loading && rows.length === 0 && (
                <tr><td colSpan={COLS.length} style={{ padding: 40, textAlign: "center", color: "#5a5e75" }}>Sin resultados para el filtro</td></tr>
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
