"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/app/actions/auth";

const NAV = [
  { href: "/dashboard",            icon: "⊞", label: "DASHBOARD" },
  { href: "/analisis-bpt",         icon: "⬡", label: "ANÁLISIS BPT" },
  { href: "/subir-archivo",        icon: "📂", label: "SUBIR ARCHIVO" },
  { href: "/ordenes-produccion",   icon: "📋", label: "ÓRDENES" },
  { href: "/operador",             icon: "👷", label: "OPERADOR" },
];

export default function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();

  return (
    <aside style={s.aside}>
      <div style={s.logoBox}>
        <span style={s.logoIcon}>⬡</span>
        <div>
          <div style={s.logoText}>LOGISTICA</div>
          <div style={s.logoBpt}>_BPT</div>
        </div>
      </div>

      <nav style={s.nav}>
        {NAV.map(({ href, icon, label }) => {
          const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
          return (
            <Link key={href} href={href} style={{ textDecoration: "none" }}>
              <div style={{ ...s.item, ...(active ? s.itemActive : {}) }}>
                <span style={s.icon}>{icon}</span>
                <span style={{ ...s.label, color: active ? "#f97316" : "#6b7280" }}>{label}</span>
                {active && <span style={s.dot} />}
              </div>
            </Link>
          );
        })}
      </nav>

      <div style={s.footer}>
        <div style={s.email} title={email}>{email}</div>
        <form action={logout}>
          <button style={s.logoutBtn} type="submit">SALIR →</button>
        </form>
      </div>
    </aside>
  );
}

const s: { [k: string]: React.CSSProperties } = {
  aside: {
    width: 200,
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
  },
  logoBox: {
    padding: "22px 16px 18px",
    borderBottom: "1px solid rgba(249,115,22,0.1)",
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  logoIcon: { fontSize: 22, color: "#f97316" },
  logoText: { fontSize: 12, fontWeight: 700, color: "#fff", letterSpacing: 2 },
  logoBpt: { fontSize: 12, fontWeight: 700, color: "#f97316", letterSpacing: 2 },
  nav: { flex: 1, padding: "12px 8px", display: "flex", flexDirection: "column", gap: 2 },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
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
  icon: { fontSize: 14, width: 18, textAlign: "center" as const },
  label: { fontSize: 10, letterSpacing: 1.5, fontWeight: 600 },
  dot: {
    position: "absolute",
    right: 10,
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: "#f97316",
  },
  footer: {
    padding: "14px 16px",
    borderTop: "1px solid rgba(249,115,22,0.1)",
    display: "flex",
    flexDirection: "column",
    gap: 10,
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
    width: "100%",
    background: "transparent",
    border: "1px solid rgba(249,115,22,0.2)",
    color: "#f97316",
    fontSize: 10,
    letterSpacing: 2,
    padding: "8px",
    cursor: "pointer",
    fontFamily: "'Courier New', monospace",
  },
};
