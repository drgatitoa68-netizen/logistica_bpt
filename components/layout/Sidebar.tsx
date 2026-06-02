"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { logout } from "@/app/actions/auth";

const NAV = [
  { href: "/dashboard",           icon: "⊞", label: "DASHBOARD" },
  { href: "/analisis-bpt",        icon: "⬡", label: "ANÁLISIS BPT" },
  { href: "/operador",            icon: "👷", label: "OPERADOR" },
  { href: "/ubicacion-produccion",icon: "🗺", label: "UBICACIÓN" },
  { href: "/configuracion",       icon: "⚙", label: "CONFIGURACIÓN" },
];

export default function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("sidebar_collapsed");
    if (saved === "true") setCollapsed(true);
  }, []);

  function toggle() {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem("sidebar_collapsed", String(next));
      return next;
    });
  }

  const w = collapsed ? 52 : 200;

  return (
    <aside style={{ ...s.aside, width: w }}>

      {/* Toggle button */}
      <button onClick={toggle} style={s.toggleBtn} title={collapsed ? "Expandir menú" : "Colapsar menú"}>
        {collapsed ? "▷" : "◁"}
      </button>

      {/* Logo */}
      <div style={{ ...s.logoBox, justifyContent: collapsed ? "center" : "flex-start", padding: collapsed ? "14px 0" : "22px 16px 18px" }}>
        <span style={s.logoIcon}>⬡</span>
        {!collapsed && (
          <div>
            <div style={s.logoText}>LOGISTICA</div>
            <div style={s.logoBpt}>_BPT</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav style={s.nav}>
        {NAV.map(({ href, icon, label }) => {
          const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
          return (
            <Link key={href} href={href} style={{ textDecoration: "none" }} title={collapsed ? label : undefined}>
              <div style={{
                ...s.item,
                ...(active ? s.itemActive : {}),
                justifyContent: collapsed ? "center" : "flex-start",
                padding: collapsed ? "10px 0" : "10px 12px",
              }}>
                <span style={s.icon}>{icon}</span>
                {!collapsed && (
                  <span style={{ ...s.label, color: active ? "#f97316" : "#6b7280" }}>{label}</span>
                )}
                {active && !collapsed && <span style={s.dot} />}
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div style={{ ...s.footer, padding: collapsed ? "10px 0" : "14px 16px", alignItems: collapsed ? "center" : "stretch" }}>
        {!collapsed && <div style={s.email} title={email}>{email}</div>}
        <form action={logout}>
          <button
            style={{ ...s.logoutBtn, width: collapsed ? 36 : "100%", padding: collapsed ? "6px 0" : "8px", fontSize: collapsed ? 14 : 10, letterSpacing: collapsed ? 0 : 2 }}
            type="submit"
            title={collapsed ? "Salir" : undefined}
          >
            {collapsed ? "→" : "SALIR →"}
          </button>
        </form>
      </div>
    </aside>
  );
}

const s: { [k: string]: React.CSSProperties } = {
  aside: {
    minHeight: "100vh",
    height: "100vh",
    background: "#080c14",
    borderRight: "1px solid rgba(249,115,22,0.15)",
    display: "flex",
    flexDirection: "column",
    fontFamily: "'Courier New', monospace",
    flexShrink: 0,
    position: "sticky",
    top: 0,
    transition: "width 0.2s ease",
    overflow: "hidden",
  },
  toggleBtn: {
    position: "absolute",
    top: 8,
    right: 6,
    background: "transparent",
    border: "none",
    color: "rgba(249,115,22,0.5)",
    fontSize: 11,
    cursor: "pointer",
    padding: "2px 5px",
    zIndex: 10,
    fontFamily: "'Courier New', monospace",
    lineHeight: 1,
  },
  logoBox: {
    borderBottom: "1px solid rgba(249,115,22,0.1)",
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  logoIcon: { fontSize: 22, color: "#f97316", flexShrink: 0 },
  logoText: { fontSize: 12, fontWeight: 700, color: "#fff", letterSpacing: 2, whiteSpace: "nowrap" as const },
  logoBpt:  { fontSize: 12, fontWeight: 700, color: "#f97316", letterSpacing: 2 },
  nav: { flex: 1, padding: "12px 4px", display: "flex", flexDirection: "column", gap: 2 },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    borderRadius: 3,
    cursor: "pointer",
    position: "relative",
    transition: "background 0.15s",
    borderLeft: "2px solid transparent",
  },
  itemActive: {
    background: "rgba(249,115,22,0.08)",
    borderLeft: "2px solid #f97316",
  },
  icon:  { fontSize: 14, width: 18, textAlign: "center" as const, flexShrink: 0 },
  label: { fontSize: 10, letterSpacing: 1.5, fontWeight: 600, whiteSpace: "nowrap" as const },
  dot: {
    position: "absolute",
    right: 10,
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: "#f97316",
  },
  footer: {
    borderTop: "1px solid rgba(249,115,22,0.1)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  email: {
    fontSize: 10,
    color: "#4a5568",
    letterSpacing: 0.5,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  logoutBtn: {
    background: "transparent",
    border: "1px solid rgba(249,115,22,0.2)",
    color: "#f97316",
    cursor: "pointer",
    fontFamily: "'Courier New', monospace",
    textAlign: "center" as const,
  },
};
