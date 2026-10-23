// ═══════════════════════════════════════════════════════════════════
// ALMACÉN MEDIESE - FRONTEND v3.3
// v3.3: menú y pantallas con la misma forma que Mantenimiento Mediese
// v3.2: escáner QR, búsqueda inteligente, conteo de inventario, etiquetas
// v3.1: PEPS automático, PU calculado por el servidor, alertas, stock con valor
// Login en servidor con token (igual que Mantenimiento Mediese)
// Registro + Dashboard + Stock + Lotes + PEPS + Edición + Usuarios
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbyXlL6k2nKTvquNm1G25r35RXH2LO1raFMxRqAQ5JlazN0oodWtVY_rEpYMuGc0rifpmw/exec",
  SESSION_KEY: "almacen_mediese_session",
  ITERACIONES: 100000
};

const App = (() => {

  let usuarioActual = null;
  let tipoMovimientoActual = null;
  let insumoSeleccionado = null;
  let catalogoCache = null;
  let dcsCache = null;
  let stockCache = [];
  let loteSeleccionadoAbrir = null;
  let lotesCache = [];
  let loteSeleccionadoCerrar = null;
  let lotesTodosCache = [];
  let movimientosEditarCache = [];
  let movimientoEnEdicion = null;
  let loteActivoEnVista = null;
  let usuariosCache = [];
  let stockValorTotal = 0;

  const ROLES_SUPERVISOR = ["supervisor", "gerencia", "admin"];
  // Solo para mostrar u ocultar botones. Quien decide de verdad es el servidor.
  const TIPOS_POR_ROL = {
    almacenista: ["ENTRADA", "SALIDA", "DEVOLUCION"],
    supervisor: ["ENTRADA", "SALIDA", "DEVOLUCION"],
    gerencia: ["ENTRADA", "SALIDA", "DEVOLUCION"],
    admin: ["ENTRADA", "SALIDA", "DEVOLUCION"],
  };
  const NOMBRE_ROL = {
    almacenista: "Almacenista", supervisor: "Supervisor", gerencia: "Gerencia", admin: "Admin",
  };

  // ═══════════════════════════════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════════════════════════════

  const $ = id => document.getElementById(id);

  function getSession() {
    try { const s = localStorage.getItem(CONFIG.SESSION_KEY); return s ? JSON.parse(s) : null; }
    catch (e) { return null; }
  }
  function setSession(d) { localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(d)); }
  function clearSession() { localStorage.removeItem(CONFIG.SESSION_KEY); }

  // Escapa texto antes de meterlo en innerHTML (evita que una nota con código se ejecute)
  function esc(t) {
    return String(t === null || t === undefined ? "" : t)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Pone el cursor en un campo solo si el usuario no está ya escribiendo en otro
  function enfocarSiLibre(id) {
    setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body || a.tagName === "BUTTON") { const el = $(id); if (el) el.focus(); }
    }, 100);
  }

  function esSupervisor() { return usuarioActual && ROLES_SUPERVISOR.includes(usuarioActual.rol); }

  function msg(el, texto, tipo) {
    if (!el) return;
    el.textContent = texto || "";
    el.className = "send-status" + (tipo ? " " + tipo : "");
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString("es-MX", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  async function pbkdf2Hash(password, saltHex) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
    const saltBytes = new Uint8Array(saltHex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: saltBytes, iterations: CONFIG.ITERACIONES, hash: "SHA-256" },
      keyMaterial, 256
    );
    return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function nuevoSalt() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function prepararPassword(p1, p2) {
    if (!p1 || p1.length < 8) return { error: "La contraseña debe tener al menos 8 caracteres" };
    if (p1 !== p2) return { error: "Las contraseñas no coinciden" };
    const salt = nuevoSalt();
    return { salt: salt, hash: await pbkdf2Hash(p1, salt) };
  }

  function sesionExpirada() {
    clearSession();
    alert("Tu sesión expiró. Vuelve a entrar.");
    window.location.href = "index.html";
  }

  // Todas las llamadas llevan el token de sesión; el servidor decide usuario y rol
  async function api(accion, data, metodo) {
    metodo = metodo || "GET";
    const ses = getSession();
    const token = ses && ses.token ? ses.token : "";
    try {
      let r;
      if (metodo === "GET") {
        const limpio = {};
        Object.entries(data || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") limpio[k] = v; });
        const qs = new URLSearchParams({ accion: accion, token: token, ...limpio }).toString();
        r = await fetch(CONFIG.APPS_SCRIPT_URL + "?" + qs, { cache: "no-store", redirect: "follow" });
      } else {
        r = await fetch(CONFIG.APPS_SCRIPT_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ accion: accion, data: data || {}, token: token }),
          redirect: "follow"
        });
      }
      const json = await r.json();
      if (json && json.error === "SESION_EXPIRADA" && accion !== "login") sesionExpirada();
      return json;
    } catch (e) {
      console.error("Error API:", e);
      return { ok: false, error: "Sin conexión con el servidor (" + e.message + ")" };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LOGIN
  // El servidor da el salt, el navegador calcula el hash y el servidor lo compara.
  // ═══════════════════════════════════════════════════════════════

  async function verificarUsuario(usuario, password) {
    const user = String(usuario || "").toLowerCase().trim();
    if (!user || !password) return { error: "Escribe usuario y contraseña" };
    const s = await api("obtener_salt", { usuario: user });
    if (!s.ok || !s.salt) return { error: s.error || "No se pudo conectar con el servidor" };
    const hash = await pbkdf2Hash(password, s.salt);
    const r = await api("login", { usuario: user, hash: hash }, "POST");
    if (!r.ok) return { error: r.error || "Usuario o contraseña incorrectos" };
    return {
      user: r.usuario.user, nombre: r.usuario.nombre, rol: r.usuario.rol,
      token: r.token, expira: Date.now() + (r.expira_seg || 21600) * 1000
    };
  }

  function sesionValida() {
    const s = getSession();
    if (!s || !s.token) return null;              // sesiones viejas (sin token) no sirven
    if (s.expira && Date.now() > s.expira) { clearSession(); return null; }
    return s;
  }

  function initLogin() {
    if (sesionValida()) { window.location.href = "app.html"; return; }
    clearSession();
    const form = $("login-form");
    const errorMsg = $("error-msg");
    const btn = form.querySelector("button");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorMsg.textContent = "";
      btn.disabled = true;
      btn.textContent = "Verificando...";
      const u = await verificarUsuario($("usuario").value, $("password").value);
      if (u && !u.error) {
        setSession(u);
        window.location.href = "app.html";
      } else {
        errorMsg.textContent = (u && u.error) || "Usuario o contraseña incorrectos";
        btn.disabled = false;
        btn.textContent = "Entrar";
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // APP PRINCIPAL
  // Todos los botones se conectan UNA sola vez aquí (antes se volvían
  // a conectar cada vez que se abría una pantalla y se enviaba doble).
  // ═══════════════════════════════════════════════════════════════

  function initApp() {
    usuarioActual = sesionValida();
    if (!usuarioActual) { clearSession(); window.location.href = "index.html"; return; }

    const userInfo = $("user-info");
    if (userInfo) userInfo.textContent = usuarioActual.nombre + " (" + (NOMBRE_ROL[usuarioActual.rol] || usuarioActual.rol) + ")";

    const on = (id, evento, handler) => {
      const el = $(id);
      if (el) el.addEventListener(evento, handler);
      else console.warn("Elemento no encontrado: " + id);
    };

    on("btn-logout", "click", async () => {
      if (!confirm("¿Cerrar sesión?")) return;
      try { await api("logout", {}, "POST"); } catch (e) { /* igual se cierra */ }
      clearSession();
      window.location.href = "index.html";
    });
    on("btn-mi-pass", "click", () => abrirPassword(null));

    // Menú
    on("btn-entrada", "click", () => abrirFormulario("ENTRADA"));
    on("btn-salida", "click", () => abrirFormulario("SALIDA"));
    on("btn-devolucion", "click", () => abrirFormulario("DEVOLUCION"));
    on("btn-ver-historial", "click", verHistorial);
    on("btn-ver-stock", "click", verStock);
    on("btn-ver-lotes", "click", verLotes);
    on("btn-abrir-lote", "click", abrirFormularioAbrirLote);
    on("btn-cerrar-lote", "click", abrirFormularioCerrarLote);
    on("btn-editar-movs", "click", abrirEditarMovs);
    on("btn-dashboard", "click", abrirDashboard);
    on("btn-reconstruir-stock", "click", reconstruirStockManual);
    on("btn-importar-ccp", "click", abrirImportar);
    on("btn-cerrar-importar", "click", () => { if (!importando) volverAlMenu(); });
    on("btn-imp-revisar", "click", revisarImportacion);
    on("btn-imp-importar", "click", ejecutarImportacion);
    on("imp-periodo", "change", ajustarPeriodo);
    on("imp-archivo", "change", tomarArchivoCCP);
    ["imp-archivo", "imp-anio", "imp-modo", "imp-periodo", "imp-mes", "imp-desde", "imp-hasta", "imp-status"]
      .forEach(id => on(id, "change", () => { planImport = null; $("btn-imp-importar").classList.add("hidden"); }));
    on("btn-usuarios", "click", verUsuarios);
    on("btn-alertas", "click", verAlertas);
    on("btn-scan-form", "click", escanearEnFormulario);
    on("btn-scan-stock", "click", escanearEnStock);
    on("btn-conteo", "click", abrirConteo);
    on("btn-conteos", "click", verConteos);
    on("btn-etiquetas", "click", verEtiquetas);
    on("btn-scan-ubic", "click", escanearUbicacionConteo);
    on("btn-scan-conteo", "click", escanearEnConteo);
    on("btn-mas", "click", () => ajustarCantidad(1));
    on("btn-menos", "click", () => ajustarCantidad(-1));
    on("btn-conteo-guardar", "click", guardarConteo);
    on("btn-conteo-cancelar", "click", cerrarPanelConteo);
    on("conteo-cantidad", "keydown", (e) => { if (e.key === "Enter") guardarConteo(); });
    on("btn-cerrar-conteo", "click", volverAlMenu);
    on("btn-cerrar-conteos", "click", volverAlMenu);
    on("btn-aplicar-conteos", "click", () => accionConteos("aplicar"));
    on("btn-descartar-conteos", "click", () => accionConteos("descartar"));
    on("btn-cerrar-etiquetas", "click", volverAlMenu);
    on("btn-imprimir-etiquetas", "click", imprimirEtiquetas);
    on("btn-etiqueta-entrada", "click", imprimirEtiquetaEntrada);
    on("btn-cerrar-alertas", "click", volverAlMenu);

    // Formulario de movimiento
    on("btn-cerrar-form", "click", volverAlMenu);
    on("btn-cancelar-form", "click", volverAlMenu);
    on("btn-guardar", "click", guardarMovimiento);
    on("buscar-insumo", "input", buscarInsumo);
    on("lote-insumo", "change", onLoteInsumoChange);
    on("btn-registrar-otro", "click", () => abrirFormulario(tipoMovimientoActual));
    on("btn-volver-menu", "click", volverAlMenu);
    on("btn-cerrar-historial", "click", volverAlMenu);

    // Edición
    on("btn-cerrar-modal-editar", "click", cerrarModalEditar);
    on("btn-cancelar-edicion", "click", cerrarModalEditar);
    on("btn-guardar-edicion", "click", guardarEdicion);
    on("btn-cerrar-editar-movs", "click", volverAlMenu);
    on("btn-buscar-editar-movs", "click", buscarMovimientosEditar);
    on("editar-movs-buscar", "input", (e) => {
      if (e.target.value.length >= 2) buscarMovimientosEditar();
      else if (e.target.value.length === 0) { movimientosEditarCache = []; renderizarEditarMovs([]); }
    });
    on("editar-movs-buscar-lote", "input", buscarMovimientosEditar);

    // Dashboard
    on("btn-cerrar-dashboard", "click", volverAlMenu);
    on("btn-aplicar-filtros", "click", cargarDashboard);

    // Stock
    on("btn-cerrar-stock", "click", volverAlMenu);
    on("stock-buscar", "input", filtrarStock);

    // Abrir lote
    on("btn-cerrar-abrir-lote", "click", volverAlMenu);
    on("btn-cancelar-abrir-lote", "click", volverAlMenu);
    on("abrir-lote-buscar", "input", buscarInsumoAbrirLote);
    on("abrir-lote-numero", "input", validarNumeroLote);
    on("btn-abrir-lote-guardar", "click", guardarAbrirLote);

    // Cerrar lote
    on("btn-cerrar-cerrar-lote", "click", volverAlMenu);
    on("btn-cancelar-cerrar-lote", "click", volverAlMenu);
    on("cerrar-lote-buscar", "input", buscarLoteCerrar);
    on("btn-cerrar-lote-guardar", "click", guardarCerrarLote);

    // Lotes
    on("btn-cerrar-lotes", "click", volverAlMenu);
    on("btn-cerrar-lote-movs", "click", () => mostrarVista("view-lotes"));
    on("btn-volver-lotes", "click", () => mostrarVista("view-lotes"));
    on("lotes-buscar", "input", filtrarLotes);
    on("lotes-filtro-status", "change", filtrarLotes);

    // Usuarios y contraseña
    on("btn-cerrar-usuarios", "click", volverAlMenu);
    on("btn-nuevo-usuario", "click", () => abrirFormUsuario(null));
    on("btn-guardar-usuario", "click", guardarUsuario);
    on("btn-cancelar-usuario", "click", verUsuarios);
    on("btn-guardar-pass", "click", guardarPassword);

    mostrarBotonesPorRol();

    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

    cargarCatalogos();
    mostrarVista("view-menu");
  }

  function mostrarBotonesPorRol() {
    const mostrar = (id, si) => { const el = $(id); if (el) el.classList.toggle("hidden", !si); };
    const sup = esSupervisor();
    const tipos = TIPOS_POR_ROL[usuarioActual.rol] || [];
    mostrar("btn-entrada", tipos.includes("ENTRADA"));
    mostrar("btn-salida", tipos.includes("SALIDA"));
    mostrar("btn-devolucion", tipos.includes("DEVOLUCION"));
    mostrar("btn-abrir-lote", sup);
    mostrar("btn-cerrar-lote", sup);
    mostrar("btn-editar-movs", sup);
    mostrar("btn-dashboard", sup);
    mostrar("btn-reconstruir-stock", usuarioActual.rol === "admin");
    mostrar("btn-importar-ccp", usuarioActual.rol === "admin");
    mostrar("btn-usuarios", usuarioActual.rol === "admin");
    mostrar("btn-alertas", sup);
    mostrar("btn-conteos", sup);
    if (sup) { actualizarBadgeAlertas(); actualizarBadgeConteos(); }
  }

  async function cargarCatalogos() {
    const cat = await api("listar_catalogo");
    if (cat.ok) catalogoCache = cat.insumos;
    const dcs = await api("listar_dcs");
    if (dcs.ok) dcsCache = dcs.dcs;
  }

  const VISTAS = ["view-menu", "view-form", "view-exito", "view-historial", "view-loading",
    "view-dashboard", "view-stock", "view-abrir-lote", "view-cerrar-lote",
    "view-lotes", "view-lote-movs", "view-editar-movs", "view-usuarios",
    "view-usuario-form", "view-password", "view-alertas", "view-conteo", "view-conteos", "view-etiquetas", "view-importar"];

  function mostrarVista(id) {
    VISTAS.forEach(v => { const el = $(v); if (el) el.classList.add("hidden"); });
    const el = $(id);
    if (el) el.classList.remove("hidden");
    window.scrollTo(0, 0);
  }

  function cargando(texto) {
    mostrarVista("view-loading");
    $("loading-text").textContent = texto || "Cargando...";
  }

  function volverAlMenu() {
    insumoSeleccionado = null;
    tipoMovimientoActual = null;
    loteActivoEnVista = null;
    mostrarVista("view-menu");
    if (esSupervisor()) { actualizarBadgeAlertas(); actualizarBadgeConteos(); }
  }

  // ═══════════════════════════════════════════════════════════════
  // FORMULARIO DE MOVIMIENTO
  // ═══════════════════════════════════════════════════════════════

  function abrirFormulario(tipo) {
    const tipos = TIPOS_POR_ROL[usuarioActual.rol] || [];
    if (!tipos.includes(tipo)) { alert("No tienes permiso para registrar " + tipo); return; }

    tipoMovimientoActual = tipo;
    insumoSeleccionado = null;

    $("buscar-insumo").value = "";
    $("info-insumo").classList.add("hidden");
    $("info-stock").classList.add("hidden");
    $("resultados-busqueda").classList.add("hidden");
    $("info-lote-insumo").classList.add("hidden");

    const esEntrada = tipo === "ENTRADA";
    $("grupo-lote-insumo-select").classList.toggle("hidden", esEntrada);
    $("grupo-lote-insumo-input").classList.toggle("hidden", !esEntrada);
    $("lote-insumo-input").value = "";
    $("lote-insumo").innerHTML = esEntrada
      ? '<option value="">-- No aplica --</option>'
      : '<option value="">-- Selecciona un insumo primero --</option>';

    ["lote-trabajo", "cantidad", "proveedor", "pu", "iva", "notas"].forEach(id => { $(id).value = ""; });
    $("lote-trabajo-status").textContent = "";
    msg($("registro-status"), "");
    $("btn-guardar").disabled = false;

    // Fecha manual: solo supervisor+ (el servidor también lo valida)
    const grupoFecha = $("grupo-fecha-manual");
    const inputFecha = $("fecha-manual");
    inputFecha.value = "";
    grupoFecha.classList.toggle("hidden", !esSupervisor());
    if (esSupervisor()) inputFecha.setAttribute("max", hoyISO());

    const titulos = { ENTRADA: "Registrar ENTRADA", SALIDA: "Registrar SALIDA", DEVOLUCION: "Registrar DEVOLUCIÓN" };
    $("form-titulo").textContent = titulos[tipo] || "Registrar Movimiento";

    $("grupo-lote-trabajo").classList.toggle("hidden", tipo === "ENTRADA");
    // El costo de SALIDAS y DEVOLUCIONES lo pone el servidor (PU del lote)
    $("grupo-pu-iva").classList.toggle("hidden", !esEntrada);
    $("aviso-pu").classList.toggle("hidden", esEntrada);
    $("lote-insumo-etiqueta").textContent = tipo === "DEVOLUCION" ? "Lote al que regresa *" : "Lote del insumo";
    if (!esEntrada) cargarLotesTrabajoAbiertos();
    $("grupo-ubicacion").classList.remove("hidden");
    $("grupo-proveedor").classList.toggle("hidden", tipo === "DEVOLUCION");

    llenarUbicaciones();
    mostrarVista("view-form");
    enfocarSiLibre("buscar-insumo");
  }

  function hoyISO() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function llenarUbicaciones() {
    const select = $("ubicacion");
    select.innerHTML = '<option value="">-- Selecciona --</option>';
    ["ALMACEN_MP", "ALMACEN_EMPAQUE", "ALMACEN_PT", "ALMACEN_SP", "SERVICIOS", "ADMINISTRACION", "PRODUCCION"].forEach(u => {
      const opt = document.createElement("option");
      opt.value = u;
      opt.textContent = u;
      select.appendChild(opt);
    });
    if (dcsCache && dcsCache.length > 0) {
      const grupo = document.createElement("optgroup");
      grupo.label = "── DCs / CEDIS ──";
      dcsCache.forEach(dc => {
        const opt = document.createElement("option");
        opt.value = dc.dc;
        opt.textContent = dc.dc + " - " + dc.ciudad + ", " + dc.estado;
        grupo.appendChild(opt);
      });
      select.appendChild(grupo);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // BÚSQUEDA INTELIGENTE (igual que Mantenimiento Mediese)
  // Sin acentos, por palabras en cualquier orden, singular/plural,
  // y primero lo que coincide con el código y lo que usaste hace poco.
  // ═══════════════════════════════════════════════════════════════

  function sinAcentos(t) {
    return String(t || "").toUpperCase().replace(/Ñ/g, "\u0001")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\u0001/g, "Ñ");
  }
  // Para comparar: sin acentos y Ñ = N (así "espanol" encuentra "ESPAÑOL")
  function plano(t) { return sinAcentos(t).replace(/Ñ/g, "N"); }
  function palabras(t) {
    return plano(t).split(/[^A-Z0-9.\/-]+/).filter(w => w.length >= 1);
  }
  function variantes(w) {
    const v = [w];
    if (w.length > 3 && w.endsWith("ES")) v.push(w.slice(0, -2));
    if (w.length > 2 && w.endsWith("S")) v.push(w.slice(0, -1));
    return v;
  }

  function recientes() { try { return JSON.parse(leerLocal("recientes") || "[]"); } catch (e) { return []; } }
  function marcarReciente(codigo) {
    const r = recientes().filter(c => c !== codigo);
    r.unshift(codigo);
    guardarLocal("recientes", JSON.stringify(r.slice(0, 15)));
  }

  function buscarEnCatalogo(q, max) {
    const ws = palabras(q);
    if (!ws.length) return [];
    const qJunto = plano(q).replace(/\s+/g, "");
    const rec = recientes();
    return (catalogoCache || []).map(i => {
      const cod = plano(i.codigo);
      const texto = cod + " " + cod.replace(/\s+/g, "") + " " + plano(i.descripcion) + " " + plano(i.categoria) + " " + plano(i.proveedor);
      if (!ws.every(w => variantes(w).some(v => texto.includes(v)))) return null;
      let pts = 0;
      if (cod.replace(/\s+/g, "") === qJunto) pts += 100;
      else if (cod.replace(/\s+/g, "").startsWith(qJunto)) pts += 50;
      const r = rec.indexOf(i.codigo);
      if (r >= 0) pts += 20 - r;
      return { i: i, pts: pts };
    }).filter(Boolean).sort((a, b) => b.pts - a.pts || String(a.i.codigo).localeCompare(String(b.i.codigo)))
      .slice(0, max || 20).map(x => x.i);
  }

  function filtrarCatalogo(query) { return buscarEnCatalogo(query, 20); }

  function insumoPorCodigo(codigo) {
    const c = sinAcentos(codigo).replace(/\s+/g, "");
    return (catalogoCache || []).find(i => sinAcentos(i.codigo).replace(/\s+/g, "") === c) || null;
  }

  function vibrar(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 60); } catch (e) {} }
  function guardarLocal(k, v) { try { localStorage.setItem("almacen_" + k, v); } catch (e) {} }
  function leerLocal(k) { try { return localStorage.getItem("almacen_" + k); } catch (e) { return null; } }

  // ═══════════════════════════════════════════════════════════════
  // ESCÁNER QR (Android con BarcodeDetector; iPhone y otros con jsQR)
  // ═══════════════════════════════════════════════════════════════

  function cargarScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector("script[data-lib='" + src + "']")) return resolve();
      const sc = document.createElement("script");
      sc.src = src;
      sc.dataset.lib = src;
      sc.onload = () => resolve();
      sc.onerror = () => reject(new Error("No se pudo cargar " + src));
      document.head.appendChild(sc);
    });
  }

  async function escanearQR(texto) {
    const modal = $("scanner");
    const video = $("scanner-video");
    const aviso = $("scanner-msg");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Este navegador no permite usar la cámara. Escribe el código.");
      return null;
    }
    let detector = null;
    if ("BarcodeDetector" in window) {
      try {
        const formatos = await window.BarcodeDetector.getSupportedFormats();
        if (formatos.includes("qr_code")) detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      } catch (e) { detector = null; }
    }
    if (!detector) {
      try { await cargarScript("jsQR.min.js"); }
      catch (e) { alert("No se pudo cargar el lector de QR. Revisa tu conexión."); return null; }
    }

    return new Promise(async resolve => {
      let terminado = false, stream = null;
      const cerrar = (valor) => {
        if (terminado) return;
        terminado = true;
        if (stream) stream.getTracks().forEach(t => t.stop());
        video.srcObject = null;
        modal.classList.add("hidden");
        resolve(valor);
      };
      $("scanner-cerrar").onclick = () => cerrar(null);
      aviso.textContent = texto || "Apunta al código QR";
      modal.classList.remove("hidden");
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch (e) {
        alert("No se pudo abrir la cámara. Permite el acceso a la cámara para este sitio en el navegador.");
        return cerrar(null);
      }
      video.setAttribute("playsinline", "");
      video.muted = true;
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* algunos iPhone requieren el toque inicial */ }

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const leer = window.jsQR ? (window.jsQR.default || window.jsQR) : null;
      const ciclo = async () => {
        if (terminado) return;
        if (video.readyState >= 2 && video.videoWidth) {
          try {
            if (detector) {
              const r = await detector.detect(video);
              if (r && r.length) { vibrar(80); return cerrar(r[0].rawValue); }
            } else if (leer) {
              const escala = Math.min(1, 640 / video.videoWidth);
              canvas.width = Math.round(video.videoWidth * escala);
              canvas.height = Math.round(video.videoHeight * escala);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const r = leer(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
              if (r && r.data) { vibrar(80); return cerrar(r.data); }
            }
          } catch (e) { /* sigue intentando */ }
        }
        setTimeout(ciclo, 160);
      };
      ciclo();
    });
  }

  // Etiquetas del almacén:
  //   "ALM|MPH0009|L-101" → insumo + lote     "ALM|MPH0009" → insumo
  //   "UBI:ALMACEN_MP"    → ubicación         otro texto     → código de insumo
  function interpretarQR(txt) {
    const t = String(txt || "").trim();
    const T = t.toUpperCase();
    if (T.indexOf("UBI:") === 0) return { tipo: "ubicacion", valor: T.slice(4).trim() };
    if (T.indexOf("ALM|") === 0) {
      const p = t.split("|");
      return { tipo: "insumo", codigo: (p[1] || "").trim(), lote: (p[2] || "").trim().toUpperCase() };
    }
    return { tipo: "insumo", codigo: t, lote: "" };
  }

  // Escanea y devuelve { insumo, lote } o null (avisa si no sirve)
  async function escanearInsumo() {
    const txt = await escanearQR("Apunta a la etiqueta del insumo o lote");
    if (!txt) return null;
    const q = interpretarQR(txt);
    if (q.tipo === "ubicacion") { alert("Esa es la etiqueta de una ubicación. Escanea la del insumo o lote."); return null; }
    if (!catalogoCache) await cargarCatalogos();
    const insumo = insumoPorCodigo(q.codigo);
    if (!insumo) { alert("Esa etiqueta no corresponde a un insumo activo: " + q.codigo); return null; }
    return { insumo: insumo, lote: q.lote };
  }

  function pintarResultadosInsumo(contenedor, lista, alElegir) {
    if (!catalogoCache) {
      contenedor.innerHTML = '<div class="resultado-vacio">Catálogo cargando...</div>';
    } else if (lista.length === 0) {
      contenedor.innerHTML = '<div class="resultado-vacio">Sin resultados</div>';
    } else {
      contenedor.innerHTML = "";
      lista.forEach(insumo => {
        const div = document.createElement("div");
        div.className = "resultado-item";
        div.innerHTML =
          '<div class="resultado-codigo">' + esc(insumo.codigo) + '</div>' +
          '<div class="resultado-desc">' + esc(insumo.descripcion) + '</div>' +
          '<div class="resultado-cat">' + esc(insumo.categoria) + '</div>';
        div.addEventListener("click", () => alElegir(insumo));
        contenedor.appendChild(div);
      });
    }
    contenedor.classList.remove("hidden");
  }

  function buscarInsumo() {
    const query = $("buscar-insumo").value.trim().toUpperCase();
    const resultados = $("resultados-busqueda");
    if (query.length < 2) { resultados.classList.add("hidden"); return; }
    pintarResultadosInsumo(resultados, filtrarCatalogo(query), seleccionarInsumo);
  }

  async function escanearEnFormulario() {
    const r = await escanearInsumo();
    if (!r) return;
    seleccionarInsumo(r.insumo, r.lote);
    if (tipoMovimientoActual === "ENTRADA" && r.lote) $("lote-insumo-input").value = r.lote;
    $("cantidad").focus();
  }

  function seleccionarInsumo(insumo, lotePreferido) {
    insumoSeleccionado = insumo;
    marcarReciente(insumo.codigo);
    $("buscar-insumo").value = insumo.codigo + " - " + insumo.descripcion;
    $("resultados-busqueda").classList.add("hidden");
    $("info-codigo").textContent = insumo.codigo;
    $("info-descripcion").textContent = insumo.descripcion;
    $("info-unidad").textContent = insumo.unidad;
    $("info-categoria").textContent = insumo.categoria;
    $("info-insumo").classList.remove("hidden");
    $("label-unidad").textContent = "(" + insumo.unidad + ")";
    if (insumo.proveedor) $("proveedor").value = insumo.proveedor;

    const selectUbic = $("ubicacion");
    for (let i = 0; i < selectUbic.options.length; i++) {
      if (selectUbic.options[i].value === insumo.ubicacion) { selectUbic.selectedIndex = i; break; }
    }

    consultarStockInsumo(insumo.codigo);
    if (tipoMovimientoActual !== "ENTRADA") cargarLotesDisponibles(insumo.codigo, lotePreferido);
  }

  // ═══════════════════════════════════════════════════════════════
  // LOTES DISPONIBLES (PEPS)
  // ═══════════════════════════════════════════════════════════════

  async function cargarLotesDisponibles(codigo, lotePreferido) {
    const select = $("lote-insumo");
    const infoPanel = $("info-lote-insumo");
    const esDevolucion = tipoMovimientoActual === "DEVOLUCION";
    select.innerHTML = '<option value="">-- Cargando lotes... --</option>';
    infoPanel.classList.add("hidden");

    const resp = await api("lotes_disponibles", { codigo: codigo, incluir_agotados: esDevolucion ? "1" : "" });
    const lotes = resp.ok ? (resp.lotes || []) : [];
    select.innerHTML = "";

    if (esDevolucion) {
      select.appendChild(new Option(lotes.length ? "-- Selecciona el lote --" : "-- Este insumo no tiene lotes --", ""));
    } else if (lotes.length) {
      // Por defecto el servidor reparte del lote más viejo al más nuevo
      select.appendChild(new Option("⭐ PEPS automático (el sistema elige el lote)", ""));
    } else {
      select.appendChild(new Option("-- Sin stock disponible --", ""));
    }

    lotes.forEach((lote, index) => {
      const opt = new Option(
        lote.lote + " | " + fmtNum(lote.saldo) + " " + (lote.unidad || "") +
        (lote.fecha_entrada ? " | " + lote.fecha_entrada : "") + (!esDevolucion && index === 0 ? " (más viejo)" : ""),
        lote.lote
      );
      opt.dataset.saldo = lote.saldo;
      opt.dataset.pu = lote.pu;
      opt.dataset.unidad = lote.unidad || "";
      opt.dataset.fecha = lote.fecha_entrada || "";
      opt.dataset.proveedor = lote.proveedor || "";
      select.appendChild(opt);
    });
    select.dataset.lotes = JSON.stringify(lotes);
    if (lotePreferido) {
      const o = Array.from(select.options).find(x => x.value.toUpperCase() === String(lotePreferido).toUpperCase());
      if (o) select.value = o.value;
      else alert("El lote " + lotePreferido + " no tiene saldo de este insumo. Revisa la etiqueta.");
    }
    onLoteInsumoChange();
  }

  function onLoteInsumoChange() {
    const select = $("lote-insumo");
    const infoPanel = $("info-lote-insumo");
    const op = select.options[select.selectedIndex];
    if (!op) { infoPanel.classList.add("hidden"); return; }

    if (!op.value) {
      if (tipoMovimientoActual !== "SALIDA") { infoPanel.classList.add("hidden"); return; }
      let lotes = [];
      try { lotes = JSON.parse(select.dataset.lotes || "[]"); } catch (e) { lotes = []; }
      if (!lotes.length) { infoPanel.classList.add("hidden"); return; }
      infoPanel.innerHTML =
        '<strong>⭐ PEPS automático:</strong> sale primero del lote <strong>' + esc(lotes[0].lote) + '</strong> (' +
        fmtNum(lotes[0].saldo) + ' ' + esc(lotes[0].unidad) + '). Si no alcanza, el sistema sigue con el siguiente lote.';
      infoPanel.classList.remove("hidden");
      return;
    }

    infoPanel.innerHTML =
      '<strong>📦 Lote:</strong> ' + esc(op.value) + '<br/>' +
      '<strong>Saldo:</strong> ' + fmtNum(op.dataset.saldo) + ' ' + esc(op.dataset.unidad) + '<br/>' +
      '<strong>Fecha entrada:</strong> ' + esc(op.dataset.fecha || "-") + '<br/>' +
      '<strong>PU del lote:</strong> $' + fmtNum(op.dataset.pu) +
      (op.dataset.proveedor ? '<br/><strong>Proveedor:</strong> ' + esc(op.dataset.proveedor) : '');
    infoPanel.classList.remove("hidden");
  }

  async function cargarLotesTrabajoAbiertos() {
    const r = await api("listar_lotes_abiertos");
    const dl = $("lotes-abiertos-lista");
    dl.innerHTML = "";
    (r.ok ? r.lotes : []).forEach(l => {
      const o = document.createElement("option");
      o.value = l.lote;
      o.label = l.codigo_oar + " - " + l.descripcion;
      dl.appendChild(o);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // GUARDAR MOVIMIENTO
  // ═══════════════════════════════════════════════════════════════

  async function guardarMovimiento() {
    const statusEl = $("registro-status");
    const btn = $("btn-guardar");

    if (!insumoSeleccionado) return msg(statusEl, "Selecciona un insumo", "error");
    const cantidad = parseFloat($("cantidad").value);
    if (!cantidad || cantidad <= 0) return msg(statusEl, "Cantidad inválida", "error");

    let loteInsumo = "";
    if (tipoMovimientoActual === "ENTRADA") {
      loteInsumo = $("lote-insumo-input").value.trim();
      if (!loteInsumo) return msg(statusEl, "Escribe el lote del insumo que ingresa", "error");
    } else {
      loteInsumo = $("lote-insumo").value;
    }

    if (tipoMovimientoActual === "DEVOLUCION" && !loteInsumo) {
      return msg(statusEl, "Selecciona el lote al que regresa el material", "error");
    }

    let fechaManual = "";
    if (esSupervisor()) {
      const iso = $("fecha-manual").value.trim();   // yyyy-mm-dd
      if (iso) { const p = iso.split("-"); fechaManual = p[2] + "/" + p[1] + "/" + p[0]; }
    }

    const payload = {
      tipo_movimiento: tipoMovimientoActual,
      codigo_oar: insumoSeleccionado.codigo,
      descripcion: insumoSeleccionado.descripcion,
      unidad: insumoSeleccionado.unidad,
      lote_insumo: loteInsumo,
      lote_trabajo: $("lote-trabajo").value.trim(),
      cantidad: cantidad,
      ubicacion: $("ubicacion").value,
      proveedor_cliente: $("proveedor").value.trim(),
      pu: tipoMovimientoActual === "ENTRADA" ? (parseFloat($("pu").value) || 0) : 0,
      iva: tipoMovimientoActual === "ENTRADA" ? (parseFloat($("iva").value) || 0) : 0,
      notas: $("notas").value.trim(),
      fecha_manual: fechaManual,
    };

    msg(statusEl, "Guardando...");
    btn.disabled = true;
    try {
      const resp = await api("registrar_movimiento", payload, "POST");
      if (!resp.ok) {
        if (resp.lote_cerrado) {
          if (confirm(resp.error + "\n\n¿Deseas reactivar el lote?")) {
            const r2 = await api("abrir_lote", {
              lote: payload.lote_trabajo, codigo_oar: insumoSeleccionado.codigo,
              descripcion: insumoSeleccionado.descripcion,
            }, "POST");
            alert(r2.ok ? "Lote reabierto. Vuelve a intentar el registro." : "No se pudo reabrir: " + r2.error);
          }
          msg(statusEl, "");
          return;
        }
        msg(statusEl, "❌ " + (resp.error || "Error desconocido"), "error");
        if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
        return;
      }
      mostrarExito(resp, cantidad);
    } finally {
      btn.disabled = false;
    }
  }

  let ultimaEntrada = null;

  function mostrarExito(resp, cantidad) {
    ultimaEntrada = tipoMovimientoActual === "ENTRADA"
      ? { codigo: insumoSeleccionado.codigo, descripcion: insumoSeleccionado.descripcion, unidad: insumoSeleccionado.unidad,
          lote: (resp.asignaciones && resp.asignaciones[0] ? resp.asignaciones[0].lote : resp.lote_insumo), fecha: resp.fecha, cantidad: cantidad }
      : null;
    $("btn-etiqueta-entrada").classList.toggle("hidden", !ultimaEntrada);
    $("exito-id").textContent = (resp.ids && resp.ids.length > 1) ? resp.ids.join(", ") : (resp.id_movimiento || "-");
    const rep = $("exito-reparto");
    if (resp.asignaciones && resp.asignaciones.length) {
      rep.innerHTML = '<div class="exito-fila"><span>Lote(s):</span><strong>' +
        resp.asignaciones.map(a => esc(a.lote) + " → " + fmtNum(a.cantidad) + " " + esc(resp.unidad || "")).join("<br>") +
        '</strong></div>' + (resp.alerta ? '<div class="exito-fila error"><span>⚠️</span><strong>Quedó stock negativo: se avisó al supervisor</strong></div>' : '');
      rep.classList.remove("hidden");
    } else {
      rep.classList.add("hidden");
    }
    $("exito-tipo").textContent = tipoMovimientoActual;
    $("exito-insumo").textContent = insumoSeleccionado.codigo + " - " + insumoSeleccionado.descripcion;
    $("exito-cantidad").textContent = cantidad + " " + insumoSeleccionado.unidad;
    $("exito-fecha").textContent = resp.retroactivo
      ? "⚠️ RETROACTIVO: " + (resp.fecha || "") + " (registrado hoy)"
      : (resp.fecha || "") + " " + (resp.hora || "");
    mostrarVista("view-exito");
  }

  // ═══════════════════════════════════════════════════════════════
  // HISTORIAL (mis movimientos de hoy)
  // ═══════════════════════════════════════════════════════════════

  async function verHistorial() {
    cargando("Cargando movimientos...");
    const resp = await api("movimientos_hoy");
    if (!resp.ok) { alert("Error: " + resp.error); return volverAlMenu(); }

    const cont = $("lista-movimientos");
    cont.innerHTML = "";
    if (resp.movimientos.length === 0) {
      cont.innerHTML = '<p class="vacio">No tienes movimientos hoy.</p>';
    }
    resp.movimientos.forEach(m => {
      const card = document.createElement("div");
      card.className = "movimiento-card mov-" + String(m.tipo).toLowerCase();
      card.innerHTML =
        '<div class="mov-header"><span class="mov-tipo">' + esc(m.tipo) + '</span><span class="mov-hora">' + esc(m.hora) + '</span></div>' +
        '<div class="mov-codigo">' + esc(m.codigo) + '</div>' +
        '<div class="mov-desc">' + esc(m.descripcion) + '</div>' +
        '<div class="mov-cantidad">' + esc(m.cantidad) + ' ' + esc(m.unidad) + '</div>' +
        (m.estado === "CANCELADO" ? '<div class="mov-cancelado">CANCELADO</div>' : "");
      cont.appendChild(card);
    });
    mostrarVista("view-historial");
  }

  // ═══════════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════════

  async function abrirDashboard() {
    $("filtro-fecha").value = hoyISO();
    $("filtro-tipo").value = "TODOS";
    const sel = $("filtro-usuario");
    if (sel.options.length <= 1) {
      const r = await api("listar_nombres_usuarios");
      if (r.ok) r.usuarios.forEach(u => {
        const o = document.createElement("option");
        o.value = u.usuario;
        o.textContent = u.nombre + " (" + u.usuario + ")";
        sel.appendChild(o);
      });
    }
    sel.value = "";
    mostrarVista("view-dashboard");
    cargarDashboard();
  }

  function cargarDashboard() { cargarResumen(); cargarMovimientosDashboard(); }

  function formatearFecha(fechaISO) {
    if (!fechaISO) return "";
    const p = fechaISO.split("-");
    return p[2] + "/" + p[1] + "/" + p[0];
  }

  async function cargarResumen() {
    const resp = await api("resumen_dia", { fecha: formatearFecha($("filtro-fecha").value) });
    if (!resp.ok) return;
    const tarjeta = (clase, n, txt) =>
      '<div class="resumen-card ' + clase + '"><span class="resumen-numero">' + esc(n) + '</span><span class="resumen-label">' + txt + '</span></div>';
    $("resumen-dia").innerHTML =
      tarjeta("entrada", resp.total_entradas, "Entradas") +
      tarjeta("salida", resp.total_salidas, "Salidas") +
      tarjeta("devolucion", resp.total_devoluciones, "Devoluciones") +
      tarjeta("total", resp.total_movimientos, "Total");
  }

  async function cargarMovimientosDashboard() {
    const cont = $("lista-dashboard");
    cont.innerHTML = '<p class="vacio">Cargando...</p>';
    const resp = await api("movimientos_dia", {
      fecha: formatearFecha($("filtro-fecha").value),
      tipo: $("filtro-tipo").value !== "TODOS" ? $("filtro-tipo").value : "",
      filtro_usuario: $("filtro-usuario").value,
    });
    if (!resp.ok) { cont.innerHTML = '<p class="vacio error">Error: ' + esc(resp.error) + '</p>'; return; }
    mostrarMovimientosDashboard(resp.movimientos);
  }

  function mostrarMovimientosDashboard(movimientos) {
    const cont = $("lista-dashboard");
    cont.innerHTML = "";
    if (movimientos.length === 0) { cont.innerHTML = '<p class="vacio">No hay movimientos en esta fecha.</p>'; return; }

    movimientos.sort((a, b) => String(b.hora || "").localeCompare(String(a.hora || "")));
    movimientos.forEach(m => {
      const card = document.createElement("div");
      card.className = "movimiento-card mov-" + String(m.tipo).toLowerCase();
      if (m.estado === "CANCELADO") card.style.opacity = "0.5";
      const esRetro = m.notas && String(m.notas).includes("[Fecha manual:");
      card.innerHTML =
        '<div class="mov-header"><span class="mov-tipo">' + esc(m.tipo) + '</span><span class="mov-hora">' + esc(m.hora) + '</span></div>' +
        '<div class="mov-codigo">' + esc(m.codigo) + (esRetro ? ' <span class="chip-retro">📅 RETRO</span>' : '') + '</div>' +
        '<div class="mov-desc">' + esc(m.descripcion) + '</div>' +
        '<div class="mov-cantidad">' + esc(m.cantidad) + ' ' + esc(m.unidad) + '</div>' +
        '<div class="mov-usuario">Usuario: ' + esc(m.nombre_usuario || m.usuario) + ' (' + esc(m.rol) + ')</div>' +
        (m.lote_insumo ? '<div class="mov-usuario">Lote: ' + esc(m.lote_insumo) + '</div>' : '') +
        (m.estado === "CANCELADO" ? '<div class="mov-cancelado">CANCELADO</div>' : '');

      if (m.estado !== "CANCELADO") {
        const acc = document.createElement("div");
        acc.className = "acciones-card";
        const bEd = document.createElement("button");
        bEd.className = "btn-editar-card";
        bEd.textContent = "✏️ Corregir";
        bEd.addEventListener("click", () => abrirModalEditar({
          id: m.id, tipo: m.tipo, codigo_oar: m.codigo, descripcion: m.descripcion,
          cantidad: m.cantidad, unidad: m.unidad, lote_insumo: m.lote_insumo || "",
          lote_trabajo: m.lote_trabajo || "", ubicacion: m.ubicacion || "",
          proveedor_cliente: m.proveedor || "", pu: m.pu || 0, iva: m.iva || 0,
          notas: m.notas || "", fecha: m.fecha, hora: m.hora,
        }));
        const bCa = document.createElement("button");
        bCa.className = "btn-cancelar-mov";
        bCa.textContent = "Cancelar";
        bCa.addEventListener("click", () => cancelarMovimientoDash(m));
        acc.appendChild(bEd);
        acc.appendChild(bCa);
        card.appendChild(acc);
      }
      cont.appendChild(card);
    });
  }

  async function cancelarMovimientoDash(mov) {
    const motivo = prompt("Motivo de la cancelación:\n\n(" + mov.codigo + " - " + mov.cantidad + " " + mov.unidad + ")");
    if (motivo === null) return;
    if (!motivo.trim()) { alert("Debes ingresar un motivo"); return; }
    const resp = await api("cancelar_movimiento", { id_movimiento: mov.id, motivo: motivo.trim() }, "POST");
    if (!resp.ok) { alert("Error: " + (resp.error || "Desconocido")); return; }
    alert(resp.ya_cancelado ? "Ese movimiento ya estaba cancelado" : "Movimiento cancelado");
    cargarDashboard();
  }

  // ═══════════════════════════════════════════════════════════════
  // STOCK ACTUAL
  // ═══════════════════════════════════════════════════════════════

  let stockCorte = "";
  async function verStock() {
    cargando("Cargando stock...");
    const resp = await api("listar_stock");
    if (!resp.ok) { alert("Error al cargar stock: " + resp.error); return volverAlMenu(); }
    stockCache = resp.items || [];
    stockValorTotal = resp.valor_total || 0;
    stockCorte = resp.corte || "";
    $("stock-buscar").value = "";
    renderizarStock(stockCache);
    mostrarVista("view-stock");
  }

  function filtrarStock() {
    const ws = palabras($("stock-buscar").value);
    if (!ws.length) { renderizarStock(stockCache); return; }
    renderizarStock(stockCache.filter(item => {
      const t = plano(item.codigo + " " + item.descripcion + " " + item.lote + " " + item.ubicacion);
      return ws.every(w => variantes(w).some(v => t.includes(v)));
    }));
  }

  async function escanearEnStock() {
    const r = await escanearInsumo();
    if (!r) return;
    $("stock-buscar").value = r.insumo.codigo + (r.lote ? " " + r.lote : "");
    filtrarStock();
  }

  function tarjetasResumen(datos) {
    return datos.map(([n, txt]) =>
      '<div class="stock-resumen-card"><span class="stock-resumen-numero">' + esc(n) + '</span><span class="stock-resumen-label">' + txt + '</span></div>'
    ).join("");
  }

  function renderizarStock(items) {
    const cont = $("lista-stock");
    const negativos = items.filter(i => i.saldo < 0);
    const resumen = [
      [items.filter(i => i.saldo > 0).length, "Lotes con stock"],
      [negativos.length, "⚠️ En negativo"],
    ];
    if (esSupervisor()) resumen.push(["$" + fmtNum(stockValorTotal), "Valor inventario"]);
    if (stockCorte) resumen.push([stockCorte, "📅 Datos al"]);
    $("stock-resumen").innerHTML = tarjetasResumen(resumen);
    cont.innerHTML = "";
    if (items.length === 0) { cont.innerHTML = '<div class="stock-vacio">No hay insumos con stock</div>'; return; }

    // Negativos primero (hay que corregirlos), luego por código
    items.slice().sort((a, b) => {
      if ((a.saldo < 0) !== (b.saldo < 0)) return a.saldo < 0 ? -1 : 1;
      return String(a.codigo).localeCompare(String(b.codigo)) || String(a.primera_entrada).localeCompare(String(b.primera_entrada));
    }).forEach(item => {
      const div = document.createElement("div");
      div.className = "stock-item";
      if (item.saldo < 0) div.classList.add("stock-negativo");
      else if (item.saldo < 100) div.classList.add("stock-bajo");
      div.innerHTML =
        '<div class="stock-item-header">' +
          '<span class="stock-item-codigo">' + esc(item.codigo) + '</span>' +
          '<span class="stock-item-saldo">' + (item.saldo < 0 ? "⚠️ " : "") + fmtNum(item.saldo) + ' ' + esc(item.unidad) + '</span>' +
        '</div>' +
        '<div class="stock-item-desc">' + esc(item.descripcion || '-') + '</div>' +
        '<div class="stock-item-info">' +
          '<span>Lote: <strong>' + esc(item.lote || 'SIN_LOTE') + '</strong>' + (item.primera_entrada ? ' · ' + esc(item.primera_entrada) : '') + '</span>' +
          '<span>' + esc(item.ubicacion || '-') + '</span>' +
        '</div>' +
        (item.ultimo_movimiento ? '<div class="stock-item-info"><span>📅 Último movimiento: <strong>' + esc(item.ultimo_movimiento) + '</strong></span></div>' : '') +
        (esSupervisor() && item.pu ? '<div class="stock-item-info"><span>PU: $' + fmtNum(item.pu) + '</span><span>Valor: $' + fmtNum(item.valor) + '</span></div>' : '');
      cont.appendChild(div);
    });
  }

  async function consultarStockInsumo(codigo) {
    const panel = $("info-stock");
    const valor = $("info-stock-valor");
    const resp = await api("stock_insumo_total", { codigo: codigo });
    if (!resp.ok) { panel.classList.add("hidden"); return; }
    const total = Number(resp.saldo_total) || 0;
    const unidad = insumoSeleccionado && insumoSeleccionado.unidad ? insumoSeleccionado.unidad : "";
    valor.textContent = fmtNum(total) + " " + unidad + (total === 0 ? " (sin stock)" : "") +
      (resp.ultimo_movimiento ? " · al " + resp.ultimo_movimiento : "");
    panel.classList.toggle("warning", total < 100);
    panel.classList.remove("hidden");
  }

  // ═══════════════════════════════════════════════════════════════
  // EDITAR MOVIMIENTOS
  // ═══════════════════════════════════════════════════════════════

  function abrirEditarMovs() {
    $("editar-movs-buscar").value = "";
    $("editar-movs-buscar-lote").value = "";
    $("editar-movs-resumen").innerHTML = "";
    $("lista-editar-movs").innerHTML = "";
    movimientosEditarCache = [];
    mostrarVista("view-editar-movs");
    enfocarSiLibre("editar-movs-buscar");
  }

  let busquedaEditarSeq = 0;
  async function buscarMovimientosEditar() {
    const codigo = $("editar-movs-buscar").value.trim();
    const lote = $("editar-movs-buscar-lote").value.trim();
    if (!codigo && !lote) { movimientosEditarCache = []; renderizarEditarMovs([]); return; }

    const seq = ++busquedaEditarSeq;
    $("lista-editar-movs").innerHTML = '<p class="vacio">Buscando...</p>';
    const resp = await api("listar_movs_insumo", { codigo: codigo, lote: lote });
    if (seq !== busquedaEditarSeq) return;   // llegó una búsqueda más nueva
    if (!resp.ok) { $("lista-editar-movs").innerHTML = '<p class="vacio error">Error: ' + esc(resp.error) + '</p>'; return; }
    movimientosEditarCache = resp.movimientos || [];
    renderizarEditarMovs(movimientosEditarCache);
  }

  function renderizarEditarMovs(movs) {
    const cont = $("lista-editar-movs");
    $("editar-movs-resumen").innerHTML = tarjetasResumen([
      [movs.length, "Total"],
      [movs.filter(m => m.estado !== "CANCELADO").length, "Activos"],
      [movs.filter(m => m.estado === "CANCELADO").length, "Cancelados"],
    ]);
    cont.innerHTML = "";
    if (movs.length === 0) { cont.innerHTML = '<p class="vacio">Escribe algo para buscar movimientos.</p>'; return; }

    movs.forEach(m => {
      const card = document.createElement("div");
      card.className = "movimiento-card mov-" + String(m.tipo).toLowerCase();
      if (m.estado === "CANCELADO") card.style.opacity = "0.5";
      card.innerHTML =
        '<div class="mov-header"><span class="mov-tipo">' + esc(m.tipo) + '</span><span class="mov-hora">' + esc(m.fecha) + ' ' + esc(m.hora) + '</span></div>' +
        '<div class="mov-codigo">' + esc(m.codigo_oar) + ' <small class="texto-suave">(' + esc(m.id) + ')</small></div>' +
        '<div class="mov-desc">' + esc(m.descripcion || '-') + '</div>' +
        '<div class="mov-cantidad">' + esc(m.cantidad) + ' ' + esc(m.unidad) + '</div>' +
        '<div class="mov-usuario">Lote insumo: <strong>' + esc(m.lote_insumo || 'SIN_LOTE') + '</strong></div>' +
        (m.lote_trabajo ? '<div class="mov-usuario">Lote trabajo: ' + esc(m.lote_trabajo) + '</div>' : '') +
        '<div class="mov-usuario">Registró: ' + esc(m.nombre_usuario || m.usuario) + ' (' + esc(m.rol) + ')</div>' +
        (m.estado === "CANCELADO" ? '<div class="mov-cancelado">CANCELADO</div>' : '');

      if (m.editable) {
        const btn = document.createElement("button");
        btn.className = "btn-editar-card";
        btn.textContent = "✏️ Editar";
        btn.addEventListener("click", () => abrirModalEditar(m));
        card.appendChild(btn);
      } else {
        const info = document.createElement("div");
        info.className = "texto-suave";
        info.textContent = "No editable (cancelado)";
        card.appendChild(info);
      }
      cont.appendChild(card);
    });
  }

  function abrirModalEditar(mov) {
    movimientoEnEdicion = mov;
    const fila = (etq, val) => '<div class="info-row"><span class="info-label">' + etq + '</span><span class="info-value">' + esc(val) + '</span></div>';
    $("editar-mov-info-original").innerHTML =
      fila("ID:", mov.id) + fila("Tipo:", mov.tipo) + fila("Código OAR:", mov.codigo_oar) +
      fila("Descripción:", mov.descripcion || "-") + fila("Unidad:", mov.unidad) +
      fila("Fecha original:", (mov.fecha || "") + " " + (mov.hora || ""));

    $("edit-cantidad").value = mov.cantidad;
    $("edit-lote-insumo").value = mov.lote_insumo || "";
    $("edit-lote-trabajo").value = mov.lote_trabajo || "";
    $("edit-ubicacion").value = mov.ubicacion || "";
    $("edit-proveedor").value = mov.proveedor_cliente || "";
    $("edit-pu").value = mov.pu || 0;
    $("edit-iva").value = mov.iva || 0;
    const esEnt = String(mov.tipo).toUpperCase() === "ENTRADA";
    $("edit-pu").disabled = !esEnt;
    $("edit-iva").disabled = !esEnt;
    $("edit-aviso-pu").classList.toggle("hidden", esEnt);
    $("edit-notas").value = mov.notas || "";
    $("edit-motivo").value = "";
    msg($("edit-status"), "");
    $("btn-guardar-edicion").disabled = false;
    $("modal-editar-mov").classList.remove("hidden");
  }

  function cerrarModalEditar() {
    movimientoEnEdicion = null;
    $("modal-editar-mov").classList.add("hidden");
  }

  async function guardarEdicion() {
    if (!movimientoEnEdicion) return;
    const statusEl = $("edit-status");
    const btn = $("btn-guardar-edicion");
    const cantidad = parseFloat($("edit-cantidad").value);
    const motivo = $("edit-motivo").value.trim();
    if (!cantidad || cantidad <= 0) return msg(statusEl, "Cantidad inválida", "error");
    if (!motivo) return msg(statusEl, "Escribe el motivo de la edición", "error");

    msg(statusEl, "Guardando edición...");
    btn.disabled = true;
    const resp = await api("editar_movimiento", {
      id_movimiento: movimientoEnEdicion.id,
      motivo: motivo,
      cantidad: cantidad,
      lote_insumo: $("edit-lote-insumo").value.trim(),
      lote_trabajo: $("edit-lote-trabajo").value.trim(),
      ubicacion: $("edit-ubicacion").value.trim(),
      proveedor_cliente: $("edit-proveedor").value.trim(),
      pu: parseFloat($("edit-pu").value) || 0,
      iva: parseFloat($("edit-iva").value) || 0,
      notas: $("edit-notas").value.trim(),
    }, "POST");

    if (!resp.ok) {
      btn.disabled = false;
      return msg(statusEl, "Error: " + (resp.error || "Desconocido"), "error");
    }
    msg(statusEl, "✅ " + resp.mensaje, "ok");

    setTimeout(() => {
      cerrarModalEditar();
      if (!$("view-editar-movs").classList.contains("hidden")) buscarMovimientosEditar();
      if (!$("view-dashboard").classList.contains("hidden")) cargarMovimientosDashboard();
      if (!$("view-lote-movs").classList.contains("hidden") && loteActivoEnVista) verMovimientosDeLote(loteActivoEnVista);
    }, 1200);
  }

  // ═══════════════════════════════════════════════════════════════
  // RECONSTRUIR STOCK (ADMIN)
  // ═══════════════════════════════════════════════════════════════

  async function reconstruirStockManual() {
    if (!confirm("¿Reconstruir el stock desde los movimientos?\n\nEsto recalcula STOCK_ACTUAL desde cero. Puede tardar unos segundos.")) return;
    cargando("Reconstruyendo stock...");
    const resp = await api("reconstruir_stock", {}, "POST");
    alert(resp.ok ? "✅ " + (resp.mensaje || "Stock reconstruido") : "Error: " + (resp.error || "Desconocido"));
    volverAlMenu();
  }


  // ═══════════════════════════════════════════════════════════════
  // IMPORTAR CCP DESDE LA APP (ADMIN) — misma lógica que importar_ccp.py
  // ═══════════════════════════════════════════════════════════════

  const CCP_HOJA = "ENT-SAL";
  const CCP_EXCLUIR = ["OBN", "EEG", "HABN", "NOM", "GPTBL", "ENERGIA", "CBRBCS", "MNTCRG", "MANTTO",
    "JVRSTPS", "CSRPC", "DLMPLMPZ", "KEYLMPZ", "FLTNSMS", "RNTNV", "RNTFC"];
  const CCP_MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };
  const NOMBRE_MES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  const CCP_LOTE = 50;
  let planImport = null, importando = false;

  function abrirImportar() {
    const hoy = new Date();
    $("imp-anio").value = hoy.getFullYear();
    $("imp-mes").innerHTML = NOMBRE_MES.map((m, i) => '<option value="' + (i + 1) + '">' + m + "</option>").join("");
    $("imp-mes").value = hoy.getMonth() + 1;
    ajustarPeriodo();
    planImport = null;
    $("imp-resumen").classList.add("hidden");
    $("btn-imp-importar").classList.add("hidden");
    $("imp-progreso").classList.add("hidden");
    $("imp-status-msg").textContent = "";
    mostrarVista("view-importar");
  }

  function ajustarPeriodo() {
    const p = $("imp-periodo").value;
    $("imp-mes-campo").classList.toggle("hidden", p !== "mes");
    $("imp-rango").classList.toggle("hidden", p !== "rango");
  }

  const dd2 = n => String(n).padStart(2, "0");
  const fmtFecha = d => dd2(d.getDate()) + "/" + dd2(d.getMonth() + 1) + "/" + d.getFullYear();
  const deInputFecha = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ""); return m ? m[3] + "/" + m[2] + "/" + m[1] : null; };
  const aNumFecha = f => { const p = f.split("/"); return Number(p[2]) * 10000 + Number(p[1]) * 100 + Number(p[0]); };

  // Igual que parsear_fecha_ccp del Python: fecha real de Excel o texto "15-ene-26"
  function fechaCCP(v) {
    if (v === null || v === undefined || v === "") return null;
    if (v instanceof Date && !isNaN(v)) return fmtFecha(v);
    const s = String(v).trim().toLowerCase();
    let m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/.exec(s);
    if (m) { const a = Number(m[3]); return dd2(m[1]) + "/" + dd2(m[2]) + "/" + (a < 100 ? 2000 + a : a); }
    m = /^(\d{1,2})[\/-]([a-zñ]{3})[a-zñ.]*[\/-](\d{2,4})$/.exec(s);
    if (m && CCP_MESES[m[2]]) { const a = Number(m[3]); return dd2(m[1]) + "/" + dd2(CCP_MESES[m[2]]) + "/" + (a < 100 ? 2000 + a : a); }
    return null;
  }
  function txt(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
    return String(v).trim();
  }
  function num(v) { const n = parseFloat(String(v === undefined || v === null ? "" : v).replace(/,/g, "")); return isNaN(n) ? 0 : n; }

  // El archivo se lee al elegirlo: si Excel u OneDrive lo cambian después, ya tenemos la copia
  let ccpBuffer = null, ccpNombre = "";
  async function tomarArchivoCCP() {
    ccpBuffer = null; ccpNombre = "";
    const archivo = $("imp-archivo").files[0];
    if (!archivo) return;
    try { ccpBuffer = await archivo.arrayBuffer(); ccpNombre = archivo.name; }
    catch (e) { msg($("imp-status-msg"), "❌ " + MSG_ARCHIVO_BLOQUEADO, "error"); }
  }
  const MSG_ARCHIVO_BLOQUEADO = "No se pudo leer el archivo: está abierto en Excel, se modificó después de elegirlo o OneDrive lo está sincronizando. " +
    "Ciérralo en Excel (si está en OneDrive: clic derecho → 'Mantener siempre en este dispositivo'), y vuelve a elegirlo.";

  async function leerCCP(archivo) {
    await cargarScript("xlsx.full.min.js");
    let buf = ccpBuffer && ccpNombre === archivo.name ? ccpBuffer : null;
    if (!buf) {
      try { buf = await archivo.arrayBuffer(); }
      catch (e) { throw new Error(MSG_ARCHIVO_BLOQUEADO); }
    }
    let wb;
    try { wb = XLSX.read(buf, { type: "array", cellDates: true }); }
    catch (e) {
      if (/password|encrypt|CFB|ECMA-376/i.test(e.message)) throw new Error("El archivo tiene contraseña. Guárdalo sin contraseña e intenta de nuevo.");
      throw new Error("No se pudo leer el Excel: " + e.message);
    }
    const hoja = wb.Sheets[CCP_HOJA] || wb.Sheets[wb.SheetNames.find(n => n.trim().toUpperCase() === CCP_HOJA)];
    if (!hoja) throw new Error("El archivo no tiene la hoja " + CCP_HOJA + ". Hojas: " + wb.SheetNames.join(", "));
    const filas = XLSX.utils.sheet_to_json(hoja, { defval: null, raw: true });
    // Encabezados sin espacios de más
    return filas.map(f => { const o = {}; Object.keys(f).forEach(k => o[k.trim().toUpperCase()] = f[k]); return o; });
  }

  function transformarCCP(filas, anio, desde, hasta, status) {
    const r = { registros: [], errores: 0, fuera: 0, otroAnio: 0, excluidos: 0, ejemplosError: [] };
    const nd = desde ? aNumFecha(desde) : null, nh = hasta ? aNumFecha(hasta) : null;
    filas.forEach((f, i) => {
      const err = motivo => { r.errores++; if (r.ejemplosError.length < 5) r.ejemplosError.push("Fila " + (i + 2) + ": " + motivo); };
      const fecha = fechaCCP(f["FECHA"]);
      if (!fecha) { if (Object.values(f).some(v => v !== null && v !== "")) err("fecha no válida"); return; }
      if (Number(fecha.split("/")[2]) !== anio) { r.otroAnio++; return; }
      const nf = aNumFecha(fecha);
      if ((nd && nf < nd) || (nh && nf > nh)) { r.fuera++; return; }
      const codigo = txt(f["CODIGO OAR"]);
      if (!codigo) return err("sin código OAR");
      if (CCP_EXCLUIR.includes(codigo.toUpperCase())) { r.excluidos++; return; }
      const mov = txt(f["MOVIMIENTO"]).toUpperCase();
      if (!["ENTRADA", "SALIDA", "DEVOLUCION"].includes(mov)) return err("movimiento '" + mov + "'");
      r.registros.push({
        fecha: fecha, tipo_movimiento: mov, codigo_oar: codigo,
        descripcion: txt(f["INSUMO / PT / REFACCION"]),
        lote_insumo: txt(f["LOTE INSUMO"]), lote_trabajo: txt(f["LOTE TRABAJO"]),
        status_lote: status === "RESPETAR" ? (txt(f["STATUS LOTE"]).toUpperCase() || "ABIERTO") : status,
        proveedor_cliente: txt(f["PROVEEDOR / CLIENTE"]), ubicacion: txt(f["UBICACION"]),
        unidad: txt(f["U DE M"]) || "KG", cantidad: num(f["CANTIDAD"]), pu: num(f["PU"]), iva: num(f["IVA"]),
        notas: "[CCP] " + txt(f["DOCTO"]),
        usuario: "importacion", nombre_usuario: "Importacion CCP", rol: "admin",
      });
    });
    return r;
  }

  function periodoElegido(anio) {
    const p = $("imp-periodo").value;
    if (p === "todo") return { desde: null, hasta: null, texto: "todo " + anio };
    if (p === "mes") {
      const m = Number($("imp-mes").value);
      const ult = new Date(anio, m, 0).getDate();
      return { desde: "01/" + dd2(m) + "/" + anio, hasta: dd2(ult) + "/" + dd2(m) + "/" + anio, texto: NOMBRE_MES[m - 1] + " " + anio };
    }
    const d = deInputFecha($("imp-desde").value), h = deInputFecha($("imp-hasta").value);
    if (!d || !h) throw new Error("Elige las fechas Desde y Hasta");
    if (aNumFecha(d) > aNumFecha(h)) throw new Error("La fecha Desde es posterior a Hasta");
    if (Number(d.split("/")[2]) !== anio || Number(h.split("/")[2]) !== anio) throw new Error("El rango debe estar dentro del año " + anio);
    return { desde: d, hasta: h, texto: d + " a " + h };
  }

  async function revisarImportacion() {
    const st = $("imp-status-msg");
    const res = $("imp-resumen");
    planImport = null;
    $("btn-imp-importar").classList.add("hidden");
    res.classList.add("hidden");
    try {
      const archivo = $("imp-archivo").files[0];
      if (!archivo) throw new Error("Elige el archivo Excel del CCP");
      const anio = Number($("imp-anio").value);
      if (!(anio >= 2020 && anio <= 2100)) throw new Error("Año no válido");
      const modo = $("imp-modo").value;
      const per = periodoElegido(anio);
      if (modo === "REEMPLAZAR_PERIODO" && !per.desde) throw new Error("'Reemplazar periodo' necesita un mes o un rango. Para todo el año usa 'Reemplazar todo el año'.");
      st.textContent = "Leyendo Excel..."; st.className = "send-status";
      const filas = await leerCCP(archivo);
      const t = transformarCCP(filas, anio, per.desde, per.hasta, $("imp-status").value);
      if (!t.registros.length) throw new Error("No hay movimientos de " + per.texto + " en el archivo." + (t.errores ? " (" + t.errores + " filas con error)" : ""));

      let borrar = null;
      if (modo === "REEMPLAZAR_PERIODO") {
        st.textContent = "Consultando lo que hay en el sistema...";
        borrar = await api("contar_movimientos_rango", { fecha_desde: per.desde, fecha_hasta: per.hasta }, "POST");
        if (!borrar.ok) throw new Error(borrar.error || "No se pudo consultar el periodo");
      }
      const porTipo = {}, porMes = {};
      t.registros.forEach(x => { porTipo[x.tipo_movimiento] = (porTipo[x.tipo_movimiento] || 0) + 1; const m = Number(x.fecha.split("/")[1]); porMes[m] = (porMes[m] || 0) + 1; });
      const li = o => Object.keys(o).map(k => "<li>" + esc(k) + ": <b>" + o[k] + "</b></li>").join("");
      let html = "<h3>Se van a importar " + t.registros.length + " movimientos (" + esc(per.texto) + ")</h3>" +
        "<div class='fila-2'><ul>" + li(porTipo) + "</ul><ul>" + Object.keys(porMes).map(m => "<li>" + NOMBRE_MES[m - 1] + ": <b>" + porMes[m] + "</b></li>").join("") + "</ul></div>";
      const notas = [];
      if (t.excluidos) notas.push(t.excluidos + " de códigos excluidos (energía, nómina, etc.)");
      if (t.fuera) notas.push(t.fuera + " fuera del periodo");
      if (t.otroAnio) notas.push(t.otroAnio + " de otro año");
      if (notas.length) html += "<p class='ayuda'>No se importan: " + esc(notas.join(" · ")) + "</p>";
      if (t.errores) html += "<p class='aviso-imp'>⚠️ " + t.errores + " filas con error se saltan:<br>" + t.ejemplosError.map(esc).join("<br>") + "</p>";
      if (modo === "REEMPLAZAR_PERIODO") {
        html += "<p class='aviso-imp'>🗑️ Se borrarán <b>" + (borrar.importados != null ? borrar.importados : borrar.total) + "</b> movimientos importados antes en ese periodo" +
          (borrar.se_conservan ? " y se <b>conservan " + borrar.se_conservan + "</b> registrados en la app" : "") + ". Se guarda un respaldo.</p>";
      } else if (modo === "REEMPLAZAR") {
        html += "<p class='aviso-imp'>🗑️ Se borrarán TODOS los movimientos importados de " + anio + " (los registrados en la app se conservan). Se guarda un respaldo.</p>";
      } else {
        html += "<p class='aviso-imp'>➕ No se borra nada. Ojo: si ya importaste este periodo, quedará duplicado.</p>";
      }
      html += "<p class='ayuda'>Al terminar se reconstruye el stock y se regeneran los lotes.</p>";
      res.innerHTML = html;
      res.classList.remove("hidden");
      planImport = { anio, modo, per, registros: t.registros, forzar: $("imp-status").value === "RESPETAR" ? null : $("imp-status").value };
      $("btn-imp-importar").classList.remove("hidden");
      st.textContent = "Revisa el resumen y, si está bien, pulsa Importar ahora."; st.className = "send-status ok";
    } catch (e) {
      st.textContent = "❌ " + e.message; st.className = "send-status error";
    }
  }

  async function ejecutarImportacion() {
    if (!planImport || importando) return;
    const p = planImport;
    const conf = prompt("Se importarán " + p.registros.length + " movimientos (" + p.per.texto + ", modo " + p.modo.replace("_", " ").toLowerCase() + ").\n\nEscribe CONFIRMAR para continuar:");
    if (conf === null || conf.trim().toUpperCase() !== "CONFIRMAR") return;
    const st = $("imp-status-msg"), barra = $("imp-barra");
    const paso = (t, pct) => { st.textContent = t; st.className = "send-status"; if (pct != null) barra.style.width = pct + "%"; };
    importando = true;
    $("btn-imp-importar").classList.add("hidden");
    $("btn-imp-revisar").disabled = true;
    $("imp-progreso").classList.remove("hidden");
    try {
      if (p.modo === "REEMPLAZAR_PERIODO") {
        paso("Borrando el periodo (con respaldo)...", 3);
        const r = await api("limpiar_movimientos_rango", { fecha_desde: p.per.desde, fecha_hasta: p.per.hasta }, "POST");
        if (!r.ok) throw new Error("Al borrar: " + (r.error || "error"));
      } else if (p.modo === "REEMPLAZAR") {
        paso("Borrando lo importado del año (con respaldo)...", 3);
        const r = await api("limpiar_movimientos", { anio: p.anio }, "POST");
        if (!r.ok) throw new Error("Al borrar: " + (r.error || "error"));
      }
      let insertados = 0;
      const total = p.registros.length;
      for (let i = 0; i < total; i += CCP_LOTE) {
        const lote = p.registros.slice(i, i + CCP_LOTE);
        paso("Importando " + Math.min(i + CCP_LOTE, total) + " de " + total + "...", 5 + Math.round(85 * i / total));
        let r = await api("importar_movimientos", { anio: p.anio, movimientos: lote, forzar_status: p.forzar || "" }, "POST");
        if (!r.ok && /ocupado|conexión/i.test(r.error || "")) {         // un reintento si el servidor estaba ocupado
          await new Promise(res => setTimeout(res, 3000));
          r = await api("importar_movimientos", { anio: p.anio, movimientos: lote, forzar_status: p.forzar || "" }, "POST");
        }
        if (!r.ok) throw new Error("Se detuvo en el movimiento " + (i + 1) + " de " + total + ": " + (r.error || "error") +
          ". Ya se importaron " + insertados + ". Repite la importación en modo 'Reemplazar periodo' para dejarlo completo.");
        insertados += r.insertados || 0;
      }
      paso("Reconstruyendo stock...", 92);
      const rs = await api("reconstruir_stock", {}, "POST");
      paso("Regenerando lotes...", 97);
      const rl = await api("generar_lotes", {}, "POST");
      barra.style.width = "100%";
      st.textContent = "✅ Importados " + insertados + " movimientos." +
        (rs.ok ? " Stock reconstruido." : " ⚠️ Stock: " + rs.error) + (rl.ok ? " Lotes al día." : " ⚠️ Lotes: " + rl.error);
      st.className = "send-status ok";
      planImport = null;
    } catch (e) {
      st.textContent = "❌ " + e.message; st.className = "send-status error";
    } finally {
      importando = false;
      $("btn-imp-revisar").disabled = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ABRIR LOTE
  // ═══════════════════════════════════════════════════════════════

  function abrirFormularioAbrirLote() {
    ["abrir-lote-numero", "abrir-lote-buscar", "abrir-lote-notas"].forEach(id => { $(id).value = ""; });
    $("abrir-lote-info").classList.add("hidden");
    $("abrir-lote-resultados").classList.add("hidden");
    msg($("abrir-lote-status"), "");
    $("abrir-lote-aviso").textContent = "";
    $("abrir-lote-aviso").className = "lote-status";
    $("btn-abrir-lote-guardar").disabled = false;
    loteSeleccionadoAbrir = null;
    mostrarVista("view-abrir-lote");
    enfocarSiLibre("abrir-lote-numero");
  }

  let validarLoteSeq = 0;
  async function validarNumeroLote() {
    const lote = $("abrir-lote-numero").value.trim();
    const aviso = $("abrir-lote-aviso");
    if (lote.length < 2) { aviso.textContent = ""; aviso.className = "lote-status"; return; }
    const seq = ++validarLoteSeq;
    const resp = await api("validar_lote", { lote: lote });
    if (seq !== validarLoteSeq) return;
    if (resp.ok && resp.existe) {
      if (resp.status === "ABIERTO") { aviso.textContent = "Este lote ya está ABIERTO"; aviso.className = "lote-status error"; }
      else { aviso.textContent = "Este lote ya existe (CERRADO). Se reabrirá."; aviso.className = "lote-status warning"; }
    } else if (resp.ok) {
      aviso.textContent = "Lote disponible";
      aviso.className = "lote-status ok";
    }
  }

  function buscarInsumoAbrirLote() {
    const q = $("abrir-lote-buscar").value.trim().toUpperCase();
    const res = $("abrir-lote-resultados");
    if (q.length < 2) { res.classList.add("hidden"); return; }
    pintarResultadosInsumo(res, filtrarCatalogo(q), seleccionarInsumoAbrirLote);
  }

  function seleccionarInsumoAbrirLote(insumo) {
    loteSeleccionadoAbrir = insumo;
    $("abrir-lote-buscar").value = insumo.codigo + " - " + insumo.descripcion;
    $("abrir-lote-resultados").classList.add("hidden");
    $("abrir-lote-codigo").textContent = insumo.codigo;
    $("abrir-lote-descripcion").textContent = insumo.descripcion;
    $("abrir-lote-info").classList.remove("hidden");
  }

  async function guardarAbrirLote() {
    const lote = $("abrir-lote-numero").value.trim();
    const st = $("abrir-lote-status");
    const btn = $("btn-abrir-lote-guardar");
    if (!lote) return msg(st, "Escribe el número de lote", "error");
    if (!loteSeleccionadoAbrir) return msg(st, "Selecciona un código OAR", "error");

    msg(st, "Abriendo lote...");
    btn.disabled = true;
    const resp = await api("abrir_lote", {
      lote: lote,
      codigo_oar: loteSeleccionadoAbrir.codigo,
      descripcion: loteSeleccionadoAbrir.descripcion,
      notas: $("abrir-lote-notas").value.trim(),
    }, "POST");
    if (!resp.ok) { btn.disabled = false; return msg(st, resp.error || "Error desconocido", "error"); }
    msg(st, resp.mensaje, "ok");
    setTimeout(() => { alert(resp.mensaje); volverAlMenu(); }, 600);
  }

  // ═══════════════════════════════════════════════════════════════
  // CERRAR LOTE
  // ═══════════════════════════════════════════════════════════════

  async function abrirFormularioCerrarLote() {
    ["cerrar-lote-buscar", "cerrar-lote-piezas", "cerrar-lote-kilos", "cerrar-lote-notas"].forEach(id => { $(id).value = ""; });
    ["cerrar-lote-resultados", "cerrar-lote-info", "cerrar-lote-resumen"].forEach(id => $(id).classList.add("hidden"));
    $("grupo-cerrar-piezas").style.display = "none";
    $("grupo-cerrar-kilos").style.display = "none";
    msg($("cerrar-lote-status"), "");
    $("btn-cerrar-lote-guardar").disabled = false;
    loteSeleccionadoCerrar = null;

    cargando("Cargando lotes abiertos...");
    const resp = await api("listar_lotes_abiertos");
    lotesCache = resp.ok ? (resp.lotes || []) : [];
    mostrarVista("view-cerrar-lote");
    enfocarSiLibre("cerrar-lote-buscar");
  }

  function buscarLoteCerrar() {
    const q = $("cerrar-lote-buscar").value.trim().toUpperCase();
    const res = $("cerrar-lote-resultados");
    if (q.length < 1) { res.classList.add("hidden"); return; }
    if (!lotesCache.length) {
      res.innerHTML = '<div class="resultado-vacio">No hay lotes abiertos</div>';
      res.classList.remove("hidden");
      return;
    }
    const filtrados = lotesCache.filter(l =>
      String(l.lote).toUpperCase().includes(q) ||
      String(l.codigo_oar).toUpperCase().includes(q) ||
      String(l.descripcion).toUpperCase().includes(q)
    ).slice(0, 20);

    if (filtrados.length === 0) {
      res.innerHTML = '<div class="resultado-vacio">No se encontró ese lote</div>';
    } else {
      res.innerHTML = "";
      filtrados.forEach(lote => {
        const div = document.createElement("div");
        div.className = "resultado-item";
        div.innerHTML =
          '<div class="resultado-codigo">' + esc(lote.lote) + '</div>' +
          '<div class="resultado-desc">' + esc(lote.codigo_oar) + ' - ' + esc(lote.descripcion) + '</div>' +
          '<div class="resultado-cat">' + esc(lote.fecha_apertura) + ' · ' + esc(lote.usuario_apertura) + '</div>';
        div.addEventListener("click", () => seleccionarLoteCerrar(lote));
        res.appendChild(div);
      });
    }
    res.classList.remove("hidden");
  }

  async function seleccionarLoteCerrar(lote) {
    loteSeleccionadoCerrar = lote;
    $("cerrar-lote-buscar").value = lote.lote + " - " + lote.descripcion;
    $("cerrar-lote-resultados").classList.add("hidden");
    $("cerrar-lote-lote").textContent = lote.lote;
    $("cerrar-lote-codigo").textContent = lote.codigo_oar;
    $("cerrar-lote-descripcion").textContent = lote.descripcion;
    $("cerrar-lote-unidad").textContent = lote.unidad || "KG";
    $("cerrar-lote-info").classList.remove("hidden");

    const esPz = lote.unidad === "PZ";
    $("grupo-cerrar-piezas").style.display = esPz ? "block" : "none";
    $("grupo-cerrar-kilos").style.display = esPz ? "none" : "block";

    const resp = await api("movimientos_lote", { lote: lote.lote });
    if (resp.ok) {
      $("cerrar-lote-total-movs").textContent = resp.total_movimientos;
      $("cerrar-lote-total-consumido").textContent = fmtNum(resp.resumen.total_unidades) + " " + (lote.unidad || "");
      $("cerrar-lote-resumen").classList.remove("hidden");
    }
  }

  async function guardarCerrarLote() {
    const st = $("cerrar-lote-status");
    const btn = $("btn-cerrar-lote-guardar");
    if (!loteSeleccionadoCerrar) return msg(st, "Busca y selecciona un lote", "error");

    const unidad = loteSeleccionadoCerrar.unidad || "KG";
    const piezas = parseFloat($("cerrar-lote-piezas").value) || 0;
    const kilos = parseFloat($("cerrar-lote-kilos").value) || 0;
    if (unidad === "PZ" && piezas <= 0) return msg(st, "Ingresa las piezas producidas", "error");
    if (unidad !== "PZ" && kilos <= 0) return msg(st, "Ingresa los kilos producidos", "error");

    msg(st, "Cerrando lote...");
    btn.disabled = true;
    const resp = await api("cerrar_lote", {
      lote: loteSeleccionadoCerrar.lote,
      piezas_producidas: piezas,
      kilos_producidos: kilos,
      notas: $("cerrar-lote-notas").value.trim(),
    }, "POST");
    if (!resp.ok) { btn.disabled = false; return msg(st, resp.error || "Error desconocido", "error"); }
    msg(st, resp.mensaje, "ok");
    setTimeout(() => {
      alert(resp.mensaje + "\n\nMovimientos actualizados: " + resp.movimientos_actualizados);
      volverAlMenu();
    }, 600);
  }

  // ═══════════════════════════════════════════════════════════════
  // VER LOTES
  // ═══════════════════════════════════════════════════════════════

  async function verLotes() {
    cargando("Cargando lotes...");
    const resp = await api("listar_lotes");
    if (!resp.ok) { alert("Error al cargar lotes: " + resp.error); return volverAlMenu(); }
    lotesTodosCache = resp.lotes || [];
    $("lotes-buscar").value = "";
    $("lotes-filtro-status").value = "TODOS";
    renderizarLotes(lotesTodosCache);
    mostrarVista("view-lotes");
  }

  function filtrarLotes() {
    const q = $("lotes-buscar").value.trim().toUpperCase();
    const st = $("lotes-filtro-status").value;
    let f = lotesTodosCache;
    if (st !== "TODOS") f = f.filter(l => l.status === st);
    if (q) f = f.filter(l =>
      String(l.lote).toUpperCase().includes(q) ||
      String(l.codigo_oar).toUpperCase().includes(q) ||
      String(l.descripcion).toUpperCase().includes(q)
    );
    renderizarLotes(f);
  }

  function chipLote(status) {
    return status === "ABIERTO"
      ? '<span class="chip chip-abierto">ABIERTO</span>'
      : '<span class="chip chip-cerrado">CERRADO</span>';
  }

  function renderizarLotes(items) {
    const cont = $("lista-lotes");
    $("lotes-resumen").innerHTML = tarjetasResumen([
      [items.length, "Total"],
      [items.filter(i => i.status === "ABIERTO").length, "Abiertos"],
      [items.filter(i => i.status === "CERRADO").length, "Cerrados"],
    ]);
    cont.innerHTML = "";
    if (items.length === 0) { cont.innerHTML = '<div class="stock-vacio">No hay lotes que coincidan</div>'; return; }

    items.forEach(lote => {
      const div = document.createElement("div");
      div.className = "stock-item " + (lote.status === "ABIERTO" ? "lote-abierto" : "lote-cerrado");
      div.innerHTML =
        '<div class="stock-item-header"><span class="stock-item-codigo">' + esc(lote.lote) + '</span>' + chipLote(lote.status) + '</div>' +
        '<div class="stock-item-desc">' + esc(lote.codigo_oar) + ' - ' + esc(lote.descripcion || '-') + '</div>' +
        '<div class="stock-item-info"><span>Apertura: <strong>' + esc(lote.fecha_apertura || '-') + '</strong> ' + esc(lote.usuario_apertura) + '</span></div>' +
        (lote.status === "CERRADO"
          ? '<div class="stock-item-info"><span>Cierre: <strong>' + esc(lote.fecha_cierre || '-') + '</strong> ' + esc(lote.usuario_cierre) + '</span></div>'
          : '');

      const acc = document.createElement("div");
      acc.className = "lote-acciones";
      const bVer = document.createElement("button");
      bVer.className = "btn-primary btn-chico";
      bVer.textContent = "👁 Ver movimientos";
      bVer.addEventListener("click", () => verMovimientosDeLote(lote));
      acc.appendChild(bVer);
      if (lote.status === "CERRADO" && esSupervisor()) {
        const bRe = document.createElement("button");
        bRe.className = "btn-primary btn-chico btn-verde";
        bRe.textContent = "🔓 Reabrir";
        bRe.addEventListener("click", () => reabrirLoteDesdeVista(lote));
        acc.appendChild(bRe);
      }
      div.appendChild(acc);
      cont.appendChild(div);
    });
  }

  async function reabrirLoteDesdeVista(lote) {
    if (!confirm("¿Reabrir el lote " + lote.lote + "?\n\nEsto lo pondrá en estado ABIERTO y permitirá editar sus movimientos.\n\nDeberás volver a cerrarlo cuando termines de corregir.")) return;
    cargando("Reabriendo lote...");
    const resp = await api("abrir_lote", {
      lote: lote.lote, codigo_oar: lote.codigo_oar, descripcion: lote.descripcion,
      notas: "[Reabierto desde Ver Lotes]",
    }, "POST");
    if (!resp.ok) { alert("Error al reabrir: " + (resp.error || "Desconocido")); return mostrarVista("view-lotes"); }
    alert("✅ " + (resp.mensaje || "Lote reabierto"));
    await verLotes();
  }

  async function verMovimientosDeLote(lote) {
    cargando("Cargando movimientos del lote...");
    loteActivoEnVista = lote;
    const resp = await api("movimientos_lote", { lote: lote.lote });
    if (!resp.ok) { alert("Error: " + resp.error); return mostrarVista("view-lotes"); }

    $("lote-movs-titulo").textContent = "📦 Lote: " + lote.lote;
    const fila = (etq, html) => '<div class="info-row"><span class="info-label">' + etq + '</span><span class="info-value">' + html + '</span></div>';
    $("lote-movs-info").innerHTML =
      fila("Lote:", esc(lote.lote) + " " + chipLote(lote.status)) +
      fila("Código OAR:", esc(lote.codigo_oar)) +
      fila("Descripción:", esc(lote.descripcion || "-")) +
      fila("Apertura:", esc(lote.fecha_apertura || "-") + " " + esc(lote.usuario_apertura)) +
      (lote.status === "CERRADO"
        ? fila("Cierre:", esc(lote.fecha_cierre || "-") + " " + esc(lote.usuario_cierre)) +
          fila("Producido:", esc(lote.piezas_producidas || 0) + " PZ / " + esc(lote.kilos_producidos || 0) + " KG")
        : "");

    const r = resp.resumen || {};
    $("lote-movs-resumen").innerHTML = tarjetasResumen([
      [resp.total_movimientos || 0, "Movimientos"], [r.entradas || 0, "Entradas"],
      [r.salidas || 0, "Salidas"], [r.devoluciones || 0, "Devoluciones"],
    ]);

    const cont = $("lista-lote-movs");
    cont.innerHTML = "";
    const movs = resp.movimientos || [];
    if (movs.length === 0) cont.innerHTML = '<p class="vacio">Este lote no tiene movimientos registrados.</p>';

    movs.sort((a, b) => (String(a.fecha) + " " + String(a.hora)).localeCompare(String(b.fecha) + " " + String(b.hora)));
    movs.forEach(m => {
      const card = document.createElement("div");
      card.className = "movimiento-card mov-" + String(m.tipo).toLowerCase();
      if (m.estado === "CANCELADO") card.style.opacity = "0.5";
      card.innerHTML =
        '<div class="mov-header"><span class="mov-tipo">' + esc(m.tipo) + '</span><span class="mov-hora">' + esc(m.fecha) + ' ' + esc(m.hora) + '</span></div>' +
        '<div class="mov-codigo">' + esc(m.codigo) + ' <small class="texto-suave">(' + esc(m.id) + ')</small></div>' +
        '<div class="mov-desc">' + esc(m.descripcion) + '</div>' +
        '<div class="mov-cantidad">' + esc(m.cantidad) + ' ' + esc(m.unidad) + '</div>' +
        (m.lote_insumo ? '<div class="mov-usuario">Lote insumo: ' + esc(m.lote_insumo) + '</div>' : '') +
        (m.estado === "CANCELADO" ? '<div class="mov-cancelado">CANCELADO</div>' : '');

      if (lote.status === "ABIERTO" && m.estado !== "CANCELADO" && esSupervisor()) {
        const b = document.createElement("button");
        b.className = "btn-editar-card";
        b.textContent = "✏️ Editar";
        // Ahora el servidor manda TODOS los campos, así que el modal ya no los borra
        b.addEventListener("click", () => abrirModalEditar({
          id: m.id, tipo: m.tipo, codigo_oar: m.codigo, descripcion: m.descripcion,
          cantidad: m.cantidad, unidad: m.unidad,
          lote_insumo: m.lote_insumo || "", lote_trabajo: m.lote_trabajo || lote.lote,
          ubicacion: m.ubicacion || "", proveedor_cliente: m.proveedor || "",
          pu: m.pu || 0, iva: m.iva || 0, notas: m.notas || "",
          fecha: m.fecha, hora: m.hora,
        }));
        card.appendChild(b);
      }
      cont.appendChild(card);
    });
    mostrarVista("view-lote-movs");
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTEO DE INVENTARIO (igual que Mantenimiento Mediese, pero por lote)
  // ═══════════════════════════════════════════════════════════════

  const conteo = { item: null, resumen: null, ubicaciones: [], lotes: [] };

  function difHtml(d) {
    const n = Number(d) || 0;
    if (n > 0) return '<span class="dif-pos">+' + esc(fmtNum(n)) + '</span>';
    if (n < 0) return '<span class="dif-neg">' + esc(fmtNum(n)) + '</span>';
    return '<span class="dif-cero">sin diferencia</span>';
  }

  async function abrirConteo() {
    cargando("Preparando conteo...");
    if (!catalogoCache) await cargarCatalogos();
    const ru = await api("listar_ubicaciones");
    conteo.ubicaciones = (ru.ok ? ru.ubicaciones : []).filter(u => u.tipo === "ALMACEN");
    const sel = $("conteo-ubicacion");
    sel.innerHTML = "";
    conteo.ubicaciones.forEach(u => sel.appendChild(new Option(u.nombre, u.codigo)));
    const ultima = leerLocal("ubicacion_conteo");
    if (ultima && conteo.ubicaciones.some(u => u.codigo === ultima)) sel.value = ultima;
    sel.onchange = () => { guardarLocal("ubicacion_conteo", sel.value); cerrarPanelConteo(); cargarResumenConteo(); };
    const buscar = $("conteo-buscar");
    buscar.value = "";
    buscar.oninput = renderResultadosConteo;
    $("conteo-resultados").innerHTML = "";
    cerrarPanelConteo();
    mostrarVista("view-conteo");
    cargarResumenConteo();
  }

  async function cargarResumenConteo() {
    const ubic = $("conteo-ubicacion").value;
    const lista = $("conteo-lista");
    lista.innerHTML = '<p class="vacio">Cargando...</p>';
    const r = await api("resumen_conteo", { ubicacion: ubic });
    if (ubic !== $("conteo-ubicacion").value) return;    // cambió mientras cargaba
    if (!r.ok) { lista.innerHTML = '<p class="vacio error">' + esc(r.error) + '</p>'; return; }
    conteo.resumen = r;
    renderResumenConteo();
  }

  const claveCL = (cod, lote) => sinAcentos(cod).replace(/\s+/g, "") + "|" + String(lote || "").toUpperCase();

  function renderResumenConteo() {
    const r = conteo.resumen;
    if (!r) return;
    const lista = $("conteo-lista");
    const contados = new Set(r.conteos.map(c => claveCL(c.codigo, c.lote)));
    lista.innerHTML = r.conteos.length ? "" : '<p class="vacio">Todavía no hay nada contado hoy en esta ubicación.</p>';
    r.conteos.forEach(c => {
      const d = document.createElement("div");
      d.className = "item-toque";
      d.innerHTML =
        '<div><span class="cod">' + esc(c.codigo) + '</span>' + (c.lote ? ' · ' + esc(c.lote) : '') +
        ' · <b>' + esc(fmtNum(c.cantidad)) + ' ' + esc(c.unidad) + '</b> · ' + difHtml(c.diferencia) + '</div>' +
        '<div class="sub">' + esc(c.descripcion) + '</div>' +
        '<div class="sub">' + esc(c.hora.slice(0, 5)) + ' · ' + esc(c.nombre_usuario || c.usuario) + ' · ' + esc(c.estado.toLowerCase()) + '</div>';
      d.onclick = () => { const p = insumoPorCodigo(c.codigo); if (p) seleccionarInsumoConteo(p, c.lote); };
      lista.appendChild(d);
    });

    const faltan = r.sistema.filter(x => !contados.has(claveCL(x.codigo, x.lote)));
    $("conteo-faltan-n").textContent = faltan.length;
    const total = r.sistema.length + r.conteos.filter(c => !r.sistema.some(x => claveCL(x.codigo, x.lote) === claveCL(c.codigo, c.lote))).length;
    $("conteo-avance").textContent = total ? "(" + r.conteos.length + " de " + total + ")" : "";
    const cf = $("conteo-faltan");
    cf.innerHTML = faltan.length ? "" : '<p class="vacio">Nada pendiente. 👍</p>';
    faltan.forEach(x => {
      const d = document.createElement("div");
      d.className = "item-toque";
      d.innerHTML = '<div><span class="cod">' + esc(x.codigo) + '</span>' + (x.lote ? ' · ' + esc(x.lote) : '') +
        ' · sistema: ' + esc(fmtNum(x.saldo)) + ' ' + esc(x.unidad) + '</div><div class="sub">' + esc(x.descripcion) + '</div>';
      d.onclick = () => { const p = insumoPorCodigo(x.codigo); if (p) seleccionarInsumoConteo(p, x.lote); };
      cf.appendChild(d);
    });
  }

  function renderResultadosConteo() {
    const q = $("conteo-buscar").value;
    const cont = $("conteo-resultados");
    cont.innerHTML = "";
    if (!palabras(q).length) return;
    const res = buscarEnCatalogo(q, 8);
    if (!res.length) { cont.innerHTML = '<p class="vacio">No encontré ese insumo en el catálogo.</p>'; return; }
    res.forEach(p => {
      const d = document.createElement("div");
      d.className = "item-toque";
      d.innerHTML = '<div class="cod">' + esc(p.codigo) + '</div><div class="sub">' + esc(p.descripcion) + '</div>';
      d.onclick = () => seleccionarInsumoConteo(p, "");
      cont.appendChild(d);
    });
  }

  async function seleccionarInsumoConteo(p, lotePreferido) {
    conteo.item = p;
    marcarReciente(p.codigo);
    $("conteo-codigo").textContent = p.codigo;
    $("conteo-desc").textContent = p.descripcion;
    $("conteo-unidad").textContent = p.unidad || "";
    $("conteo-cantidad").value = "";
    $("conteo-notas").value = "";
    msg($("conteo-status"), "");
    $("conteo-buscador").classList.add("hidden");
    $("conteo-panel").classList.remove("hidden");

    const sel = $("conteo-lote");
    sel.innerHTML = '<option value="">Cargando lotes...</option>';
    const r = await api("lotes_disponibles", { codigo: p.codigo });
    conteo.lotes = r.ok ? r.lotes : [];
    sel.innerHTML = "";
    conteo.lotes.forEach(l => sel.appendChild(new Option(l.lote + " · sistema " + fmtNum(l.saldo) + " " + (l.unidad || p.unidad), l.lote)));
    sel.appendChild(new Option(conteo.lotes.length ? "Otro lote (no aparece)..." : "Sin lote / lote nuevo...", "__OTRO__"));
    if (lotePreferido) {
      const o = Array.from(sel.options).find(x => x.value.toUpperCase() === String(lotePreferido).toUpperCase());
      if (o) sel.value = o.value;
      else { sel.value = "__OTRO__"; $("conteo-lote-otro").value = lotePreferido; }
    }
    sel.onchange = actualizarLoteConteo;
    actualizarLoteConteo();
    $("conteo-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => $("conteo-cantidad").focus(), 250);
  }

  function loteConteoActual() {
    const v = $("conteo-lote").value;
    return v === "__OTRO__" ? $("conteo-lote-otro").value.trim().toUpperCase() : v;
  }

  function actualizarLoteConteo() {
    const otro = $("conteo-lote").value === "__OTRO__";
    $("conteo-lote-otro").classList.toggle("hidden", !otro);
    const lote = loteConteoActual();
    const enSis = conteo.lotes.find(l => l.lote === lote);
    const ya = conteo.resumen && conteo.resumen.conteos.find(c => conteo.item && claveCL(c.codigo, c.lote) === claveCL(conteo.item.codigo, lote));
    $("conteo-info").textContent = "En sistema: " + fmtNum(enSis ? enSis.saldo : 0) + " " + (conteo.item.unidad || "") +
      (ya ? "  ·  Hoy ya contaste " + fmtNum(ya.cantidad) + " (se corregirá)" : "");
  }

  function cerrarPanelConteo() {
    conteo.item = null;
    $("conteo-panel").classList.add("hidden");
    $("conteo-buscador").classList.remove("hidden");
  }

  function ajustarCantidad(delta) {
    const inp = $("conteo-cantidad");
    inp.value = Math.round(Math.max(0, (Number(inp.value) || 0) + delta) * 1000) / 1000;
  }

  async function guardarConteo() {
    const st = $("conteo-status");
    const p = conteo.item;
    if (!p) return;
    const txt = $("conteo-cantidad").value;
    const cant = Number(txt);
    if (txt === "" || !isFinite(cant) || cant < 0) return msg(st, "❌ Escribe cuánto hay (0 si no hay nada)", "error");
    const lote = loteConteoActual();
    if ($("conteo-lote").value === "__OTRO__" && !lote && conteo.lotes.length) return msg(st, "❌ Escribe el lote", "error");
    if (cant === 0 && !confirm("¿Confirmas que NO hay nada de " + p.codigo + (lote ? " lote " + lote : "") + " en esta ubicación?")) return;

    const btn = $("btn-conteo-guardar");
    btn.disabled = true;
    msg(st, "Guardando...");
    try {
      const r = await api("registrar_conteo", {
        ubicacion: $("conteo-ubicacion").value, codigo: p.codigo, lote: lote,
        cantidad: cant, notas: $("conteo-notas").value.trim(),
      }, "POST");
      if (!r.ok) return msg(st, "❌ " + r.error, "error");
      vibrar(60);
      $("conteo-buscar").value = "";
      $("conteo-resultados").innerHTML = '<div class="aviso-ok">✅ ' + esc(p.codigo) + (r.lote ? ' · ' + esc(r.lote) : '') + ': ' +
        esc(fmtNum(r.cantidad)) + ' ' + esc(r.unidad) + ' · ' + difHtml(r.diferencia) + (r.corregido ? ' (corregido)' : '') + '</div>';
      cerrarPanelConteo();
      cargarResumenConteo();
    } finally {
      btn.disabled = false;
    }
  }

  async function escanearEnConteo() {
    const txt = await escanearQR("Apunta a la etiqueta del lote o de la ubicación");
    if (!txt) return;
    const q = interpretarQR(txt);
    if (q.tipo === "ubicacion") return cambiarUbicacionConteo(q.valor);
    const p = insumoPorCodigo(q.codigo);
    if (!p) return alert("Esa etiqueta no corresponde a un insumo activo: " + q.codigo);
    seleccionarInsumoConteo(p, q.lote);
  }

  async function escanearUbicacionConteo() {
    const txt = await escanearQR("Apunta a la etiqueta de la ubicación");
    if (!txt) return;
    const q = interpretarQR(txt);
    if (q.tipo !== "ubicacion") return alert("Esa no es una etiqueta de ubicación.");
    cambiarUbicacionConteo(q.valor);
  }

  function cambiarUbicacionConteo(codigo) {
    const u = conteo.ubicaciones.find(x => x.codigo === String(codigo).toUpperCase());
    if (!u) return alert("Ubicación no registrada: " + codigo);
    $("conteo-ubicacion").value = u.codigo;
    guardarLocal("ubicacion_conteo", u.codigo);
    cerrarPanelConteo();
    cargarResumenConteo();
  }

  // ── Revisión de conteos (supervisor) ──

  async function actualizarBadgeConteos() {
    const r = await api("listar_conteos", { estado: "PENDIENTE" });
    const b = $("badge-conteos");
    if (!b || !r.ok) return;
    b.textContent = r.pendientes ? String(r.pendientes) : "";
    b.classList.toggle("hidden", !r.pendientes);
  }

  async function verConteos() {
    cargando("Cargando conteos...");
    const r = await api("listar_conteos", { estado: "PENDIENTE" });
    if (!r.ok) { alert("Error: " + r.error); return volverAlMenu(); }
    const cont = $("lista-conteos");
    cont.innerHTML = r.conteos.length ? "" : '<p class="vacio">✅ No hay conteos por aplicar.</p>';
    $("conteos-acciones").classList.toggle("hidden", !r.conteos.length);
    r.conteos.forEach(c => {
      const d = document.createElement("label");
      d.className = "item-toque check-fila";
      d.innerHTML = '<input type="checkbox" class="chk-conteo" value="' + esc(c.id) + '"' + (c.diferencia === 0 ? " checked" : "") + '>' +
        '<div style="flex:1">' +
        '<div><span class="cod">' + esc(c.codigo) + '</span>' + (c.lote ? ' · ' + esc(c.lote) : '') + ' · ' + esc(c.ubicacion) + '</div>' +
        '<div class="sub">' + esc(c.descripcion) + '</div>' +
        '<div>Contado <b>' + esc(fmtNum(c.cantidad)) + '</b> · sistema ' + esc(fmtNum(c.saldo_sistema)) + ' ' + esc(c.unidad) + ' · ' + difHtml(c.diferencia) + '</div>' +
        '<div class="sub">' + esc(c.fecha) + ' ' + esc(c.hora.slice(0, 5)) + ' · ' + esc(c.nombre_usuario || c.usuario) + '</div>' +
        (c.notas ? '<div class="sub">📝 ' + esc(c.notas) + '</div>' : '') + '</div>';
      cont.appendChild(d);
    });
    mostrarVista("view-conteos");
  }

  async function accionConteos(accion) {
    const ids = Array.from(document.querySelectorAll(".chk-conteo:checked")).map(c => c.value);
    if (!ids.length) return alert("Selecciona al menos un conteo.");
    if (accion === "aplicar") {
      if (!confirm("¿Aplicar " + ids.length + " conteo(s)?\n\nEl stock de cada lote quedará igual a lo contado (se crea un movimiento de ajuste).")) return;
      const r = await api("aplicar_conteos", { ids: ids }, "POST");
      alert(r.ok ? "✅ " + r.mensaje : "Error: " + r.error);
    } else {
      if (!confirm("¿Descartar " + ids.length + " conteo(s)? No se moverá el stock.")) return;
      const r = await api("descartar_conteos", { ids: ids }, "POST");
      if (!r.ok) alert("Error: " + r.error);
    }
    verConteos();
  }

  // ═══════════════════════════════════════════════════════════════
  // ETIQUETAS QR (lotes, insumos y ubicaciones)
  // ═══════════════════════════════════════════════════════════════

  const etiquetas = { modo: "lotes", seleccion: new Set(), lotes: [], ubicaciones: [] };

  async function verEtiquetas() {
    cargando("Cargando...");
    if (!catalogoCache) await cargarCatalogos();
    const [rs, ru] = await Promise.all([api("listar_stock"), api("listar_ubicaciones")]);
    etiquetas.lotes = (rs.ok ? rs.items : []).filter(i => i.saldo > 0 && i.lote && i.lote !== "SIN_LOTE");
    etiquetas.ubicaciones = ru.ok ? ru.ubicaciones : [];
    $("et-buscar").value = "";
    $("et-buscar").oninput = renderEtiquetas;
    $("et-copias").value = "1";
    document.querySelectorAll("#et-tabs [data-modo]").forEach(b => { b.onclick = () => cambiarModoEtiquetas(b.dataset.modo); });
    $("et-todas").onchange = (e) => {
      itemsEtiquetasVisibles().forEach(it => { if (e.target.checked) etiquetas.seleccion.add(it.qr); else etiquetas.seleccion.delete(it.qr); });
      renderEtiquetas();
    };
    cambiarModoEtiquetas("lotes");
    mostrarVista("view-etiquetas");
  }

  function cambiarModoEtiquetas(modo) {
    etiquetas.modo = modo;
    etiquetas.seleccion = new Set();
    document.querySelectorAll("#et-tabs [data-modo]").forEach(b => b.classList.toggle("activo", b.dataset.modo === modo));
    renderEtiquetas();
  }

  // Lista uniforme: { qr, titulo, sub, extra }
  function itemsEtiquetasTodos() {
    if (etiquetas.modo === "ubicaciones") {
      return etiquetas.ubicaciones.map(u => ({ qr: "UBI:" + u.codigo, titulo: u.codigo, sub: u.nombre, extra: "Ubicación" }));
    }
    if (etiquetas.modo === "insumos") {
      return (catalogoCache || []).map(i => ({ qr: "ALM|" + i.codigo, titulo: i.codigo, sub: i.descripcion, extra: [i.unidad, i.ubicacion].filter(Boolean).join(" · ") }));
    }
    return etiquetas.lotes.map(l => ({
      qr: "ALM|" + l.codigo + "|" + l.lote, titulo: l.codigo, sub: l.descripcion,
      extra: "LOTE " + l.lote + (l.primera_entrada ? " · Entrada " + l.primera_entrada : ""),
    }));
  }

  function itemsEtiquetasVisibles() {
    const ws = palabras($("et-buscar").value);
    return itemsEtiquetasTodos().filter(it => {
      const t = plano(it.titulo + " " + it.sub + " " + it.extra);
      return ws.every(w => variantes(w).some(v => t.includes(v)));
    });
  }

  function renderEtiquetas() {
    const items = itemsEtiquetasVisibles();
    const cont = $("lista-etiquetas");
    cont.innerHTML = items.length ? "" : '<p class="vacio">No hay nada con ese filtro.</p>';
    items.slice(0, 300).forEach(it => {
      const d = document.createElement("label");
      d.className = "item-toque check-fila";
      d.innerHTML = '<input type="checkbox"' + (etiquetas.seleccion.has(it.qr) ? " checked" : "") + '>' +
        '<div><div class="cod">' + esc(it.titulo) + '</div><div class="sub">' + esc(it.sub) + '</div><div class="sub">' + esc(it.extra) + '</div></div>';
      d.querySelector("input").onchange = (e) => {
        if (e.target.checked) etiquetas.seleccion.add(it.qr); else etiquetas.seleccion.delete(it.qr);
        actualizarBotonImprimir();
      };
      cont.appendChild(d);
    });
    if (items.length > 300) cont.insertAdjacentHTML("beforeend", '<p class="vacio">Mostrando 300 de ' + items.length + '. Filtra para ver otras.</p>');
    $("et-todas").checked = items.length > 0 && items.every(it => etiquetas.seleccion.has(it.qr));
    actualizarBotonImprimir();
  }

  function actualizarBotonImprimir() {
    $("btn-imprimir-etiquetas").textContent = "🖨️ Imprimir (" + etiquetas.seleccion.size + ")";
  }

  function imprimirEtiquetas() {
    const items = itemsEtiquetasTodos().filter(it => etiquetas.seleccion.has(it.qr));
    if (!items.length) return alert("Selecciona al menos una etiqueta.");
    abrirHojaEtiquetas(items, Math.max(1, Math.min(50, parseInt($("et-copias").value, 10) || 1)));
  }

  function imprimirEtiquetaEntrada() {
    const e = ultimaEntrada;
    if (!e || !e.lote) return;
    const copias = prompt("¿Cuántas etiquetas del lote " + e.lote + "?\n(una por saco, caja o tarima)", "1");
    if (copias === null) return;
    abrirHojaEtiquetas([{
      qr: "ALM|" + e.codigo + "|" + e.lote, titulo: e.codigo, sub: e.descripcion,
      extra: "LOTE " + e.lote + " · Entrada " + (e.fecha || ""),
    }], Math.max(1, Math.min(200, parseInt(copias, 10) || 1)));
  }

  async function abrirHojaEtiquetas(items, copias) {
    const w = window.open("", "_blank");
    if (!w) return alert("Permite las ventanas emergentes de este sitio para imprimir.");
    try { await cargarScript("qrcode.min.js"); }
    catch (e) { w.close(); return alert("No se pudo cargar el generador de QR. Revisa tu conexión."); }

    const una = it => {
      const q = window.qrcode(0, "M");
      q.addData(it.qr);
      q.make();
      return '<div class="et"><div class="qr">' + q.createSvgTag({ cellSize: 3, margin: 0, scalable: true }) + '</div>' +
        '<div class="tx"><div class="cod">' + esc(it.titulo) + '</div><div class="desc">' + esc(it.sub) + '</div>' +
        '<div class="ext">' + esc(it.extra) + '</div></div></div>';
    };
    const html = items.map(it => una(it).repeat(copias)).join("");
    const total = items.length * copias;
    w.document.write("<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
      "<title>Etiquetas QR - Almacén Mediese</title><style>" +
      "@page{size:letter;margin:10mm} body{font-family:Arial,Helvetica,sans-serif;margin:0;color:#000}" +
      ".barra{padding:10px;background:#f1f5f9;font-size:14px} .barra button{font-size:16px;padding:8px 16px;margin-right:8px}" +
      ".hoja{display:grid;grid-template-columns:repeat(3,62mm);gap:3mm 4mm;padding:2mm}" +
      ".et{height:32mm;border:1px dashed #999;display:flex;gap:2mm;padding:2mm;box-sizing:border-box;overflow:hidden;break-inside:avoid;page-break-inside:avoid}" +
      ".qr{width:27mm;height:27mm;flex:none} .qr svg{width:100%;height:100%;display:block}" +
      ".tx{min-width:0} .cod{font-weight:bold;font-size:11pt;word-break:break-all} .desc{font-size:7.5pt;line-height:1.15;max-height:14mm;overflow:hidden;margin-top:1mm}" +
      ".ext{font-size:8pt;font-weight:bold;margin-top:1mm} @media print{.barra{display:none} .et{border-color:#ddd}}" +
      "</style></head><body><div class='barra'><button onclick='window.print()'>🖨️ Imprimir</button>" + total +
      " etiquetas · Papel carta, escala 100%</div><div class='hoja'>" + html + "</div></body></html>");
    w.document.close();
  }

  // ═══════════════════════════════════════════════════════════════
  // ALERTAS (supervisor): stock negativo aceptado de Visor Tarimas, etc.
  // ═══════════════════════════════════════════════════════════════

  async function actualizarBadgeAlertas() {
    const r = await api("listar_alertas");
    const b = $("badge-alertas");
    if (!b || !r.ok) return;
    b.textContent = r.pendientes ? String(r.pendientes) : "";
    b.classList.toggle("hidden", !r.pendientes);
  }

  async function verAlertas() {
    cargando("Cargando alertas...");
    const r = await api("listar_alertas");
    if (!r.ok) { alert("Error: " + r.error); return volverAlMenu(); }
    const cont = $("lista-alertas");
    cont.innerHTML = "";
    if (!r.alertas.length) cont.innerHTML = '<p class="vacio">✅ No hay alertas pendientes.</p>';
    r.alertas.forEach(a => {
      const d = document.createElement("div");
      d.className = "stock-item stock-negativo";
      d.innerHTML =
        '<div class="stock-item-header"><span class="stock-item-codigo">' + esc(a.codigo) + ' · ' + esc(a.lote) + '</span>' +
          '<span class="stock-item-saldo">' + fmtNum(a.saldo) + '</span></div>' +
        '<div class="stock-item-desc">' + esc(a.detalle) + '</div>' +
        '<div class="stock-item-info"><span>' + esc(a.fecha) + ' ' + esc(a.hora) + '</span><span>' + esc(a.id_movimiento) + '</span></div>';
      const b = document.createElement("button");
      b.className = "btn-primary btn-chico btn-verde";
      b.textContent = "✔️ Marcar revisada";
      b.onclick = async () => {
        const nota = prompt("¿Qué se hizo? (ej. se corrigió con conteo, se dio entrada faltante)");
        if (nota === null) return;
        const m = await api("marcar_alerta", { id_alerta: a.id, nota: nota }, "POST");
        if (!m.ok) return alert("Error: " + m.error);
        verAlertas();
      };
      const acc = document.createElement("div");
      acc.className = "lote-acciones";
      acc.appendChild(b);
      d.appendChild(acc);
      cont.appendChild(d);
    });
    mostrarVista("view-alertas");
  }

  // ═══════════════════════════════════════════════════════════════
  // USUARIOS (admin)  — igual que Mantenimiento Mediese
  // ═══════════════════════════════════════════════════════════════

  async function verUsuarios() {
    cargando("Cargando usuarios...");
    const r = await api("listar_usuarios");
    if (!r.ok) { alert("Error: " + r.error); return volverAlMenu(); }
    usuariosCache = r.usuarios;
    renderUsuarios(r.usuarios);
    mostrarVista("view-usuarios");
  }

  function renderUsuarios(items) {
    const cont = $("lista-usuarios");
    cont.innerHTML = "";
    items.forEach(x => {
      const yo = x.usuario === usuarioActual.user;
      const d = document.createElement("div");
      d.className = "stock-item";
      if (!x.activo) d.style.opacity = "0.55";
      d.innerHTML =
        '<div class="stock-item-header"><span class="stock-item-codigo">' + esc(x.usuario) + (yo ? " (tú)" : "") + '</span>' +
          '<span class="chip ' + (x.activo ? 'chip-abierto">ACTIVO' : 'chip-cerrado">INACTIVO') + '</span></div>' +
        '<div class="stock-item-desc">' + esc(x.nombre) + ' · ' + esc(NOMBRE_ROL[x.rol] || x.rol) + '</div>' +
        '<div class="stock-item-info"><span>Último acceso: ' + esc(x.ultimo_acceso || "nunca") + '</span>' +
          (x.tiene_password ? '' : '<span class="error">Sin contraseña</span>') + '</div>';
      const acc = document.createElement("div");
      acc.className = "lote-acciones";
      const boton = (txt, fn, clase) => {
        const b = document.createElement("button");
        b.className = "btn-secondary btn-chico" + (clase ? " " + clase : "");
        b.textContent = txt;
        b.onclick = fn;
        acc.appendChild(b);
      };
      boton("✏️ Editar", () => abrirFormUsuario(x.usuario));
      boton("🔑 Restablecer contraseña", () => abrirPassword(x.usuario));
      if (!yo) boton(x.activo ? "🚫 Desactivar" : "✅ Activar", () => activarUsuario(x.usuario, !x.activo), x.activo ? "texto-rojo" : "");
      d.appendChild(acc);
      cont.appendChild(d);
    });
  }

  function abrirFormUsuario(usuario) {
    const u = usuario ? usuariosCache.find(x => x.usuario === usuario) : null;
    $("usuario-form-modo").value = u ? "editar" : "crear";
    $("usuario-form-titulo").textContent = u ? "✏️ Editar usuario" : "👤 Nuevo usuario";
    $("usuario-form-usuario").value = u ? u.usuario : "";
    $("usuario-form-usuario").disabled = !!u;
    $("usuario-form-nombre").value = u ? u.nombre : "";
    $("usuario-form-rol").value = u ? u.rol : "almacenista";
    $("usuario-form-rol").disabled = !!u && u.usuario === usuarioActual.user;
    $("usuario-form-grupo-pass").classList.toggle("hidden", !!u);
    $("usuario-form-pass1").value = "";
    $("usuario-form-pass2").value = "";
    msg($("usuario-form-status"), "");
    mostrarVista("view-usuario-form");
  }

  async function guardarUsuario() {
    const st = $("usuario-form-status");
    const modo = $("usuario-form-modo").value;
    const usuario = $("usuario-form-usuario").value.trim().toLowerCase();
    const nombre = $("usuario-form-nombre").value.trim();
    const rol = $("usuario-form-rol").value;
    if (!nombre) return msg(st, "❌ Nombre obligatorio", "error");

    const btn = $("btn-guardar-usuario");
    btn.disabled = true;
    try {
      let r;
      if (modo === "crear") {
        if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) return msg(st, "❌ Usuario: mínimo 3 caracteres, sin espacios ni acentos", "error");
        msg(st, "Protegiendo contraseña...");
        const p = await prepararPassword($("usuario-form-pass1").value, $("usuario-form-pass2").value);
        if (p.error) return msg(st, "❌ " + p.error, "error");
        r = await api("crear_usuario", { nuevo_usuario: usuario, nombre: nombre, nuevo_rol: rol, salt: p.salt, hash: p.hash }, "POST");
      } else {
        msg(st, "Guardando...");
        r = await api("editar_usuario", { objetivo: usuario, nombre: nombre, nuevo_rol: rol }, "POST");
      }
      if (!r.ok) return msg(st, "❌ " + r.error, "error");
      msg(st, "✅ " + r.mensaje, "ok");
      setTimeout(verUsuarios, 1000);
    } finally {
      btn.disabled = false;
    }
  }

  async function activarUsuario(usuario, activar) {
    if (!activar && !confirm("¿Desactivar a " + usuario + "?\n\nNo podrá entrar y se cerrará su sesión. Su historial se conserva.")) return;
    const r = await api("activar_usuario", { objetivo: usuario, activo: activar }, "POST");
    if (!r.ok) return alert("Error: " + r.error);
    verUsuarios();
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTRASEÑA: la propia, o restablecer la de otro (admin)
  // ═══════════════════════════════════════════════════════════════

  function abrirPassword(objetivo) {
    const propia = !objetivo;
    $("pass-objetivo").value = objetivo || "";
    $("pass-titulo").textContent = propia ? "🔑 Cambiar mi contraseña" : "🔑 Restablecer contraseña de " + objetivo;
    $("pass-grupo-actual").classList.toggle("hidden", !propia);
    ["pass-actual", "pass-nueva1", "pass-nueva2"].forEach(id => { $(id).value = ""; });
    msg($("pass-status"), "");
    $("btn-pass-cancelar").onclick = () => (propia ? volverAlMenu() : verUsuarios());
    $("btn-cerrar-password").onclick = $("btn-pass-cancelar").onclick;
    mostrarVista("view-password");
  }

  async function guardarPassword() {
    const st = $("pass-status");
    const objetivo = $("pass-objetivo").value;
    const btn = $("btn-guardar-pass");
    btn.disabled = true;
    try {
      msg(st, "Protegiendo contraseña...");
      const p = await prepararPassword($("pass-nueva1").value, $("pass-nueva2").value);
      if (p.error) return msg(st, "❌ " + p.error, "error");

      let r;
      if (!objetivo) {
        const actual = $("pass-actual").value;
        if (!actual) return msg(st, "❌ Escribe tu contraseña actual", "error");
        const s = await api("obtener_salt", { usuario: usuarioActual.user });
        if (!s.ok) return msg(st, "❌ No se pudo conectar", "error");
        const hashActual = await pbkdf2Hash(actual, s.salt);
        r = await api("cambiar_mi_password", { hash_actual: hashActual, salt: p.salt, hash: p.hash }, "POST");
      } else {
        r = await api("restablecer_password", { objetivo: objetivo, salt: p.salt, hash: p.hash }, "POST");
      }
      if (!r.ok) return msg(st, "❌ " + r.error, "error");
      ["pass-actual", "pass-nueva1", "pass-nueva2"].forEach(id => { $(id).value = ""; });

      // Si cambió la propia, sus sesiones se cerraron: volver a entrar
      if (!objetivo || objetivo === usuarioActual.user) {
        alert("✅ " + r.mensaje);
        clearSession();
        window.location.href = "index.html";
        return;
      }
      msg(st, "✅ " + r.mensaje, "ok");
      setTimeout(verUsuarios, 1200);
    } finally {
      btn.disabled = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════════════════

  return { initLogin, initApp, volverAlMenu };

})();
