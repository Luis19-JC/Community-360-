const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');

function parseCookies(cookieHeader = '') {
  const cookies = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const key = part.slice(0, idx).trim();
      const val = decodeURIComponent(part.slice(idx + 1).trim());
      cookies[key] = val;
    }
  }
  return cookies;
}

async function obtenerMetricasTiempoReal(pool) {
  const [kpisRes, polRes, canalesRes, heatRes] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS total_interacciones,
        COALESCE(ROUND(AVG(sentimiento)::numeric, 4), 0)::float AS sentimiento_promedio,
        COALESCE(SUM(reacciones_recibidas), 0)::int AS total_reacciones,
        CASE
          WHEN COUNT(*) > 0 THEN ROUND((COALESCE(SUM(reacciones_recibidas), 0)::numeric / COUNT(*)::numeric), 2)::float
          ELSE 0
        END AS engagement_promedio
      FROM interacciones
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE sentimiento > 0.1)::int AS positivo,
        COUNT(*) FILTER (WHERE sentimiento BETWEEN -0.1 AND 0.1)::int AS neutro,
        COUNT(*) FILTER (WHERE sentimiento < -0.1)::int AS negativo
      FROM interacciones
    `),
    pool.query(`
      SELECT
        c.nombre_canal AS etiqueta,
        COUNT(i.id_interaccion)::int AS total_interacciones,
        COALESCE(SUM(i.reacciones_recibidas), 0)::int AS total_reacciones
      FROM canales c
      LEFT JOIN interacciones i ON i.id_canal = c.id_canal
      GROUP BY c.id_canal, c.nombre_canal
      ORDER BY c.id_canal ASC
    `),
    pool.query(`
      SELECT
        EXTRACT(ISODOW FROM (timestamp AT TIME ZONE 'UTC'))::int AS dia_iso,
        EXTRACT(HOUR FROM (timestamp AT TIME ZONE 'UTC'))::int AS hora_utc,
        COUNT(*)::int AS cantidad
      FROM interacciones
      GROUP BY dia_iso, hora_utc
      ORDER BY dia_iso ASC, hora_utc ASC
    `),
  ]);

  const k = kpisRes.rows[0];
  const p = polRes.rows[0];
  return {
    kpis: {
      interacciones_depuradas: k.total_interacciones,
      sentimiento_promedio: k.sentimiento_promedio,
      total_reacciones: k.total_reacciones,
      engagement_promedio: k.engagement_promedio,
    },
    dona_polaridad: {
      positivo: p.positivo,
      neutro: p.neutro,
      negativo: p.negativo,
    },
    barras_canales: canalesRes.rows,
    heatmap: heatRes.rows,
  };
}

function initWebSocket(server, { jwtSecret, cookieName, pool }) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies[cookieName];

    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let user;
    try {
      user = jwt.verify(token, jwtSecret);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.send(
      JSON.stringify({
        type: 'conexion_establecida',
        usuario: ws.user?.correo || null,
        timestamp: new Date().toISOString(),
      })
    );

    ws.on('message', async (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());

        if (msg?.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          return;
        }

        if (msg?.type === 'solicitar_analitica' && pool) {
          const metricas = await obtenerMetricasTiempoReal(pool);
          ws.send(
            JSON.stringify({
              type: 'analitica_actualizada',
              metricas,
              timestamp: new Date().toISOString(),
            })
          );
        }
      } catch {
        ws.send(
          JSON.stringify({
            type: 'error',
            mensaje: 'Mensaje WebSocket inválido (se espera JSON).',
          })
        );
      }
    });
  });

  async function broadcastCambioInteraccion(accion, datos) {
    let metricas = null;
    if (pool) {
      try {
        metricas = await obtenerMetricasTiempoReal(pool);
      } catch (err) {
        console.error('Error calculando métricas en tiempo real para WS:', err);
      }
    }

    const payload = JSON.stringify({
      type: 'interaccion_cambio',
      accion, // 'creada' | 'actualizada' | 'eliminada'
      datos,
      metricas,
      timestamp: new Date().toISOString(),
    });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  return { wss, broadcastCambioInteraccion };
}

module.exports = { initWebSocket };