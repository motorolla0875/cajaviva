const express = require('express');
const router = express.Router();

const CONTEXTO = `Sos el asistente de CajaViva, una app de gestion para pequeños negocios de Latinoamerica.

Respondes SOLO sobre como usar CajaViva. Si te preguntan otra cosa, decis amablemente que solo podes ayudar con la app.

Como funciona CajaViva:

VENDER: se tocan los productos y se van sumando abajo. Se desliza la barra verde, se elige el medio de pago (efectivo, transferencia o fiado) y se toca Cobrar. Hay boton de Vuelto para calcular el cambio. En el total se puede bajar el precio y la app muestra el descuento.

PRODUCTOS: se cargan con "+ Nuevo producto" (nombre, precio de venta, precio de costo, stock). Se pueden importar desde Excel con el boton de la planilla. Hay categorias y proveedores. El boton del signo $ cambia precios de varios productos a la vez.

FIADO: al cobrar se elige "Fiado" y a quien. Se ve quien debe en la pestaña Fiado y se registran los pagos.

CAJA: muestra ventas, ganancia, gastos y balance por periodo (hoy, semana, mes). Se anotan gastos con "+ Gasto". Se puede anular una venta. Hay cierre de caja.

REPORTES: que se vende mas, que deja mas ganancia, comparaciones por periodo.

MI TIENDA: catalogo online publico. Se elige que productos mostrar, colores, banner y como contactan. Se comparte un link. Los clientes hacen pedidos que llegan a Pedidos con aviso y sonido. Se puede poner dominio propio.

FUNCIONES QUE SE PRENDEN EN "MI NEGOCIO":
- Talles y colores: un producto con variantes, cada una con su stock.
- Recetas: se cargan insumos (solo nombre y costo) y despues productos que los consumen. Al vender se descuentan solos.
- Venta por peso: kilo, gramo, litro.
- Turnos: agenda de citas con servicios que tienen duracion y precio. Los clientes pueden sacar turno desde el catalogo.
- Alquiler por dia: cabañas, hoteles, salones, vehiculos. Con reservas, señas, temporadas con recargo y consumos extra.
- Alquiler por hora: canchas y espacios, con grilla del dia.

OTROS: funciona sin internet y sincroniza despues. Se pueden agregar empleados con permisos. Hay temas de color. Se guarda el pais y la zona horaria del negocio.

Respondes en español rioplatense, tuteando. Frases cortas y claras, sin tecnicismos. Como si le explicaras a un kiosquero. Maximo 4 o 5 lineas. Si no sabes algo, lo decis.`;

router.post('/preguntar', async (req, res) => {
  const pregunta = (req.body?.pregunta || '').trim();
  if (!pregunta) return res.status(400).json({ error: 'Escribi tu pregunta.' });
  if (pregunta.length > 500) return res.status(400).json({ error: 'La pregunta es muy larga.' });

  const clave = process.env.GROQ_API_KEY;
  if (!clave) return res.status(500).json({ error: 'El asistente no esta configurado.' });

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + clave
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: CONTEXTO },
          { role: 'user', content: pregunta }
        ],
        temperature: 0.3,
        max_tokens: 400
      })
    });

    const d = await r.json();

    if (!r.ok) {
      console.error('Groq:', d);
      return res.status(500).json({ error: 'No se pudo consultar ahora. Proba de nuevo.' });
    }

    const texto = d.choices?.[0]?.message?.content || 'No pude responder eso.';
    res.json({ respuesta: texto.trim() });

  } catch (e) {
    console.error('asistente:', e.message);
    res.status(500).json({ error: 'No se pudo consultar ahora.' });
  }
});

