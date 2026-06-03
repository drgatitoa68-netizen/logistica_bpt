"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

const TABLE = "lineas_reubicacion";

function revalidate() {
  revalidatePath("/ordenes-produccion");
  revalidatePath("/operador");
}

export async function aprobarLineaDirecta(id: string, responsable?: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "No autenticado" };

  const update: Record<string, unknown> = {
    estado: "aprobada",
    supervisor_email: user.email,
    updated_at: new Date().toISOString(),
  };
  if (responsable) update.responsable = responsable;

  const { error } = await supabase.from(TABLE).update(update).eq("id", id);
  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}

export async function actualizarResponsable(id: string, responsable: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "No autenticado" };

  const { error } = await supabase.from(TABLE).update({
    responsable,
    updated_at: new Date().toISOString(),
  }).eq("id", id);

  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}

export async function aprobarLinea(id: string, notas: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "No autenticado" };

  const { error } = await supabase.from(TABLE).update({
    estado: "aprobada",
    supervisor_email: user.email,
    notas_supervisor: notas,
    updated_at: new Date().toISOString(),
  }).eq("id", id);

  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}

export async function rechazarLinea(id: string, notas: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "No autenticado" };

  const { error } = await supabase.from(TABLE).update({
    estado: "rechazada",
    supervisor_email: user.email,
    notas_supervisor: notas,
    updated_at: new Date().toISOString(),
  }).eq("id", id);

  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}

export async function iniciarLinea(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "No autenticado" };

  const { error } = await supabase.from(TABLE).update({
    estado: "en_proceso",
    operador_email: user.email,
    inicio_operador: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", id);

  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}

export async function finalizarLinea(id: string, inicioIso: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "No autenticado" };

  const fin = new Date();
  const inicio = new Date(inicioIso);
  const duracion = Math.round(((fin.getTime() - inicio.getTime()) / 60000) * 100) / 100;

  const { error } = await supabase.from(TABLE).update({
    estado: "completada",
    fin_operador: fin.toISOString(),
    duracion_minutos: duracion,
    updated_at: fin.toISOString(),
  }).eq("id", id);

  if (error) return { error: error.message };
  revalidate();
  return { ok: true, duracion };
}

export async function fraccionarLinea(
  id: string,
  f1: { pallets: number; cajas: number; cantidad_fisica: number; metraje: number; localizador_destino: string; subinventario_destino: string },
  f2: { pallets: number; cajas: number; cantidad_fisica: number; metraje: number; localizador_destino: string; subinventario_destino: string }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "No autenticado" };

  const { data: original, error: fetchErr } = await supabase.from(TABLE).select("*").eq("id", id).single();
  if (fetchErr || !original) return { error: "Línea no encontrada" };

  const now = new Date().toISOString();
  const base = {
    numero_orden: original.numero_orden,
    cod_org_inv: original.cod_org_inv,
    codigo: original.codigo,
    descripcion: original.descripcion,
    subinventario_origen: original.subinventario_origen,
    localizador_origen: original.localizador_origen,
    lote: original.lote,
    responsable: original.responsable,
    inv_pe: original.inv_pe,
    estado: "aprobada",
    supervisor_email: user.email,
    notas_supervisor: `Fracción de línea original`,
    linea_padre_id: id,
    es_fraccion: true,
    created_at: now,
    updated_at: now,
  };

  const { error: insErr } = await supabase.from(TABLE).insert([
    { ...base, ...f1 },
    { ...base, ...f2 },
  ]);
  if (insErr) return { error: insErr.message };

  // Marca la línea original como fraccionada/rechazada
  const { error: updErr } = await supabase.from(TABLE).update({
    estado: "rechazada",
    notas_supervisor: `Fraccionada en 2 líneas por ${user.email}`,
    updated_at: now,
  }).eq("id", id);
  if (updErr) return { error: updErr.message };

  revalidate();
  return { ok: true };
}

type LineaInput = {
  numero_orden?: string;
  cod_org_inv?: string;
  codigo?: string;
  descripcion: string;
  subinventario_origen?: string;
  localizador_origen?: string;
  lote?: string;
  cantidad_fisica?: number;
  pallets: number;
  cajas?: number;
  subinventario_destino?: string;
  localizador_destino?: string;
  responsable?: string;
  inv_pe?: number;
  notas?: string;
};

export async function crearLinea(data: LineaInput) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "No autenticado" };

  const { error } = await supabase.from(TABLE).insert({
    ...data,
    estado: "pendiente",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}

export async function crearLineas(lines: LineaInput[]) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "No autenticado" };

  const now = new Date().toISOString();
  const { error } = await supabase.from(TABLE).insert(
    lines.map(data => ({ ...data, estado: "pendiente", created_at: now, updated_at: now }))
  );

  if (error) return { error: error.message };
  revalidate();
  return { ok: true };
}
