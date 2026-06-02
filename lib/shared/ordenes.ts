// Shared types and constants for ordenes/reubicacion — single source of truth

export type EstadoLinea =
  | "pendiente"
  | "aprobada"
  | "rechazada"
  | "en_proceso"
  | "completada";

export interface Linea {
  id: string;
  numero_orden?: string;
  cod_org_inv?: string;
  codigo?: string;
  descripcion: string;
  subinventario_origen?: string;
  localizador_origen?: string;
  lote?: string;
  cantidad_fisica: number;
  pallets: number;
  cajas: number;
  subinventario_destino?: string;
  localizador_destino?: string;
  responsable?: string;
  inv_pe?: number;
  conteo?: number;
  estado: EstadoLinea;
  supervisor_email?: string;
  notas_supervisor?: string;
  operador_email?: string;
  inicio_operador?: string;
  fin_operador?: string;
  duracion_minutos?: number;
  es_fraccion?: boolean;
  linea_padre_id?: string;
  notas?: string;
  updated_at: string;
  created_at: string;
}

export const ESTADO_COLOR: Record<
  EstadoLinea,
  { bg: string; color: string; label: string }
> = {
  pendiente:  { bg: "#292010", color: "#fbbf24", label: "PENDIENTE" },
  aprobada:   { bg: "#0f2a0f", color: "#4ade80", label: "APROBADA" },
  rechazada:  { bg: "#2a0f0f", color: "#f87171", label: "RECHAZADA" },
  en_proceso: { bg: "#0f1a2a", color: "#60a5fa", label: "EN PROCESO" },
  completada: { bg: "#1a0f2a", color: "#a78bfa", label: "COMPLETADA" },
};

/** Each operator trip carries 2 pallets */
export const viajesPorLinea = (pallets: number) => Math.ceil(pallets / 2);