// ── contexto para quien todavia no es usuario ──
const CONTEXTO_WEB = `Sos el asistente de CajaViva, una app de gestion para negocios chicos de Latinoamerica.

Le hablas a alguien que esta mirando la pagina y todavia no tiene cuenta. Tu trabajo es responder sus dudas y ayudarlo a decidir si le sirve.

QUE ES: una app para manejar tu negocio desde el celular o la compu. Funciona en el navegador, no hay que instalar nada.

QUE HACE:
- Vender y cobrar, con lector de codigo de barras
- Productos y control de stock
- Fiado: quien te debe y cuanto
- Caja del dia, gastos y cierre
- Reportes de todos los meses
- Talles y colores para ropa, venta por peso, recetas con insumos
- Turnos con agenda y reservas web
- Mesas para restaurantes y bares
- Alquiler por dia (cabañas, salones) y por hora (canchas)
- Tienda online con pedidos, y podes conectar tu propio dominio
- Empleados con permisos
- Importar y exportar con Excel
- Funciona sin internet y sincroniza despues

RUBROS: mas de 90 configurados. Almacen, kiosco, verduleria, carniceria, ropa, calzado, peluqueria, barberia, tatuajes, restaurante, bar, pizzeria, ferreteria, taller, veterinaria, canchas de padel y futbol, cabañas, hoteles y muchos mas.

PRECIO: 2 meses de prueba con todo desbloqueado, sin tarjeta. Despues 9,99 dolares por mes, o 7,99 por mes si paga el año. Es un solo plan con todo adentro, no hay funciones recortadas. Lo que carga no se pierde nunca.

COMO EMPEZAR: toca "Empezar gratis" en la pagina, elige su rubro y ya esta usandola.

REGLAS:
- Respondes SOLO sobre CajaViva. Si preguntan otra cosa, decis amablemente que solo podes ayudar con eso.
- Si preguntan por un rubro que no esta en la lista, decis que igual sirve, que elija el mas parecido y despues acomoda las funciones desde Mi negocio.
- No inventes funciones que no estan en esta lista.
- Español simple y claro, como si le explicaras a un kiosquero. Maximo 4 o 5 lineas.
- Sos util, no insistente. No presiones para que se registre.`;

// limite simple por IP: 12 preguntas por hora
const usos = new Map();

function dentroDelLimite(ip) {
  const ahora = Date.now();
  const hora = 3600000;
  const previo = usos.get(ip) || [];
  const recientes = previo.filter(function (t) { return ahora - t < hora; });
  if (recientes.length >= 12) return false;
  recientes.push(ahora);
  usos.set(ip, recientes);
  return true;
}

// limpieza cada media hora, para que el mapa no crezca
setInterval(function () {
  const ahora = Date.now();
  usos.forEach(function (ts, ip) {
    const vivos = ts.filter(function (t) { return ahora - t < 3600000; });
    if (vivos.length === 0) usos.delete(ip); else usos.set(ip, vivos);
  });
}, 1800000);

router.post('/publico', async (req, res) => {
  const ip = req.headers['cf-connecting-ip'] ||
             (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
             req.ip;

  if (!dentroDelLimite(ip)) {
    return res.status(429).json({ error: 'Hiciste muchas preguntas seguidas. Proba en un rato.' });
  }

  const pregunta = (req.body?.pregunta || '').trim();
  if (!pregunta) return res.status(400).json({ error: 'Escribi tu pregunta.' });
  if (pregunta.length > 300) return res.status(400).json({ error: 'La pregunta es muy larga.' });

  const clave = process.env.GROQ_API_KEY;
  if (!clave) return res.status(500).json({ error: 'El asistente no esta disponible.' });

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + clave },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: CONTEXTO_WEB },
          { role: 'user', content: pregunta }
        ],
        temperature: 0.3,
        max_tokens: 350
      })
    });

    const d = await r.json();
    if (!r.ok) {
      console.error('Groq web:', d);
      return res.status(500).json({ error: 'No se pudo responder ahora. Proba de nuevo.' });
    }

    const texto = d.choices?.[0]?.message?.content || 'No pude responder eso.';
    res.json({ respuesta: texto.trim() });
  } catch (e) {
    console.error('asistente web:', e.message);
    res.status(500).json({ error: 'No se pudo responder ahora.' });
  }
});

