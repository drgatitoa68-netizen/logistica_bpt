"use client";

import { useActionState, useState } from "react";
import { login } from "@/app/actions/auth";

export default function LoginPage() {
  const [state, formAction, isPending] = useActionState(login, undefined);
  const [showPass, setShowPass] = useState(false);

  return (
    <div style={styles.root}>
      <div style={styles.gridBg} />

      <svg style={styles.svg} viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice">
        <line x1="0" y1="150" x2="800" y2="150" stroke="#f97316" strokeWidth="0.5" strokeDasharray="12 8" opacity="0.3" />
        <line x1="0" y1="450" x2="800" y2="450" stroke="#f97316" strokeWidth="0.5" strokeDasharray="12 8" opacity="0.3" />
        <line x1="200" y1="0" x2="200" y2="600" stroke="#f97316" strokeWidth="0.5" strokeDasharray="12 8" opacity="0.2" />
        <line x1="600" y1="0" x2="600" y2="600" stroke="#f97316" strokeWidth="0.5" strokeDasharray="12 8" opacity="0.2" />
        <circle cx="200" cy="150" r="5" fill="#f97316" opacity="0.5" />
        <circle cx="600" cy="150" r="5" fill="#f97316" opacity="0.5" />
        <circle cx="200" cy="450" r="5" fill="#f97316" opacity="0.5" />
        <circle cx="600" cy="450" r="5" fill="#f97316" opacity="0.5" />
        <path d="M200 150 Q400 300 600 450" stroke="#f97316" strokeWidth="1" fill="none" opacity="0.25" />
        <path d="M600 150 Q400 300 200 450" stroke="#f97316" strokeWidth="1" fill="none" opacity="0.25" />
      </svg>

      <div style={styles.card} className="login-card">
        <div style={styles.leftPanel} className="login-left-panel">
          <div style={styles.badge}>SISTEMA DE GESTIÓN</div>
          <div style={styles.logo}>
            <span style={styles.logoIcon}>⬡</span>
            <span style={styles.logoText}>LOGISTICA</span>
            <span style={styles.logoBpt}>_BPT</span>
          </div>
          <p style={styles.tagline}>
            Control total de tu cadena<br />de suministro en tiempo real.
          </p>
          <div style={styles.stats}>
            <div style={styles.stat}>
              <span style={styles.statNum}>99.8%</span>
              <span style={styles.statLabel}>Uptime</span>
            </div>
            <div style={styles.statDivider} />
            <div style={styles.stat}>
              <span style={styles.statNum}>24/7</span>
              <span style={styles.statLabel}>Soporte</span>
            </div>
            <div style={styles.statDivider} />
            <div style={styles.stat}>
              <span style={styles.statNum}>ISO</span>
              <span style={styles.statLabel}>Certificado</span>
            </div>
          </div>
        </div>

        <div style={styles.rightPanel} className="login-right-panel">
          <h2 style={styles.formTitle}>Iniciar Sesión</h2>
          <p style={styles.formSub}>Ingresa tus credenciales de acceso</p>

          <form action={formAction} style={styles.form}>
            <div style={styles.field}>
              <label htmlFor="email" style={styles.label}>CORREO ELECTRÓNICO</label>
              <div style={styles.inputWrap}>
                <span style={styles.inputIcon}>✉</span>
                <input
                  id="email"
                  name="email"
                  style={styles.input}
                  type="email"
                  placeholder="usuario@empresa.com"
                  autoComplete="email"
                  required
                />
              </div>
            </div>

            <div style={styles.field}>
              <label htmlFor="password" style={styles.label}>CONTRASEÑA</label>
              <div style={styles.inputWrap}>
                <span style={styles.inputIcon}>🔒</span>
                <input
                  id="password"
                  name="password"
                  style={styles.input}
                  type={showPass ? "text" : "password"}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
                <button style={styles.toggleBtn} onClick={() => setShowPass(!showPass)} type="button">
                  {showPass ? "Ocultar" : "Ver"}
                </button>
              </div>
            </div>

            {state?.error && (
              <div style={styles.errorBox}>⚠ {state.error}</div>
            )}

            <button
              style={{ ...styles.submitBtn, opacity: isPending ? 0.7 : 1 }}
              type="submit"
              disabled={isPending}
            >
              {isPending ? "Verificando..." : "ACCEDER AL SISTEMA →"}
            </button>
          </form>

          <p style={styles.footer}>© 2026 Logistica BPT · Todos los derechos reservados</p>
        </div>
      </div>
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  root: { minHeight: "100vh", background: "#0a0e17", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Courier New', monospace", position: "relative", overflow: "hidden", padding: "20px" },
  gridBg: { position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(249,115,22,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(249,115,22,0.05) 1px, transparent 1px)", backgroundSize: "40px 40px" },
  svg: { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" },
  card: { display: "flex", borderRadius: "4px", overflow: "hidden", width: "100%", maxWidth: "860px", position: "relative", zIndex: 1, boxShadow: "0 0 0 1px rgba(249,115,22,0.2), 0 40px 80px rgba(0,0,0,0.6)" },
  leftPanel: { background: "linear-gradient(160deg, #1a1000 0%, #0f1520 100%)", borderRight: "1px solid rgba(249,115,22,0.25)", padding: "48px 36px", width: "340px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "24px" },
  badge: { display: "inline-block", fontSize: "10px", letterSpacing: "3px", color: "#f97316", border: "1px solid rgba(249,115,22,0.4)", padding: "4px 10px", width: "fit-content" },
  logo: { display: "flex", alignItems: "center", gap: "8px", marginTop: "8px" },
  logoIcon: { fontSize: "28px", color: "#f97316" },
  logoText: { fontSize: "22px", fontWeight: "700", color: "#ffffff", letterSpacing: "3px" },
  logoBpt: { fontSize: "22px", fontWeight: "700", color: "#f97316", letterSpacing: "2px" },
  tagline: { fontSize: "14px", color: "#7a8499", lineHeight: "1.7", margin: 0 },
  stats: { display: "flex", alignItems: "center", gap: "20px", marginTop: "auto", paddingTop: "32px", borderTop: "1px solid rgba(249,115,22,0.15)" },
  stat: { display: "flex", flexDirection: "column", gap: "4px" },
  statNum: { fontSize: "16px", fontWeight: "700", color: "#f97316", letterSpacing: "1px" },
  statLabel: { fontSize: "10px", color: "#4a5568", letterSpacing: "1px", textTransform: "uppercase" as const },
  statDivider: { width: "1px", height: "30px", background: "rgba(249,115,22,0.2)" },
  rightPanel: { background: "#0d1117", padding: "48px 40px", flex: 1, display: "flex", flexDirection: "column", gap: "20px" },
  formTitle: { margin: 0, fontSize: "24px", fontWeight: "700", color: "#ffffff", letterSpacing: "1px" },
  formSub: { margin: 0, fontSize: "13px", color: "#4a5568", letterSpacing: "0.5px" },
  form: { display: "flex", flexDirection: "column", gap: "20px" },
  field: { display: "flex", flexDirection: "column", gap: "8px" },
  label: { fontSize: "10px", letterSpacing: "2px", color: "#f97316" },
  inputWrap: { display: "flex", alignItems: "center", background: "#0a0e17", border: "1px solid rgba(249,115,22,0.2)", borderRadius: "2px", padding: "0 14px", gap: "10px" },
  inputIcon: { fontSize: "14px", opacity: 0.5 },
  input: { flex: 1, background: "transparent", border: "none", outline: "none", color: "#e2e8f0", fontSize: "14px", padding: "14px 0", fontFamily: "'Courier New', monospace", letterSpacing: "0.5px" },
  toggleBtn: { background: "none", border: "none", color: "#f97316", fontSize: "11px", cursor: "pointer", letterSpacing: "1px", padding: "0", fontFamily: "'Courier New', monospace" },
  errorBox: { background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#f87171", fontSize: "12px", padding: "10px 14px", borderRadius: "2px", letterSpacing: "0.5px" },
  submitBtn: { background: "#f97316", border: "none", color: "#000000", fontSize: "12px", fontWeight: "700", letterSpacing: "2px", padding: "16px", cursor: "pointer", borderRadius: "2px", fontFamily: "'Courier New', monospace", transition: "all 0.2s" },
  footer: { fontSize: "10px", color: "#2d3748", letterSpacing: "1px", marginTop: "auto", textAlign: "center" as const },
};
