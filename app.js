// ═══════════════════════════════════════════════════════════════════
// ALMACÉN MEDIESE - LÓGICA DE LA PWA
// Login + Registro + Dashboard (Supervisor/Gerencia)
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  APPS_SCRIPT_URL: `https://script.google.com/macros/s/AKfycbyXlL6k2nKTvquNm1G25r35RXH2LO1raFMxRqAQ5JlazN0oodWtVY_rEpYMuGc0rifpmw/exec`,
  SESSION_KEY: "almacen_mediese_session",
  ITERACIONES: 100000
};

const App = (() => {

  let usuarioActual = null;
  let tipoMovimientoActual = null;
  let insumoSeleccionado = null;
  let catalogoCache = null;
  let dcsCache = null;


  // ═══════════════════════════════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════════════════════════════

  function getSession() {
    const s = localStorage.getItem(CONFIG.SESSION_KEY);
    return s ? JSON.parse(s) : null;
  }

  function setSession(d) {
    localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(d));
  }

  function clearSession() {
    localStorage.removeItem(CONFIG.SESSION_KEY);
  }

  async function pbkdf2Hash(password, saltHex) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
    );
    const saltBytes = new Uint8Array(
      saltHex.match(/.{1,2}/g).map(b => parseInt(b, 16))
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: saltBytes, iterations: CONFIG.ITERACIONES, hash: "SHA-256" },
      keyMaterial, 256
    );
    return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function llamarBackend(url) {
    const resp = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
    });
    return await resp.json();
  }

  async function verificarUsuario(usuario, password) {
    try {
      const resp = await fetch("usuarios.json?t=" + Date.now(), { cache: "no-store" });
      const usuarios = await resp.json();
      const user = usuarios.find(u => u.user === usuario.toLowerCase().trim());

      if (!user) return null;
      if (user.activo === false) return null;

      const hashCalc = await pbkdf2Hash(password, user.salt);
      if (hashCalc === user.hash) {
        return {
          user: user.user,
          nombre: user.nombre,
          rol: user.rol,
          permisos: user.permisos || [],
        };
      }
      return null;
    } catch (e) {
      console.error("Error al verificar usuario:", e);
      return null;
    }
  }

  function initLogin() {
    if (getSession()) {
      window.location.href = "app.html";
      return;
    }

    const form = document.getElementById("login-form");
    const errorMsg = document.getElementById("error-msg");
    const btn = form.querySelector("button");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorMsg.textContent = "";
      btn.disabled = true;
      btn.textContent = "Verificando...";

      const usuario = document.getElementById("usuario").value;
      const password = document.getElementById("password").value;
      const user = await verificarUsuario(usuario, password);

      if (user) {
        setSession(user);
        window.location.href = "app.html";
      } else {
        errorMsg.textContent = "Usuario o contraseña incorrectos";
        btn.disabled = false;
        btn.textContent = "Entrar";
      }
    });
  }


  // ═══════════════════════════════════════════════════════════════
  // APP PRINCIPAL
  // ═══════════════════════════════════════════════════════════════

  function initApp() {
    usuarioActual = getSession();
    if (!usuarioActual) {
      window.location.href = "index.html";
      return;
    }

    document.getElementById("user-info").textContent =
      usuarioActual.nombre + " (" + usuarioActual.rol + ")";

    document.getElementById("btn-logout").addEventListener("click", () => {
      if (confirm("¿Cerrar sesión?")) {
        clearSession();
        window.location.href = "index.html";
      }
    });

    document.getElementById("btn-entrada").addEventListener("click", () => abrirFormulario("ENTRADA"));
    document.getElementById("btn-salida").addEventListener("click", () => abrirFormulario("SALIDA"));
    document.getElementById("btn-devolucion").addEventListener("click", () => abrirFormulario("DEVOLUCION"));
    document.getElementById("btn-ver-historial").addEventListener("click", verHistorial);

    // Botón de Dashboard (solo supervisor, gerencia, admin)
    const rolesConDashboard = ["supervisor", "gerencia", "admin"];
    if (rolesConDashboard.includes(usuarioActual.rol)) {
      const btnDash = document.getElementById("btn-dashboard");
      if (btnDash) {
        btnDash.classList.remove("hidden");
        btnDash.addEventListener("click", abrirDashboard);
      }
    }

    document.getElementById("btn-cerrar-form").addEventListener("click", volverAlMenu);
    document.getElementById("btn-cancelar-form").addEventListener("click", volverAlMenu);
    document.getElementById("btn-guardar").addEventListener("click", guardarMovimiento);

    document.getElementById("buscar-insumo").addEventListener("input", buscarInsumo);

    document.getElementById("btn-registrar-otro").addEventListener("click", () => abrirFormulario(tipoMovimientoActual));
    document.getElementById("btn-volver-menu").addEventListener("click", volverAlMenu);

    document.getElementById("btn-cerrar-historial").addEventListener("click", volverAlMenu);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }

    cargarCatalogos();
    mostrarVista("view-menu");
  }

  async function cargarCatalogos() {
    console.log("🔵 Cargando catálogos...");

    try {
      const urlCat = CONFIG.APPS_SCRIPT_URL + "?accion=listar_catalogo";
      const cat = await llamarBackend(urlCat);

      if (cat.ok) {
        catalogoCache = cat.insumos;
        console.log("✅ Catálogo cargado:", catalogoCache.length, "insumos");
      }
    } catch (e) {
      console.error("❌ Error cargando catálogo:", e);
    }

    try {
      const urlDcs = CONFIG.APPS_SCRIPT_URL + "?accion=listar_dcs";
      const dcs = await llamarBackend(urlDcs);

      if (dcs.ok) {
        dcsCache = dcs.dcs;
        console.log("✅ DCs cargados:", dcsCache.length);
      }
    } catch (e) {
      console.error("❌ Error cargando DCs:", e);
    }
  }

  function mostrarVista(id) {
    ["view-menu", "view-form", "view-exito", "view-historial", "view-loading", "view-dashboard"]
      .forEach(v => {
        const el = document.getElementById(v);
        if (el) el.classList.add("hidden");
      });
    document.getElementById(id).classList.remove("hidden");
  }

  function volverAlMenu() {
    insumoSeleccionado = null;
    tipoMovimientoActual = null;
    mostrarVista("view-menu");
  }


  // ═══════════════════════════════════════════════════════════════
  // FORMULARIO DE MOVIMIENTO
  // ═══════════════════════════════════════════════════════════════

  function abrirFormulario(tipo) {
    if (!usuarioActual.permisos.includes(tipo)) {
      alert("No tienes permiso para registrar " + tipo);
      return;
    }

    tipoMovimientoActual = tipo;
    insumoSeleccionado = null;

    document.getElementById("buscar-insumo").value = "";
    document.getElementById("info-insumo").classList.add("hidden");
    document.getElementById("resultados-busqueda").classList.add("hidden");
    document.getElementById("lote-insumo").value = "";
    document.getElementById("lote-trabajo").value = "";
    document.getElementById("cantidad").value = "";
    document.getElementById("proveedor").value = "";
    document.getElementById("pu").value = "";
    document.getElementById("iva").value = "";
    document.getElementById("notas").value = "";
    document.getElementById("registro-status").textContent = "";
    document.getElementById("registro-status").className = "send-status";

    const titulos = {
      "ENTRADA": "📥 Registrar ENTRADA",
      "SALIDA": "📤 Registrar SALIDA",
      "DEVOLUCION": "🔄 Registrar DEVOLUCIÓN",
    };
    document.getElementById("form-titulo").textContent = titulos[tipo] || "Registrar Movimiento";

    const grupoLoteTrabajo = document.getElementById("grupo-lote-trabajo");
    const grupoUbicacion = document.getElementById("grupo-ubicacion");
    const grupoProveedor = document.getElementById("grupo-proveedor");

    if (tipo === "ENTRADA") {
      grupoLoteTrabajo.classList.add("hidden");
      grupoUbicacion.classList.remove("hidden");
      grupoProveedor.classList.remove("hidden");
    } else if (tipo === "SALIDA") {
      grupoLoteTrabajo.classList.remove("hidden");
      grupoUbicacion.classList.remove("hidden");
      grupoProveedor.classList.remove("hidden");
    } else if (tipo === "DEVOLUCION") {
      grupoLoteTrabajo.classList.remove("hidden");
      grupoUbicacion.classList.remove("hidden");
      grupoProveedor.classList.add("hidden");
    }

    llenarUbicaciones();
    mostrarVista("view-form");
    setTimeout(() => document.getElementById("buscar-insumo").focus(), 100);
  }

  function llenarUbicaciones() {
    const select = document.getElementById("ubicacion");
    select.innerHTML = '<option value="">-- Selecciona --</option>';

    const ubicacionesFijas = [
      "ALMACEN_MP", "ALMACEN_EMPAQUE", "ALMACEN_PT",
      "ALMACEN_SP", "SERVICIOS", "ADMINISTRACION", "PRODUCCION"
    ];

    ubicacionesFijas.forEach(u => {
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

  function buscarInsumo() {
    const query = document.getElementById("buscar-insumo").value.trim().toUpperCase();
    const resultados = document.getElementById("resultados-busqueda");

    if (query.length < 2) {
      resultados.classList.add("hidden");
      return;
    }

    if (!catalogoCache || catalogoCache.length === 0) {
      resultados.innerHTML = '<div class="resultado-vacio">⏳ Catálogo cargando... espera un momento y vuelve a intentar</div>';
      resultados.classList.remove("hidden");
      return;
    }

    const filtrados = catalogoCache.filter(i =>
      i.codigo.toUpperCase().includes(query) ||
      i.descripcion.toUpperCase().includes(query)
    ).slice(0, 20);

    if (filtrados.length === 0) {
      resultados.innerHTML = '<div class="resultado-vacio">❌ Sin resultados</div>';
      resultados.classList.remove("hidden");
      return;
    }

    resultados.innerHTML = "";
    filtrados.forEach(insumo => {
      const div = document.createElement("div");
      div.className = "resultado-item";
      div.innerHTML = `
        <div class="resultado-codigo">${insumo.codigo}</div>
        <div class="resultado-desc">${insumo.descripcion}</div>
        <div class="resultado-cat">${insumo.categoria}</div>
      `;
      div.addEventListener("click", () => seleccionarInsumo(insumo));
      resultados.appendChild(div);
    });
    resultados.classList.remove("hidden");
  }

  function seleccionarInsumo(insumo) {
    insumoSeleccionado = insumo;

    document.getElementById("buscar-insumo").value = insumo.codigo + " - " + insumo.descripcion;
    document.getElementById("resultados-busqueda").classList.add("hidden");

    document.getElementById("info-codigo").textContent = insumo.codigo;
    document.getElementById("info-descripcion").textContent = insumo.descripcion;
    document.getElementById("info-unidad").textContent = insumo.unidad;
    document.getElementById("info-categoria").textContent = insumo.categoria;
    document.getElementById("info-insumo").classList.remove("hidden");

    document.getElementById("label-unidad").textContent = "(" + insumo.unidad + ")";

    if (insumo.proveedor) {
      document.getElementById("proveedor").value = insumo.proveedor;
    }

    const selectUbic = document.getElementById("ubicacion");
    for (let i = 0; i < selectUbic.options.length; i++) {
      if (selectUbic.options[i].value === insumo.ubicacion) {
        selectUbic.selectedIndex = i;
        break;
      }
    }
  }


  // ═══════════════════════════════════════════════════════════════
  // GUARDAR MOVIMIENTO
  // ═══════════════════════════════════════════════════════════════

  async function guardarMovimiento() {
    const statusEl = document.getElementById("registro-status");

    if (!insumoSeleccionado) {
      statusEl.textContent = "❌ Selecciona un insumo";
      statusEl.className = "send-status error";
      return;
    }

    const cantidad = parseFloat(document.getElementById("cantidad").value);
    if (!cantidad || cantidad <= 0) {
      statusEl.textContent = "❌ Cantidad inválida";
      statusEl.className = "send-status error";
      return;
    }

    statusEl.textContent = "⏳ Guardando...";
    statusEl.className = "send-status";

    const payload = {
      accion: "registrar_movimiento",
      tipo_movimiento: tipoMovimientoActual,
      codigo_oar: insumoSeleccionado.codigo,
      descripcion: insumoSeleccionado.descripcion,
      unidad: insumoSeleccionado.unidad,
      lote_insumo: document.getElementById("lote-insumo").value.trim(),
      lote_trabajo: document.getElementById("lote-trabajo").value.trim(),
      cantidad: cantidad,
      ubicacion: document.getElementById("ubicacion").value,
      proveedor_cliente: document.getElementById("proveedor").value.trim(),
      pu: parseFloat(document.getElementById("pu").value) || 0,
      iva: parseFloat(document.getElementById("iva").value) || 0,
      notas: document.getElementById("notas").value.trim(),
      usuario: usuarioActual.user,
      nombre_usuario: usuarioActual.nombre,
      rol: usuarioActual.rol,
    };

    try {
      const url = CONFIG.APPS_SCRIPT_URL
        + "?accion=registrar_movimiento"
        + "&data=" + encodeURIComponent(JSON.stringify(payload));

      const resp = await llamarBackend(url);

      if (!resp.ok) {
        statusEl.textContent = "❌ Error: " + (resp.error || "Desconocido");
        statusEl.className = "send-status error";
        return;
      }

      mostrarExito(resp, cantidad);

    } catch (e) {
      statusEl.textContent = "❌ Error: " + e.message;
      statusEl.className = "send-status error";
    }
  }

  function mostrarExito(resp, cantidad) {
    document.getElementById("exito-id").textContent = resp.id_movimiento || "-";
    document.getElementById("exito-tipo").textContent = tipoMovimientoActual;
    document.getElementById("exito-insumo").textContent = insumoSeleccionado.codigo + " - " + insumoSeleccionado.descripcion;
    document.getElementById("exito-cantidad").textContent = cantidad + " " + insumoSeleccionado.unidad;
    document.getElementById("exito-fecha").textContent = (resp.fecha || "") + " " + (resp.hora || "");

    mostrarVista("view-exito");
  }


  // ═══════════════════════════════════════════════════════════════
  // HISTORIAL
  // ═══════════════════════════════════════════════════════════════

  async function verHistorial() {
    mostrarVista("view-loading");
    document.getElementById("loading-text").textContent = "Cargando movimientos...";

    try {
      const url = CONFIG.APPS_SCRIPT_URL + "?accion=movimientos_hoy&usuario=" + encodeURIComponent(usuarioActual.user);
      const resp = await llamarBackend(url);

      if (!resp.ok) throw new Error("Error al cargar");

      mostrarListaMovimientos(resp.movimientos);
    } catch (e) {
      alert("Error: " + e.message);
      volverAlMenu();
    }
  }

  function mostrarListaMovimientos(movimientos) {
    const contenedor = document.getElementById("lista-movimientos");
    contenedor.innerHTML = "";

    if (movimientos.length === 0) {
      contenedor.innerHTML = '<p style="text-align:center; padding:30px; color:#888;">No tienes movimientos hoy.</p>';
      mostrarVista("view-historial");
      return;
    }

    movimientos.forEach(m => {
      const card = document.createElement("div");
      card.className = "movimiento-card mov-" + m.tipo.toLowerCase();
      card.innerHTML = `
        <div class="mov-header">
          <span class="mov-tipo">${m.tipo}</span>
          <span class="mov-hora">${m.hora}</span>
        </div>
        <div class="mov-codigo">${m.codigo}</div>
        <div class="mov-desc">${m.descripcion}</div>
        <div class="mov-cantidad">${m.cantidad} ${m.unidad}</div>
        ${m.estado === "CANCELADO" ? '<div class="mov-cancelado">❌ CANCELADO</div>' : ""}
      `;
      contenedor.appendChild(card);
    });

    mostrarVista("view-historial");
  }


  // ═══════════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════════

  function abrirDashboard() {
    const hoy = new Date().toISOString().split("T")[0];
    document.getElementById("filtro-fecha").value = hoy;
    document.getElementById("filtro-tipo").value = "TODOS";
    document.getElementById("filtro-usuario").value = "";

    document.getElementById("btn-cerrar-dashboard").addEventListener("click", volverAlMenu);
    document.getElementById("btn-aplicar-filtros").addEventListener("click", cargarDashboard);

    cargarResumen();
    cargarMovimientosDashboard();

    mostrarVista("view-dashboard");
  }

  async function cargarResumen() {
    try {
      const fecha = document.getElementById("filtro-fecha").value;
      const fechaFormato = formatearFecha(fecha);

      const url = CONFIG.APPS_SCRIPT_URL + "?accion=resumen_dia&fecha=" + encodeURIComponent(fechaFormato);
      const resp = await llamarBackend(url);

      if (!resp.ok) throw new Error("Error al cargar resumen");

      const contenedor = document.getElementById("resumen-dia");
      contenedor.innerHTML =
        '<div class="resumen-card entrada">' +
          '<span class="resumen-numero">' + resp.total_entradas + '</span>' +
          '<span class="resumen-label">Entradas</span>' +
        '</div>' +
        '<div class="resumen-card salida">' +
          '<span class="resumen-numero">' + resp.total_salidas + '</span>' +
          '<span class="resumen-label">Salidas</span>' +
        '</div>' +
        '<div class="resumen-card devolucion">' +
          '<span class="resumen-numero">' + resp.total_devoluciones + '</span>' +
          '<span class="resumen-label">Devoluciones</span>' +
        '</div>' +
        '<div class="resumen-card total">' +
          '<span class="resumen-numero">' + resp.total_movimientos + '</span>' +
          '<span class="resumen-label">Total</span>' +
        '</div>';
    } catch (e) {
      console.error("Error en resumen:", e);
    }
  }

  async function cargarMovimientosDashboard() {
    const contenedor = document.getElementById("lista-dashboard");
    contenedor.innerHTML = '<p style="text-align:center;">⏳ Cargando...</p>';

    try {
      const fecha = document.getElementById("filtro-fecha").value;
      const fechaFormato = formatearFecha(fecha);
      const tipo = document.getElementById("filtro-tipo").value;
      const usuario = document.getElementById("filtro-usuario").value;

      let url = CONFIG.APPS_SCRIPT_URL + "?accion=movimientos_dia&fecha=" + encodeURIComponent(fechaFormato);
      if (tipo && tipo !== "TODOS") url += "&tipo=" + encodeURIComponent(tipo);
      if (usuario) url += "&usuario=" + encodeURIComponent(usuario);

      const resp = await llamarBackend(url);
      if (!resp.ok) throw new Error("Error al cargar movimientos");

      mostrarMovimientosDashboard(resp.movimientos);
    } catch (e) {
      contenedor.innerHTML = '<p style="color:red; text-align:center;">❌ Error: ' + e.message + '</p>';
    }
  }

  function mostrarMovimientosDashboard(movimientos) {
    const contenedor = document.getElementById("lista-dashboard");
    contenedor.innerHTML = "";

    if (movimientos.length === 0) {
      contenedor.innerHTML = '<p style="text-align:center; padding:20px; color:#888;">No hay movimientos en esta fecha.</p>';
      return;
    }

    movimientos.sort((a, b) => (b.hora || "").localeCompare(a.hora || ""));

    movimientos.forEach(m => {
      const card = document.createElement("div");
      card.className = "movimiento-card mov-" + m.tipo.toLowerCase();
      if (m.estado === "CANCELADO") card.style.opacity = "0.5";

      card.innerHTML =
        '<div class="mov-header">' +
          '<span class="mov-tipo">' + m.tipo + '</span>' +
          '<span class="mov-hora">' + m.hora + '</span>' +
        '</div>' +
        '<div class="mov-codigo">' + m.codigo + '</div>' +
        '<div class="mov-desc">' + m.descripcion + '</div>' +
        '<div class="mov-cantidad">' + m.cantidad + ' ' + m.unidad + '</div>' +
        '<div class="mov-usuario">👤 ' + (m.nombre_usuario || m.usuario) + ' (' + m.rol + ')</div>' +
        (m.lote_insumo ? '<div class="mov-usuario">📦 Lote: ' + m.lote_insumo + '</div>' : '') +
        (m.estado === "CANCELADO" ? '<div class="mov-cancelado">❌ CANCELADO</div>' : '');

      if (m.estado !== "CANCELADO") {
        const btnCancelar = document.createElement("button");
        btnCancelar.className = "btn-cancelar-mov";
        btnCancelar.textContent = "🗑️ Cancelar";
        btnCancelar.addEventListener("click", () => cancelarMovimientoDash(m));
        card.appendChild(btnCancelar);
      }

      contenedor.appendChild(card);
    });
  }

  async function cancelarMovimientoDash(mov) {
    const motivo = prompt("Motivo de la cancelación:\n\n(" + mov.codigo + " - " + mov.cantidad + " " + mov.unidad + ")");

    if (motivo === null) return;
    if (!motivo.trim()) {
      alert("Debes ingresar un motivo");
      return;
    }

    try {
      const url = CONFIG.APPS_SCRIPT_URL + "?accion=cancelar_movimiento_dashboard&data=" +
        encodeURIComponent(JSON.stringify({
          id_movimiento: mov.id,
          motivo: motivo,
          usuario: usuarioActual.user,
          rol: usuarioActual.rol,
        }));

      const resp = await llamarBackend(url);

      if (!resp.ok) {
        alert("❌ Error: " + (resp.error || "Desconocido"));
        return;
      }

      alert("✅ Movimiento cancelado");
      cargarMovimientosDashboard();
      cargarResumen();
    } catch (e) {
      alert("❌ Error: " + e.message);
    }
  }

  function cargarDashboard() {
    cargarResumen();
    cargarMovimientosDashboard();
  }

  function formatearFecha(fechaISO) {
    if (!fechaISO) return "";
    const partes = fechaISO.split("-");
    return partes[2] + "/" + partes[1] + "/" + partes[0];
  }


  // ═══════════════════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════════════════

  return { initLogin, initApp };

})();