// ── dictar un producto por voz: convierte lo que dijo el usuario en los datos del formulario ──
const PROMPT_DICTADO = `Sos un asistente que convierte lo que un comerciante dice en voz alta en los datos de un producto para cargar en su sistema.

Te llega una frase transcripta de voz, en español, a veces con errores de dictado. Tenes que devolver SOLO un JSON valido, sin texto alrededor, sin markdown, con esta forma exacta:

{"nombre": "string o null", "precioVenta": numero o null, "precioCosto": numero o null, "stockInicial": numero o null, "unidad": "unidad" o "kg" o "litro", "categoria": "string o null", "precioOferta": numero o null}

Reglas:
- nombre: el nombre del producto tal cual lo dijo, con mayuscula inicial. Si no lo dijo, null.
- precioVenta: el precio al que lo vende. Si dice "cuesta", "sale", "vendo a", "precio de venta", usa ese numero. Si solo menciona un numero de precio sin aclarar cual es, asumilo como precio de venta.
- precioCosto: el precio que le costo a el/ella, si lo menciona ("me costo", "precio de costo", "lo compre a"). Si no lo dice, null.
- stockInicial: la cantidad que tiene, si dice "tengo", "hay", "stock de", "cargar X unidades". Si no lo dice, null.
- unidad: "kg" si vende por kilo o gramos, "litro" si vende por litro, sino "unidad".
- categoria: si menciona una categoria ("es de categoria X", "va en X", "es ropa", "es una bebida"), elegi la que mas se parezca de la LISTA DE CATEGORIAS EXISTENTES que te paso en el mensaje del usuario. Solo devolves un nombre que este LITERAL en esa lista. Si no menciona categoria o ninguna se parece, null.
- precioOferta: si dice que esta "en oferta", "con descuento", "rebajado" a tal precio, ese es el precioOferta (tiene que ser menor al precioVenta). Si no menciona oferta, null.
- Los numeros van sin simbolo de moneda ni puntos de miles, con punto decimal si hace falta.
- Si no podes entender nada util, devolves todos los campos en null.

No expliques nada, no agregues texto, SOLO el JSON.`;

router.post('/dictar-producto', async (req, res) => {
  const texto = (req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ error: 'No se escucho nada.' });
  if (texto.length > 500) return res.status(400).json({ error: 'Es mucho texto, proba mas corto.' });

  const categoriasExistentes = Array.isArray(req.body?.categorias)
    ? req.body.categorias.filter(function (c) { return typeof c === 'string'; }).slice(0, 60) : [];

  const clave = process.env.GROQ_API_KEY;
  if (!clave) return res.status(500).json({ error: 'El dictado no esta disponible ahora.' });

  try {
    const mensajeUsuario = 'LISTA DE CATEGORIAS EXISTENTES: ' +
      (categoriasExistentes.length ? categoriasExistentes.join(', ') : '(no tiene categorias cargadas)') +
      '\n\nLo que dijo: ' + texto;

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + clave
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: PROMPT_DICTADO },
          { role: 'user', content: mensajeUsuario }
        ],
        temperature: 0.1,
        max_tokens: 200,
        response_format: { type: 'json_object' }
      })
    });

    const d = await r.json();
    if (!r.ok) {
      console.error('Groq dictado:', d);
      return res.status(500).json({ error: 'No se pudo interpretar ahora. Proba de nuevo.' });
    }

    const contenido = d.choices?.[0]?.message?.content || '{}';
    let datos;
    try { datos = JSON.parse(contenido); } catch (e) { datos = {}; }

    // la categoria solo se acepta si coincide literal con una de las que existen
    let categoria = typeof datos.categoria === 'string' ? datos.categoria.trim() : null;
    if (categoria && categoriasExistentes.indexOf(categoria) < 0) categoria = null;

    let precioOferta = typeof datos.precioOferta === 'number' ? datos.precioOferta : null;
    const precioVentaOk = typeof datos.precioVenta === 'number' ? datos.precioVenta : null;
    if (precioOferta != null && (precioVentaOk == null || precioOferta >= precioVentaOk)) precioOferta = null;

    res.json({
      nombre: typeof datos.nombre === 'string' ? datos.nombre.trim() : null,
      precioVenta: precioVentaOk,
      precioCosto: typeof datos.precioCosto === 'number' ? datos.precioCosto : null,
      stockInicial: typeof datos.stockInicial === 'number' ? datos.stockInicial : null,
      unidad: ['unidad', 'kg', 'litro'].indexOf(datos.unidad) >= 0 ? datos.unidad : 'unidad',
      categoria: categoria,
      precioOferta: precioOferta
    });
  } catch (e) {
    console.error('dictar-producto:', e.message);
    res.status(500).json({ error: 'No se pudo interpretar ahora.' });
  }
});

