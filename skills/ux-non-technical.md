---
name: ux-non-technical
description: >
  Principios de UX/UI para la plataforma de trading multi-usuario dirigida a personas no técnicas.
  Usar este skill siempre que se diseñen o generen: páginas, componentes, formularios, modales,
  mensajes de error, flujos de onboarding, dashboards, pantallas de configuración, o cualquier
  interfaz que los usuarios van a ver y usar. También aplicar cuando se revise la usabilidad de
  componentes existentes, se escriban textos de interfaz (microcopy), o se diseñen flujos de
  varios pasos como la vinculación OAuth de cTrader. Los usuarios NO son desarrolladores — cada
  decisión de UI debe priorizar claridad sobre potencia. Si hay dudas sobre si aplicar el skill,
  aplicarlo.
---

# UX para usuarios no técnicos — Plataforma de trading

## 1. Principio central

Los usuarios son traders, no desarrolladores. No saben qué es OAuth, WebSocket, JSON o un
token. Cada pantalla debe responder una sola pregunta: **¿qué hago ahora?**

---

## 2. Lenguaje de interfaz (microcopy)

### Traducir conceptos técnicos a lenguaje humano
```
❌ "OAuth2 authorization code expired"
✅ "La autorización expiró. Haz clic en 'Conectar' para intentar de nuevo."

❌ "WebSocket disconnected — reconnecting..."
✅ "Conexión con el broker perdida. Reconectando..."

❌ "Error 429: Rate limit exceeded"
✅ "Demasiadas operaciones hoy. El sistema se pausará hasta mañana."

❌ "Invalid payload: sl_pips required"
✅ "Tu alerta no incluye stop loss. Configura uno en TradingView."

❌ "CTRADER_ACCESS_TOKEN expired"
✅ "Tu conexión con cTrader expiró. Reconéctala desde Configuración."
```

### Reglas de microcopy
- Hablar en segunda persona ("Tu cuenta", no "La cuenta del usuario")
- Verbos de acción claros ("Conectar", "Pausar", "Guardar")
- Sin jerga técnica en mensajes visibles al usuario
- Los errores deben incluir qué hacer, no solo qué pasó
- Usar español neutro (sin regionalismos fuertes)

---

## 3. Estados visuales claros

### Cada conexión/servicio tiene exactamente 3 estados visibles

**Conectado (verde)**
- Indicador: círculo verde + texto "Conectado"
- Significado: todo funciona, las alertas se ejecutarán

**Desconectado (gris)**
- Indicador: círculo gris + texto "No configurado" o "Desconectado"
- Significado: falta configurar o se perdió la conexión
- Acción visible: botón "Conectar" o "Reconectar"

**Error (rojo/amarillo)**
- Indicador: círculo rojo + texto descriptivo del problema
- Significado: algo falló que requiere atención
- Acción visible: botón con la solución ("Renovar token", "Revisar configuración")

### Ejemplo de componente de estado
```tsx
function ConnectionStatus({ status }: { status: 'connected' | 'disconnected' | 'error' }) {
  const config = {
    connected:    { color: 'bg-green-500', text: 'Conectado', icon: 'check-circle' },
    disconnected: { color: 'bg-gray-400',  text: 'No configurado', icon: 'circle' },
    error:        { color: 'bg-red-500',   text: 'Requiere atención', icon: 'alert-circle' },
  }
  // ...
}
```

---

## 4. Flujos de varios pasos — Wizard pattern

### Para procesos complejos, usar un asistente paso a paso

El flujo de vincular cTrader (OAuth) NO debe ser:
```
❌ "Pega tu Client ID, Client Secret, Access Token y Account ID aquí"
```

Debe ser un wizard de 3 pasos:
```
✅ Paso 1: "Haz clic en 'Conectar con cTrader'" (el botón abre la ventana de autorización)
   Paso 2: "Autoriza la aplicación en la ventana que se abrió" (con captura de pantalla guía)
   Paso 3: "¡Listo! Tu cuenta está conectada" (confirmación con el nombre de la cuenta)
```

