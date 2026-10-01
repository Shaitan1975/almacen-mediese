// ═══════════════════════════════════════════════════════════════════
// ALMACÉN MEDIESE - LÓGICA DE LA PWA (v2.2)
// Login + Registro + Dashboard + Stock + Lotes de Trabajo
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
  let stockCache = null;
  let loteSeleccionadoAbrir = null;
  let lotesCache = null;
  let loteSeleccionadoCerrar = null;


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

    const userInfo = document.getElementById("user-info");
    if (userInfo) {
      userInfo.textContent = usuarioActual.nombre + " (" + usuarioActual.rol + ")";
    }

    function addEventSafe(id, evento, handler) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener(evento, handler);
      } else {
        console.warn("Elemento no encontrado: " + id);
      }
    }

    addEventSafe("btn-logout", "click", () => {
      if (confirm("¿Cerrar sesión?")) {
        clearSession();
        window.location.href = "index.html";
      }
    });

    addEventSafe("btn-entrada", "click", () => abrirFormulario("ENTRADA"));
    addEventSafe("btn-salida", "click", () => abrirFormulario("SALIDA"));
    addEventSafe("btn-devolucion", "click", () => abrirFormulario("DEVOLUCION"));
    addEventSafe("btn-ver-historial", "click", verHistorial);
    addEventSafe("btn-ver-stock", "click", verStock);

    const rolesConLotes = ["supervisor", "gerencia", "admin"];
    if (rolesConLotes.includes(usuarioActual.rol)) {
      const menuLotes = document.getElementById("menu-botones-lotes");
      if (menuLotes) {
        menuLotes.classList.remove("hidden");
        addEventSafe("btn-abrir-lote", "click", abrirFormularioAbrirLote);
        addEventSafe("btn-cerrar-lote", "click", abrirFormularioCerrarLote);
      }
    }

    const rolesConDashboard = ["supervisor", "gerencia", "admin"];
    if (rolesConDashboard.includes(usuarioActual.rol)) {
      const btnDash = document.getElementById("btn-dashboard");
      if (btnDash) {
        btnDash.classList.remove("hidden");
        btnDash.addEventListener("click", abrirDashboard);
      }
    }

    addEventSafe("btn-cerrar-form", "click", volverAlMenu);
    addEventSafe("btn-cancelar-form", "click", volverAlMenu);
    addEventSafe("btn-guardar", "click", guardarMovimiento);
    addEventSafe("buscar-insumo", "input", buscarInsumo);
    addEventSafe("btn-registrar-otro", "click", () => abrirFormulario(tipoMovimientoActual));
    addEventSafe("btn-volver-menu", "click", volverAlMenu);
    addEventSafe("btn-cerrar-historial", "click", volverAlMenu);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }

    cargarCatalogos();
    mostrarVista("view-menu");
  }

  async function cargarCatalogos() {
    console.log("Cargando catálogos...");

    try {
      const urlCat = CONFIG.APPS_SCRIPT_URL + "?accion=listar_catalogo";
      const cat = await llamarBackend(urlCat);

      if (cat.ok) {
        catalogoCache = cat.insumos;
        console.log("Catálogo cargado:", catalogoCache.length, "insumos");
      }
    } catch (e) {
      console.error("Error cargando catálogo:", e);
    }

    try {
      const urlDcs = CONFIG.APPS_SCRIPT_URL + "?accion=listar_dcs";
      const dcs = await llamarBackend(urlDcs);

      if (dcs.ok) {
        dcsCache = dcs.dcs;
        console.log("DCs cargados:", dcsCache.length);
      }
    } catch (e) {
      console.error("Error cargando DCs:", e);
    }
  }

  function mostrarVista(id) {
    ["view-menu", "view-form", "view-exito", "view-historial", "view-loading",
     "view-dashboard", "view-stock", "view-abrir-lote", "view-cerrar-lote"]
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
    document.getElementById("info-stock").classList.add("hidden");
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
      "ENTRADA": "Registrar ENTRADA",
      "SALIDA": "Registrar SALIDA",
      "DEVOLUCION": "Registrar DEVOLUCIÓN",
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
      resultados.innerHTML = '<div class="resultado-vacio">Catálogo cargando...</div>';
      resultados.classList.remove("hidden");
      return;
    }

    const filtrados = catalogoCache.filter(i =>
      i.codigo.toUpperCase().includes(query) ||
      i.descripcion.toUpperCase().includes(query)
    ).slice(0, 20);

    if (filtrados.length === 0) {
      resultados.innerHTML = '<div class="resultado-vacio">Sin resultados</div>';
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

    consultarStockInsumo(insumo.codigo);
  }


  // ═══════════════════════════════════════════════════════════════
  // GUARDAR MOVIMIENTO
  // ═══════════════════════════════════════════════════════════════

  async function guardarMovimiento() {
    const statusEl = document.getElementById("registro-status");

    if (!insumoSeleccionado) {
      statusEl.textContent = "Selecciona un insumo";
      statusEl.className = "send-status error";
      return;
    }

    const cantidad = parseFloat(document.getElementById("cantidad").value);
    if (!cantidad || cantidad <= 0) {
      statusEl.textContent = "Cantidad inválida";
      statusEl.className = "send-status error";
      return;
    }

    if (tipoMovimientoActual === "SALIDA") {
      const loteInsumo = document.getElementById("lote-insumo").value.trim();

      statusEl.textContent = "Validando stock...";
      statusEl.className = "send-status";

      try {
        const urlStock = CONFIG.APPS_SCRIPT_URL + "?accion=stock_insumo_total&codigo=" +
          encodeURIComponent(insumoSeleccionado.codigo);
        const respStock = await llamarBackend(urlStock);

        if (respStock.ok) {
          const stockDisponible = Number(respStock.saldo_total) || 0;
          const unidad = insumoSeleccionado.unidad || "";

          if (loteInsumo) {
            const loteInfo = respStock.lotes.find(l => l.lote === loteInsumo);
            const stockLote = loteInfo ? Number(loteInfo.saldo) : 0;

            if (cantidad > stockLote) {
              const formateado = stockLote.toLocaleString("es-MX");
              statusEl.textContent = "Stock insuficiente en lote " + loteInsumo +
                ". Disponible: " + formateado + " " + unidad +
                " | Solicitado: " + cantidad + " " + unidad;
              statusEl.className = "send-status error";

              const continuar = confirm(
                "STOCK INSUFICIENTE\n\n" +
                "Lote: " + loteInsumo + "\n" +
                "Disponible: " + formateado + " " + unidad + "\n" +
                "Solicitado: " + cantidad + " " + unidad + "\n\n" +
                "¿Deseas continuar de todos modos?"
              );

              if (!continuar) return;
            }
          } else {
            if (cantidad > stockDisponible) {
              const formateado = stockDisponible.toLocaleString("es-MX");
              statusEl.textContent = "Stock insuficiente. Disponible: " + formateado + " " + unidad;
              statusEl.className = "send-status error";

              const continuar = confirm(
                "STOCK INSUFICIENTE\n\n" +
                "Insumo: " + insumoSeleccionado.codigo + "\n" +
                "Disponible: " + formateado + " " + unidad + "\n" +
                "Solicitado: " + cantidad + " " + unidad + "\n\n" +
                "¿Deseas continuar de todos modos?"
              );

              if (!continuar) return;
            }
          }
        }
      } catch (e) {
        console.warn("Error validando stock:", e);
      }

      statusEl.textContent = "Guardando...";
      statusEl.className = "send-status";
    }

    statusEl.textContent = "Guardando...";
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
        if (resp.lote_cerrado) {
          const reabrir = confirm(resp.error + "\n\n¿Deseas reactivar el lote?");
          if (reabrir) {
            const urlReabrir = CONFIG.APPS_SCRIPT_URL + "?accion=abrir_lote&data=" +
              encodeURIComponent(JSON.stringify({
                lote: document.getElementById("lote-trabajo").value.trim(),
                codigo_oar: insumoSeleccionado.codigo,
                descripcion: insumoSeleccionado.descripcion,
                usuario: usuarioActual.user,
                rol: usuarioActual.rol,
              }));
            const respReabrir = await llamarBackend(urlReabrir);
            if (respReabrir.ok) {
              alert("Lote reabierto. Vuelve a intentar el registro.");
            } else {
              alert("No se pudo reabrir: " + respReabrir.error);
            }
          }
          return;
        }
        statusEl.textContent = "Error: " + (resp.error || "Desconocido");
        statusEl.className = "send-status error";
        return;
      }

      mostrarExito(resp, cantidad);

    } catch (e) {
      statusEl.textContent = "Error: " + e.message;
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
        ${m.estado === "CANCELADO" ? '<div class="mov-cancelado">CANCELADO</div>' : ""}
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
    contenedor.innerHTML = '<p style="text-align:center;">Cargando...</p>';

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
      contenedor.innerHTML = '<p style="color:red; text-align:center;">Error: ' + e.message + '</p>';
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
        '<div class="mov-usuario">Usuario: ' + (m.nombre_usuario || m.usuario) + ' (' + m.rol + ')</div>' +
        (m.lote_insumo ? '<div class="mov-usuario">Lote: ' + m.lote_insumo + '</div>' : '') +
        (m.estado === "CANCELADO" ? '<div class="mov-cancelado">CANCELADO</div>' : '');

      if (m.estado !== "CANCELADO") {
        const btnCancelar = document.createElement("button");
        btnCancelar.className = "btn-cancelar-mov";
        btnCancelar.textContent = "Cancelar";
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
        alert("Error: " + (resp.error || "Desconocido"));
        return;
      }

      alert("Movimiento cancelado");
      cargarMovimientosDashboard();
      cargarResumen();
    } catch (e) {
      alert("Error: " + e.message);
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
  // STOCK ACTUAL
  // ═══════════════════════════════════════════════════════════════

  async function verStock() {
    mostrarVista("view-loading");
    document.getElementById("loading-text").textContent = "Cargando stock...";

    try {
      const url = CONFIG.APPS_SCRIPT_URL + "?accion=listar_stock";
      const resp = await llamarBackend(url);

      if (!resp.ok) throw new Error("Error al cargar stock");

      stockCache = resp.items;

      document.getElementById("btn-cerrar-stock").addEventListener("click", volverAlMenu);
      document.getElementById("stock-buscar").value = "";
      document.getElementById("stock-buscar").addEventListener("input", filtrarStock);

      renderizarStock(stockCache);
      mostrarVista("view-stock");
    } catch (e) {
      alert("Error al cargar stock: " + e.message);
      volverAlMenu();
    }
  }

  function filtrarStock() {
    const query = document.getElementById("stock-buscar").value.trim().toUpperCase();

    if (!query) {
      renderizarStock(stockCache);
      return;
    }

    const filtrados = stockCache.filter(item =>
      String(item.codigo).toUpperCase().includes(query) ||
      String(item.descripcion).toUpperCase().includes(query) ||
      String(item.lote).toUpperCase().includes(query)
    );

    renderizarStock(filtrados);
  }

  function renderizarStock(items) {
    const contenedor = document.getElementById("lista-stock");
    const resumen = document.getElementById("stock-resumen");

    const totalItems = items.length;
    const totalSaldoPositivo = items.filter(i => i.saldo > 0).length;
    const totalSaldoCero = items.filter(i => i.saldo === 0).length;

    resumen.innerHTML =
      '<div class="stock-resumen-card">' +
        '<span class="stock-resumen-numero">' + totalItems + '</span>' +
        '<span class="stock-resumen-label">Insumos / Lotes</span>' +
      '</div>' +
      '<div class="stock-resumen-card">' +
        '<span class="stock-resumen-numero">' + totalSaldoPositivo + '</span>' +
        '<span class="stock-resumen-label">Con Stock</span>' +
      '</div>' +
      '<div class="stock-resumen-card">' +
        '<span class="stock-resumen-numero">' + totalSaldoCero + '</span>' +
        '<span class="stock-resumen-label">Sin Stock</span>' +
      '</div>';

    contenedor.innerHTML = "";

    if (items.length === 0) {
      contenedor.innerHTML = '<div class="stock-vacio">No hay insumos en stock</div>';
      return;
    }

    items.sort((a, b) => {
      if ((a.saldo > 0) !== (b.saldo > 0)) return a.saldo > 0 ? -1 : 1;
      return String(a.codigo).localeCompare(String(b.codigo));
    });

    items.forEach(item => {
      const div = document.createElement("div");
      div.className = "stock-item";

      if (item.saldo === 0) {
        div.classList.add("stock-cero");
      } else if (item.saldo < 100) {
        div.classList.add("stock-bajo");
      }

      const saldoFormateado = Number(item.saldo).toLocaleString("es-MX", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      });

      div.innerHTML =
        '<div class="stock-item-header">' +
          '<span class="stock-item-codigo">' + item.codigo + '</span>' +
          '<span class="stock-item-saldo">' + saldoFormateado + ' ' + (item.unidad || '') + '</span>' +
        '</div>' +
        '<div class="stock-item-desc">' + (item.descripcion || '-') + '</div>' +
        '<div class="stock-item-info">' +
          '<span>Lote: <strong>' + (item.lote || 'SIN_LOTE') + '</strong></span>' +
          '<span>' + (item.ubicacion || '-') + '</span>' +
        '</div>';

      contenedor.appendChild(div);
    });
  }

  async function consultarStockInsumo(codigo) {
    const panel = document.getElementById("info-stock");
    const valor = document.getElementById("info-stock-valor");

    if (!panel || !valor) return;

    try {
      const url = CONFIG.APPS_SCRIPT_URL + "?accion=stock_insumo_total&codigo=" + encodeURIComponent(codigo);
      const resp = await llamarBackend(url);

      if (resp.ok) {
        const total = Number(resp.saldo_total) || 0;
        const unidad = insumoSeleccionado && insumoSeleccionado.unidad ? insumoSeleccionado.unidad : "";
        const formateado = total.toLocaleString("es-MX", {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2
        });

        valor.textContent = formateado + " " + unidad;
        panel.classList.remove("hidden");

        if (total === 0) {
          panel.classList.add("warning");
          valor.textContent = formateado + " " + unidad + " (sin stock)";
        } else if (total < 100) {
          panel.classList.add("warning");
        } else {
          panel.classList.remove("warning");
        }
      } else {
        panel.classList.add("hidden");
      }
    } catch (e) {
      console.error("Error consultando stock:", e);
      panel.classList.add("hidden");
    }
  }


  // ═══════════════════════════════════════════════════════════════
  // LOTES DE TRABAJO
  // ═══════════════════════════════════════════════════════════════

  function abrirFormularioAbrirLote() {
    document.getElementById("abrir-lote-numero").value = "";
    document.getElementById("abrir-lote-buscar").value = "";
    document.getElementById("abrir-lote-info").classList.add("hidden");
    document.getElementById("abrir-lote-resultados").classList.add("hidden");
    document.getElementById("abrir-lote-notas").value = "";
    document.getElementById("abrir-lote-status").textContent = "";
    document.getElementById("abrir-lote-status").className = "send-status";
    document.getElementById("abrir-lote-aviso").textContent = "";
    document.getElementById("abrir-lote-aviso").className = "lote-status";

    loteSeleccionadoAbrir = null;

    document.getElementById("btn-cerrar-abrir-lote").addEventListener("click", volverAlMenu);
    document.getElementById("btn-cancelar-abrir-lote").addEventListener("click", volverAlMenu);
    document.getElementById("abrir-lote-buscar").addEventListener("input", buscarInsumoAbrirLote);
    document.getElementById("abrir-lote-numero").addEventListener("input", validarNumeroLote);
    document.getElementById("btn-abrir-lote-guardar").addEventListener("click", guardarAbrirLote);

    mostrarVista("view-abrir-lote");
    setTimeout(() => document.getElementById("abrir-lote-numero").focus(), 100);
  }

  async function validarNumeroLote() {
    const lote = document.getElementById("abrir-lote-numero").value.trim();
    const aviso = document.getElementById("abrir-lote-aviso");

    if (lote.length < 2) {
      aviso.textContent = "";
      aviso.className = "lote-status";
      return;
    }

    try {
      const url = CONFIG.APPS_SCRIPT_URL + "?accion=validar_lote&lote=" + encodeURIComponent(lote);
      const resp = await llamarBackend(url);

      if (resp.ok && resp.existe) {
        if (resp.status === "ABIERTO") {
          aviso.textContent = "Este lote ya está ABIERTO";
          aviso.className = "lote-status error";
        } else {
          aviso.textContent = "Este lote ya existe (CERRADO). Se reabrirá.";
          aviso.className = "lote-status warning";
        }
      } else {
        aviso.textContent = "Lote disponible";
        aviso.className = "lote-status ok";
      }
    } catch (e) {
      aviso.textContent = "";
    }
  }

  function buscarInsumoAbrirLote() {
    const query = document.getElementById("abrir-lote-buscar").value.trim().toUpperCase();
    const resultados = document.getElementById("abrir-lote-resultados");

    if (query.length < 2) {
      resultados.classList.add("hidden");
      return;
    }

    if (!catalogoCache || catalogoCache.length === 0) {
      resultados.innerHTML = '<div class="resultado-vacio">Catálogo cargando...</div>';
      resultados.classList.remove("hidden");
      return;
    }

    const filtrados = catalogoCache.filter(i =>
      i.codigo.toUpperCase().includes(query) ||
      i.descripcion.toUpperCase().includes(query)
    ).slice(0, 20);

    if (filtrados.length === 0) {
      resultados.innerHTML = '<div class="resultado-vacio">Sin resultados</div>';
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
      div.addEventListener("click", () => seleccionarInsumoAbrirLote(insumo));
      resultados.appendChild(div);
    });
    resultados.classList.remove("hidden");
  }

  function seleccionarInsumoAbrirLote(insumo) {
    loteSeleccionadoAbrir = insumo;

    document.getElementById("abrir-lote-buscar").value = insumo.codigo + " - " + insumo.descripcion;
    document.getElementById("abrir-lote-resultados").classList.add("hidden");

    document.getElementById("abrir-lote-codigo").textContent = insumo.codigo;
    document.getElementById("abrir-lote-descripcion").textContent = insumo.descripcion;
    document.getElementById("abrir-lote-info").classList.remove("hidden");
  }

  async function guardarAbrirLote() {
    const lote = document.getElementById("abrir-lote-numero").value.trim();
    const statusEl = document.getElementById("abrir-lote-status");

    if (!lote) {
      statusEl.textContent = "Escribe el número de lote";
      statusEl.className = "send-status error";
      return;
    }

    if (!loteSeleccionadoAbrir) {
      statusEl.textContent = "Selecciona un código OAR";
      statusEl.className = "send-status error";
      return;
    }

    statusEl.textContent = "Abriendo lote...";
    statusEl.className = "send-status";

    try {
      const url = CONFIG.APPS_SCRIPT_URL + "?accion=abrir_lote&data=" +
        encodeURIComponent(JSON.stringify({
          lote: lote,
          codigo_oar: loteSeleccionadoAbrir.codigo,
          descripcion: loteSeleccionadoAbrir.descripcion,
          notas: document.getElementById("abrir-lote-notas").value.trim(),
          usuario: usuarioActual.user,
          rol: usuarioActual.rol,
        }));

      const resp = await llamarBackend(url);

      if (!resp.ok) {
        statusEl.textContent = (resp.error || "Error desconocido");
        statusEl.className = "send-status error";
        return;
      }

      statusEl.textContent = resp.mensaje;
      statusEl.className = "send-status ok";

      setTimeout(() => {
        alert(resp.mensaje);
        volverAlMenu();
      }, 800);

    } catch (e) {
      statusEl.textContent = e.message;
      statusEl.className = "send-status error";
    }
  }

  async function abrirFormularioCerrarLote() {
    document.getElementById("cerrar-lote-buscar").value = "";
    document.getElementById("cerrar-lote-resultados").classList.add("hidden");
    document.getElementById("cerrar-lote-info").classList.add("hidden");
    document.getElementById("cerrar-lote-resumen").classList.add("hidden");
    document.getElementById("cerrar-lote-piezas").value = "";
    document.getElementById("cerrar-lote-kilos").value = "";
    document.getElementById("cerrar-lote-notas").value = "";
    document.getElementById("cerrar-lote-status").textContent = "";
    document.getElementById("cerrar-lote-status").className = "send-status";
    document.getElementById("grupo-cerrar-piezas").style.display = "none";
    document.getElementById("grupo-cerrar-kilos").style.display = "none";

    loteSeleccionadoCerrar = null;

    document.getElementById("btn-cerrar-cerrar-lote").addEventListener("click", volverAlMenu);
    document.getElementById("btn-cancelar-cerrar-lote").addEventListener("click", volverAlMenu);
    document.getElementById("cerrar-lote-buscar").addEventListener("input", buscarLoteCerrar);
    document.getElementById("btn-cerrar-lote-guardar").addEventListener("click", guardarCerrarLote);

    try {
      const url = CONFIG.APPS_SCRIPT_URL + "?accion=listar_lotes_abiertos";
      const resp = await llamarBackend(url);

      if (resp.ok && resp.lotes.length > 0) {
        lotesCache = resp.lotes;
        console.log("Lotes abiertos cargados:", lotesCache.length);
      } else {
        lotesCache = [];
        console.warn("No hay lotes abiertos");
      }
    } catch (e) {
      lotesCache = [];
      console.error("Error al cargar lotes:", e);
    }

    mostrarVista("view-cerrar-lote");
    setTimeout(() => document.getElementById("cerrar-lote-buscar").focus(), 100);
  }

  function buscarLoteCerrar() {
    const query = document.getElementById("cerrar-lote-buscar").value.trim().toUpperCase();
    const resultados = document.getElementById("cerrar-lote-resultados");

    if (query.length < 1) {
      resultados.classList.add("hidden");
      return;
    }

    if (!lotesCache || lotesCache.length === 0) {
      resultados.innerHTML = '<div class="resultado-vacio">No hay lotes abiertos</div>';
      resultados.classList.remove("hidden");
      return;
    }

    const filtrados = lotesCache.filter(l =>
      String(l.lote).toUpperCase().includes(query) ||
      String(l.codigo_oar).toUpperCase().includes(query) ||
      String(l.descripcion).toUpperCase().includes(query)
    ).slice(0, 20);

    if (filtrados.length === 0) {
      resultados.innerHTML = '<div class="resultado-vacio">No se encontró ese lote</div>';
      resultados.classList.remove("hidden");
      return;
    }

    resultados.innerHTML = "";
    filtrados.forEach(lote => {
      const div = document.createElement("div");
      div.className = "resultado-item";
      div.innerHTML = `
        <div class="resultado-codigo">${lote.lote}</div>
        <div class="resultado-desc">${lote.codigo_oar} - ${lote.descripcion}</div>
        <div class="resultado-cat">${lote.fecha_apertura} · ${lote.usuario_apertura}</div>
      `;
      div.addEventListener("click", () => seleccionarLoteCerrar(lote));
      resultados.appendChild(div);
    });
    resultados.classList.remove("hidden");
  }

  async function seleccionarLoteCerrar(lote) {
    loteSeleccionadoCerrar = lote;

    document.getElementById("cerrar-lote-buscar").value = lote.lote + " - " + lote.descripcion;
    document.getElementById("cerrar-lote-resultados").classList.add("hidden");

    document.getElementById("cerrar-lote-lote").textContent = lote.lote;
    document.getElementById("cerrar-lote-codigo").textContent = lote.codigo_oar;
    document.getElementById("cerrar-lote-descripcion").textContent = lote.descripcion;
    document.getElementById("cerrar-lote-unidad").textContent = lote.unidad || "KG";
    document.getElementById("cerrar-lote-info").classList.remove("hidden");

    if (lote.unidad === "PZ") {
      document.getElementById("grupo-cerrar-piezas").style.display = "block";
      document.getElementById("grupo-cerrar-kilos").style.display = "none";
    } else {
      document.getElementById("grupo-cerrar-kilos").style.display = "block";
      document.getElementById("grupo-cerrar-piezas").style.display = "none";
    }

    try {
      const url = CONFIG.APPS_SCRIPT_URL + "?accion=movimientos_lote&lote=" + encodeURIComponent(lote.lote);
      const resp = await llamarBackend(url);

      if (resp.ok) {
        document.getElementById("cerrar-lote-total-movs").textContent = resp.total_movimientos;
        document.getElementById("cerrar-lote-total-consumido").textContent =
          (resp.resumen.total_unidades || 0).toLocaleString("es-MX") + " " + (lote.unidad || "");
        document.getElementById("cerrar-lote-resumen").classList.remove("hidden");
      }
    } catch (e) {
      console.error("Error al cargar movimientos del lote:", e);
    }
  }

  async function guardarCerrarLote() {
    const lote = loteSeleccionadoCerrar ? loteSeleccionadoCerrar.lote : "";
    const statusEl = document.getElementById("cerrar-lote-status");

    if (!lote) {
      statusEl.textContent = "Busca y selecciona un lote";
      statusEl.className = "send-status error";
      return;
    }

    const unidad = loteSeleccionadoCerrar.unidad || "KG";
    const piezas = parseFloat(document.getElementById("cerrar-lote-piezas").value) || 0;
    const kilos = parseFloat(document.getElementById("cerrar-lote-kilos").value) || 0;

    if (unidad === "PZ" && piezas <= 0) {
      statusEl.textContent = "Ingresa las piezas producidas";
      statusEl.className = "send-status error";
      return;
    }

    if (unidad === "KG" && kilos <= 0) {
      statusEl.textContent = "Ingresa los kilos producidos";
      statusEl.className = "send-status error";
      return;
    }

    statusEl.textContent = "Cerrando lote...";
    statusEl.className = "send-status";

    try {
      const url = CONFIG.APPS_SCRIPT_URL + "?accion=cerrar_lote&data=" +
        encodeURIComponent(JSON.stringify({
          lote: lote,
          piezas_producidas: piezas,
          kilos_producidos: kilos,
          notas: document.getElementById("cerrar-lote-notas").value.trim(),
          usuario: usuarioActual.user,
          rol: usuarioActual.rol,
        }));

      const resp = await llamarBackend(url);

      if (!resp.ok) {
        statusEl.textContent = (resp.error || "Error desconocido");
        statusEl.className = "send-status error";
        return;
      }

      statusEl.textContent = resp.mensaje;
      statusEl.className = "send-status ok";

      setTimeout(() => {
        alert(resp.mensaje + "\n\nMovimientos actualizados: " + resp.movimientos_actualizados);
        volverAlMenu();
      }, 800);

    } catch (e) {
      statusEl.textContent = e.message;
      statusEl.className = "send-status error";
    }
  }


  // ═══════════════════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════════════════

  return { initLogin, initApp };

})();