// ── sugerir una categoria segun el nombre del producto, mientras el usuario escribe ──
const PROMPT_CATEGORIA = `Sos un asistente que sugiere en que categoria va un producto, segun su nombre, para un comerciante.

Te llega el nombre de un producto (a veces una sola palabra) y la lista de categorias que ese comerciante ya tiene creadas (puede venir vacia). Devolves SOLO un JSON valido, sin texto alrededor, sin markdown:

{"categoria": "string o null", "esNueva": true o false}

Reglas:
- Casi siempre se puede adivinar una categoria, incluso con una sola palabra. Un nombre de producto (aunque sea generico o corto, como "pan", "remeras", "parlante", "pilas", "shampoo") ya alcanza para saber a que rubro pertenece. Se decidido, no seas conservador.
- Si alguna categoria de la lista le queda bien al producto, usa esa exacta, tal cual esta escrita, y esNueva en false.
- Si ninguna de la lista le queda bien (o la lista esta vacia), inventa un nombre de categoria corto y generico que tenga sentido, y esNueva en true. Ejemplos: "pan" -> "Panaderia", "remeras" -> "Ropa", "parlante" -> "Electronica", "coca cola" -> "Bebidas", "shampoo" -> "Perfumeria", "pilas" -> "Ferreteria", "helado" -> "Heladeria", "galletitas" -> "Almacen".
- El nombre de categoria siempre en mayuscula inicial, corto (una o dos palabras), generico (no el nombre del producto en si, sino el rubro al que pertenece).
- SOLO devolves categoria en null si el texto no es un nombre de producto reconocible (por ejemplo esta vacio, son solo numeros, o es una palabra sin sentido).

No expliques nada, SOLO el JSON.`;

router.post('/sugerir-categoria', async (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  const categoriasExistentes = Array.isArray(req.body?.categorias)
    ? req.body.categorias.filter(function (c) { return typeof c === 'string'; }).slice(0, 60) : [];

  if (!nombre || nombre.length < 3) {
    return res.json({ categoria: null });
  }

  const clave = process.env.GROQ_API_KEY;
  if (!clave) return res.json({ categoria: null });

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + clave
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: PROMPT_CATEGORIA },
          { role: 'user', content: 'Producto: ' + nombre + '\nCategorias existentes: ' +
            (categoriasExistentes.length ? categoriasExistentes.join(', ') : '(todavia no tiene ninguna)') }
        ],
        temperature: 0.2,
        max_tokens: 60,
        response_format: { type: 'json_object' }
      })
    });

    const d = await r.json();
    if (!r.ok) return res.json({ categoria: null });

    const contenido = d.choices?.[0]?.message?.content || '{}';
    let datos;
    try { datos = JSON.parse(contenido); } catch (e) { datos = {}; }

    let categoria = typeof datos.categoria === 'string' ? datos.categoria.trim() : null;
    if (categoria && categoria.length > 30) categoria = null;

    // si dijo que ya existe pero en realidad no esta literal en la lista, la tratamos como nueva igual
    const esNueva = !!datos.esNueva || (categoria && categoriasExistentes.indexOf(categoria) < 0);

    res.json({ categoria: categoria, esNueva: !!esNueva });
  } catch (e) {
    res.json({ categoria: null });
  }
});

module.exports = router;
