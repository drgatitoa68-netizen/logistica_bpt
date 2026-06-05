# 📋 Setup de Inventario en Supabase

El módulo de **Inventario** requiere que ejecutes las migraciones SQL para crear la tabla y los datos de ejemplo.

## ⚡ Pasos Rápidos

### 1️⃣ Ejecutar Migraciones

Ve a **Supabase Dashboard → SQL Editor** y ejecuta:

```sql
-- Opción A: Si ejecutas por primera vez (incluye creación de tablas base)
-- Ejecuta primero: sql/schema.sql
-- Luego: sql/migrations/002_inventario.sql

-- Opción B: Solo actualizar inventario (si ya tienes schema.sql ejecutado)
-- Ejecuta solo: sql/migrations/002_inventario.sql
```

### 2️⃣ Copiar y Ejecutar el Contenido

📁 **Ruta**: `/sql/migrations/002_inventario.sql`

1. Abre el archivo en tu editor
2. Copia TODO el contenido
3. Ve a Supabase → SQL Editor → New Query
4. Pega el contenido
5. Haz clic en **▶ Execute** (arriba a la derecha)

### 3️⃣ Verificar que Funcionó

Luego de ejecutar, verifica en Supabase Dashboard:

- **Tables**: Deberías ver `inventario` con ~50 registros de ejemplo
- **Localizadores**: Debería tener datos de zonas y ubicaciones

## 🎯 Qué Hace la Migración

✅ **Crea tabla `inventario`** con campos:
- `codigo`: Código del producto (ej: PRD-0001)
- `descripcion`: Descripción del producto
- `lote`: Número de lote
- `localizador`: Ubicación en almacén
- `subinventario`: Tipo (ALMACEN, PRODUCCION, DESPACHO)
- `pallets`: Cantidad de pallets
- `cajas`: Cantidad de cajas
- `formato`: Formato de la pallet (45x45, 30x60, 29x59, MEZCLA)
- `um`: Unidad de medida
- `estado`: Estado del producto (ACTIVO, BLOQUEADO, OBSOLETO, DEFECTUOSO)
- `lote_status`: Estado del lote (OK, RETENIDO, CUARENTENA, INSPECCIONAR)
- `calidad`: Calidad (BUENA, DEFECTUOSA)
- `marca`: Marca del producto

✅ **Genera 50 registros de ejemplo** basados en tus localizadores existentes

✅ **Crear índices** para búsquedas rápidas:
- Por código + lote
- Por localizador
- Por subinventario
- Por estado

✅ **Actualiza RLS policies** para acceso anon

## 🔧 Solucionar Problemas

### ❌ "Table does not exist: inventario"
→ Ejecuta `/sql/migrations/002_inventario.sql` en SQL Editor

### ❌ "No data showing"
→ Verifica que la tabla se creó:
```sql
SELECT COUNT(*) FROM inventario;
```

### ❌ "Column X does not exist"
→ Recrea la tabla ejecutando:
```sql
DROP TABLE IF EXISTS inventario CASCADE;
-- Luego ejecuta /sql/migrations/002_inventario.sql
```

## 📊 Dashboard Esperado

Una vez configurado, en **Inventario** deberías ver:

- **KPIs**: Total de pallets, cajas, registros, m²
- **Filtros**: Por subinventario, UM, estado
- **Búsqueda**: Por código, descripción, lote, localizador
- **Tabla**: Todos los productos con todos los detalles
- **Exportar**: Descarga en Excel

---

**¿Necesitas ayuda?** Revisa la console del navegador (F12) para ver errores de conexión.
