"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { logout } from "@/app/actions/auth";
import { getBrowserClient } from "@/lib/supabase/browser";

const NAV = [
  { href: "/dashboard",            icon: "⊞", label: "DASHBOARD" },
  { href: "/analisis-bpt",         icon: "⬡", label: "ANÁLISIS BPT" },
  { href: "/ordenes-produccion",   icon: "📋", label: "ÓRDENES" },
  { href: "/operador",             icon: "👷", label: "OPERADOR" },
  { href: "/ubicacion-produccion", icon: "🗺", label: "UBICACIÓN" },
  { href: "/configuracion",        icon: "⚙", label: "CONFIGURACIÓN" },
];

export default function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed]     = useState(false);
  const [mobileOpen, setMobileOpen]   = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    const saved = localStorage.getItem("sidebar_collapsed");
    if (saved === "true") setCollapsed(true);
  }, []);

  // Close drawer on route change
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  // Real-time pending badge
  useEffect(() => {
    const db = getBrowserClient();
    async function fetchCount() {
      const { count } = await db
        .from("lineas_reubicacion")
        .select("id", { count: "exact", head: true })
        .eq("estado", "pendiente");
      setPendingCount(count ?? 0);
    }
    fetchCount();
    const ch = db.channel("sidebar_pending")
      .on("postgres_changes", { event: "*", schema: "public", table: "lineas_reubicacion" }, fetchCount)
      .subscribe();
    return () => { db.removeChannel(ch); };
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
    <>
      {/* ── DESKTOP SIDEBAR ─────────────────────────────────────── */}
      <aside className="sidebar-desktop" style={{ ...s.aside, width: w }}>

        <button onClick={toggle} style={s.toggleBtn} title={collapsed ? "Expandir menú" : "Colapsar menú"}>
          {collapsed ? "▷" : "◁"}
        </button>

        <div style={{ ...s.logoBox, justifyContent: collapsed ? "center" : "flex-start", padding: collapsed ? "14px 0" : "22px 16px 18px" }}>
          <span style={s.logoIcon}>⬡</span>
          {!collapsed && (
            <div>
              <div style={s.logoText}>LOGISTICA</div>
              <div style={s.logoBpt}>_BPT</div>
            </div>
          )}
        </div>

        <nav style={s.nav}>
          {NAV.map(({ href, icon, label }) => {
            const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
            const showBadge = href === "/ordenes-produccion" && pendingCount > 0;
            return (
              <Link key={href} href={href} style={{ textDecoration: "none" }} title={collapsed ? label : undefined}>
                <div style={{
                  ...s.item,
                  ...(active ? s.itemActive : {}),
                  justifyContent: collapsed ? "center" : "flex-start",
                  padding: collapsed ? "10px 0" : "10px 12px",
                }}>
                  <span style={{ ...s.icon, position: "relative" as const }}>
                    {icon}
                    {showBadge && collapsed && (
                      <span style={s.badgeDot} />
                    )}
                  </span>
                  {!collapsed && (
                    <>
                      <span style={{ ...s.label, color: active ? "#f97316" : "#6b7280" }}>{label}</span>
                      {showBadge && (
                        <span style={s.badge}>{pendingCount > 99 ? "99+" : pendingCount}</span>
                      )}
                    </>
                  )}
                  {active && !collapsed && !showBadge && <span style={s.dot} />}
                </div>
              </Link>
            );
          })}
        </nav>

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

      {/* ── MOBILE TOP BAR ─────────────────────────────────────── */}
      <header className="sidebar-mobile-bar" style={m.bar}>
        <button style={m.hamburger} onClick={() => setMobileOpen(true)} aria-label="Abrir menú">
          ☰
        </button>
        <div style={m.logo}>
          <span style={{ color: "#f97316", fontSize: 18 }}>⬡</span>
          <span style={{ color: "#fff", fontSize: 12, fontWeight: 700, letterSpacing: 2, fontFamily: "'Courier New', monospace" }}>LOGISTICA</span>
          <span style={{ color: "#f97316", fontSize: 12, fontWeight: 700, fontFamily: "'Courier New', monospace" }}>_BPT</span>
        </div>
        <span style={m.emailShort} title={email}>{email.split("@")[0]}</span>
      </header>

      {/* ── MOBILE DRAWER ─────────────────────────────────────── */}
      {mobileOpen && (
        <>
          <div style={m.backdrop} onClick={() => setMobileOpen(false)} />
          <aside style={m.drawer}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid rgba(249,115,22,0.1)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 20, color: "#f97316" }}>⬡</span>
                <div>
                  <div style={s.logoText}>LOGISTICA</div>
                  <div style={s.logoBpt}>_BPT</div>
                </div>
              </div>
              <button onClick={() => setMobileOpen(false)} style={m.closeBtn} aria-label="Cerrar menú">✕</button>
            </div>

            <nav style={{ flex: 1, padding: "10px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
              {NAV.map(({ href, icon, label }) => {
                const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
                const showBadge = href === "/ordenes-produccion" && pendingCount > 0;
                return (
                  <Link key={href} href={href} style={{ textDecoration: "none" }} onClick={() => setMobileOpen(false)}>
                    <div style={{
                      ...s.item,
                      ...(active ? s.itemActive : {}),
                      justifyContent: "flex-start",
                      padding: "12px 14px",
                    }}>
                      <span style={{ ...s.icon, fontSize: 15 }}>{icon}</span>
                      <span style={{ ...s.label, color: active ? "#f97316" : "#6b7280" }}>{label}</span>
                      {showBadge && <span style={s.badge}>{pendingCount > 99 ? "99+" : pendingCount}</span>}
                      {active && !showBadge && <span style={s.dot} />}
                    </div>
                  </Link>
                );
              })}
            </nav>

            <div style={{ borderTop: "1px solid rgba(249,115,22,0.1)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ ...s.email, fontSize: 11 }} title={email}>{email}</div>
              <form action={logout}>
                <button style={{ ...s.logoutBtn, width: "100%", padding: "10px", fontSize: 11, letterSpacing: 1.5 }} type="submit">
                  SALIR →
                </button>
              </form>
            </div>
          </aside>
        </>
      )}
    </>
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
  badge: {
    marginLeft: "auto",
    background: "#f97316",
    color: "#000",
    fontSize: 9,
    fontWeight: 800,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 4px",
    flexShrink: 0,
  },
  badgeDot: {
    position: "absolute" as const,
    top: -2,
    right: -3,
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "#f97316",
  },
};

const m: { [k: string]: React.CSSProperties } = {
  bar: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    height: 56,
    background: "#080c14",
    borderBottom: "1px solid rgba(249,115,22,0.15)",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 16px",
    zIndex: 100,
    gap: 12,
  },
  hamburger: {
    background: "transparent",
    border: "1px solid rgba(249,115,22,0.3)",
    color: "#f97316",
    fontSize: 18,
    cursor: "pointer",
    padding: "6px 10px",
    borderRadius: 3,
    lineHeight: 1,
    flexShrink: 0,
  },
  logo: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flex: 1,
    justifyContent: "center",
  },
  emailShort: {
    fontSize: 10,
    color: "#4a5568",
    letterSpacing: 0.5,
    maxWidth: 80,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
    fontFamily: "'Courier New', monospace",
  },
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.65)",
    zIndex: 200,
  },
  drawer: {
    position: "fixed",
    top: 0,
    left: 0,
    bottom: 0,
    width: 260,
    background: "#080c14",
    borderRight: "1px solid rgba(249,115,22,0.15)",
    zIndex: 201,
    display: "flex",
    flexDirection: "column",
    fontFamily: "'Courier New', monospace",
    overflowY: "auto",
    boxShadow: "4px 0 24px rgba(0,0,0,0.6)",
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "rgba(249,115,22,0.5)",
    fontSize: 20,
    cursor: "pointer",
    padding: "4px 8px",
    lineHeight: 1,
  },
};
