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

const PAGE_SIZE = 100;

export default function InventarioPage() {
  const [rows,     setRows]     = useState<InvRow[]>([]);
  const [total,    setTotal]    = useState(0);
  const [loading,  setLoading]  = useState(true);
  const [page,     setPage]     = useState(0);

  const [fSubinv,  setFSubinv]  = useState("all");
  const [fUm,      setFUm]      = useState("all");
  const [fEstado,  setFEstado]  = useState("all");
  const [fSearch,  setFSearch]  = useState("");

  const [subinvs,  setSubinvs]  = useState<string[]>([]);
  const [ums,      setUms]      = useState<string[]>([]);
  const [estados,  setEstados]  = useState<string[]>([]);

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
    q = q.order("subinventario").order("codigo").range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    const { data, count } = await q;
    setRows((data as InvRow[]) || []);
    setTotal(count ?? 0);
    setLoading(false);
  }, [fSubinv, fUm, fEstado, fSearch, page]);

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
  useEffect(() => { load(); }, [load]);

  function exportXlsx() {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Inventario");
    XLSX.writeFile(wb, `inventario_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const sel = { fontSize: 12, padding: "5px 8px", border: "1px solid #2e3247", borderRadius: 6, background: "#1a1d27", color: "#e8eaf0", outline: "none" };

  return (
    <div style={{ background: "#0f1117", minHeight: "100%", color: "#e8eaf0", fontFamily: "'Segoe UI', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ background: "#1a1d27", borderBottom: "1px solid #2e3247", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 34, height: 34, background: "#2563eb", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📦</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Inventario</div>
            <div style={{ fontSize: 11, color: "#8b8fa8" }}>
              {total.toLocaleString()} registros · actualizado por el último import de stock
            </div>
          </div>
        </div>
        <button onClick={exportXlsx} disabled={!rows.length}
          style={{ padding: "7px 16px", background: "#166534", border: "none", borderRadius: 7, color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
          ⬇ Exportar página
        </button>
      </div>

      {/* Filtros */}
      <div style={{ padding: "12px 20px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", borderBottom: "1px solid #2e3247" }}>
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
          Mostrando {rows.length} de {total.toLocaleString()}
        </span>
      </div>

      {/* Tabla */}
      <div style={{ padding: "0 20px 20px" }}>
        <div style={{ overflowX: "auto", border: "1px solid #2e3247", borderRadius: 10, marginTop: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: "#1a1d27", borderBottom: "1px solid #2e3247" }}>
                {["Código","Descripción","Lote","Localizador","Subinventario","Pallets","UM","Formato","Estado","Lote Status"].map(h => (
                  <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: "#8b8fa8", fontWeight: 500, whiteSpace: "nowrap", fontSize: 11 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array(10).fill(0).map((_, i) => (
                    <tr key={i}><td colSpan={10} style={{ padding: "8px 10px" }}>
                      <div style={{ height: 14, background: "#222535", borderRadius: 4, animation: "pulse 1.5s infinite", width: `${60 + Math.random() * 30}%` }} />
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
                <tr><td colSpan={10} style={{ padding: 40, textAlign: "center", color: "#5a5e75" }}>Sin resultados para el filtro</td></tr>
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