### Reglas para wizards
- Máximo 3-4 pasos visibles
- Mostrar progreso (paso 1 de 3)
- Permitir volver al paso anterior
- No pedir información que el sistema puede obtener solo
- Cada paso tiene UNA acción principal (un botón, no un formulario largo)

---

## 5. Configuración — Valores por defecto sensatos

### No obligar al usuario a configurar todo desde cero
```typescript
// ❌ MAL — formulario vacío que el usuario debe llenar
maxLots: '' // campo vacío obligatorio

// ✅ BIEN — valor por defecto seguro que el usuario puede ajustar
maxLots: 0.01 // conservador por defecto
defaultSlPips: 20 // protección por defecto
killSwitch: false // activo por defecto
```

### Cada campo de configuración necesita
- Label descriptivo sin jerga
- Valor por defecto sensato
- Tooltip o texto de ayuda breve explicando qué hace
- Validación inmediata (no esperar al submit)
- Unidades claras ("lotes", "pips", "USD")

### Ejemplo de campo con ayuda
```tsx
<FormField
  label="Tamaño máximo por operación"
  help="El máximo de lotes que una alerta puede operar. Empieza con 0.01 y ajusta según tu estrategia."
  suffix="lotes"
  min={0.01}
  max={10}
  step={0.01}
  defaultValue={0.01}
/>
```

---

## 6. Confirmaciones antes de acciones peligrosas

### Acciones que REQUIEREN confirmación modal
- Cambiar a cuenta real (salir de demo)
- Aumentar lotes máximos por encima de un umbral
- Desactivar el stop loss por defecto
- Desconectar la cuenta del broker
- Eliminar configuración

### Formato del modal de confirmación
```
Título: "¿Estás seguro?"
Descripción: Explicación clara de la consecuencia
Botón cancelar: "No, mantener como está" (prominente)
Botón confirmar: "Sí, [acción]" (menos prominente, color de advertencia)
```

### Acciones que NO necesitan confirmación
- Guardar configuración (feedback inmediato: "Guardado ✓")
- Activar kill switch (acción de emergencia, debe ser rápida)
- Cambiar filtros o vistas del dashboard

---

## 7. Dashboard / Monitor de operaciones

### Información mínima visible de un vistazo
- Estado de conexión (conectado/desconectado)
- Última operación ejecutada (hace cuánto)
- Posiciones abiertas (símbolo, dirección, P&L)
- Kill switch (toggle prominente siempre visible)

### Feed de operaciones
- Ordenado por más reciente primero
- Iconos claros: flecha verde arriba (buy), flecha roja abajo (sell), X gris (close)
- Timestamp relativo ("hace 5 min") con tooltip de hora exacta
- Estado: ejecutada ✓, fallida ✗, reintentando ↻
- Filtros simples: por símbolo y por fecha

### Errores en el feed
- Fondo amarillo/rojo suave para operaciones fallidas
- Mensaje de error en lenguaje humano (ver sección 2)
- Botón "Reintentar" solo si la acción es retriable

---

## 8. Responsive y accesibilidad

### La plataforma debe funcionar en móvil
- Los traders revisan operaciones desde el teléfono
- El kill switch debe ser accesible en una mano
- Las tablas se convierten en cards en pantalla pequeña

### Accesibilidad mínima
- Contraste suficiente (WCAG AA)
- Labels en todos los inputs
- Navegación por teclado funcional
- Estados de focus visibles

---

## 9. Onboarding de primer uso

### Cuando un usuario nuevo entra por primera vez
1. Pantalla de bienvenida con 3 pasos visuales de lo que va a configurar
2. Conectar cTrader (wizard de la sección 4)
3. Configurar símbolos y lotes (con defaults sensatos)
4. Copiar webhook URL para TradingView (con botón "Copiar" y guía visual)
5. Dashboard limpio con un mensaje "Esperando tu primera alerta..."

### Nunca dejar al usuario en una pantalla vacía sin contexto
```
❌ Dashboard vacío sin explicación
✅ "Aún no tienes operaciones. Configura una alerta en TradingView para empezar."
   [Botón: Ver instrucciones]
```
