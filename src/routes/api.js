const express = require('express');
const {
    isNonEmptyString,
    validateCreateInteraccion,
    validateUpdateInteraccion,
    validateInteraccionesQuery,
} = require('../validation');

function createApiRouter(pool, broadcastCambioInteraccion) {
    const router = express.Router();

    async function syncEtiquetas(client, idInteraccion, etiquetas) {
        await client.query('DELETE FROM interaccion_etiquetas WHERE id_interaccion = $1', [idInteraccion]);

        for (const nombreEtiqueta of etiquetas) {
            const tagRes = await client.query(
                `INSERT INTO etiquetas (nombre_etiqueta)
         VALUES ($1)
         ON CONFLICT (nombre_etiqueta)
         DO UPDATE SET nombre_etiqueta = EXCLUDED.nombre_etiqueta
         RETURNING id_etiqueta`,
                [nombreEtiqueta]
            );
            const idEtiqueta = tagRes.rows[0].id_etiqueta;
            await client.query(
                `INSERT INTO interaccion_etiquetas (id_interaccion, id_etiqueta)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
                [idInteraccion, idEtiqueta]
            );
        }
    }

    function buildInteraccionesWhere(filters) {
        const clauses = [];
        const params = [];

        if (filters.id_usuario) {
            params.push(filters.id_usuario);
            clauses.push(`i.id_usuario = $${params.length}`);
        }
        if (filters.id_canal) {
            params.push(filters.id_canal);
            clauses.push(`i.id_canal = $${params.length}`);
        }
        if (filters.id_tipo) {
            params.push(filters.id_tipo);
            clauses.push(`i.id_tipo = $${params.length}`);
        }
        if (filters.id_tema) {
            params.push(filters.id_tema);
            clauses.push(`i.id_tema = $${params.length}`);
        }
        if (filters.id_dispositivo) {
            params.push(filters.id_dispositivo);
            clauses.push(`i.id_dispositivo = $${params.length}`);
        }
        if (filters.id_idioma) {
            params.push(filters.id_idioma);
            clauses.push(`i.id_idioma = $${params.length}`);
        }
        if (filters.id_etiqueta) {
            params.push(filters.id_etiqueta);
            clauses.push(
                `EXISTS (SELECT 1 FROM interaccion_etiquetas ie WHERE ie.id_interaccion = i.id_interaccion AND ie.id_etiqueta = $${params.length})`
            );
        }
        if (filters.desde) {
            params.push(filters.desde);
            clauses.push(`i.timestamp >= $${params.length}`);
        }
        if (filters.hasta) {
            params.push(filters.hasta);
            clauses.push(`i.timestamp <= $${params.length}`);
        }
        if (filters.sentimiento_min !== undefined) {
            params.push(filters.sentimiento_min);
            clauses.push(`i.sentimiento >= $${params.length}`);
        }
        if (filters.sentimiento_max !== undefined) {
            params.push(filters.sentimiento_max);
            clauses.push(`i.sentimiento <= $${params.length}`);
        }
        if (filters.q) {
            params.push(`%${filters.q}%`);
            clauses.push(
                `(i.id_interaccion ILIKE $${params.length} OR i.id_usuario ILIKE $${params.length} OR COALESCE(u_busq.alias, '') ILIKE $${params.length} OR COALESCE(i.texto, '') ILIKE $${params.length})`
            );
        }

        const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        return { whereSql, params };
    }

    function buildEstatusUsuarioFilter(query, params) {
        const clauses = [];
        let joinsSql = '';

        const estatusTexto = typeof query.estatus === 'string' ? query.estatus.trim() : '';
        const idEstatusRaw = query.id_estatus !== undefined && query.id_estatus !== ''
            ? Number.parseInt(query.id_estatus, 10)
            : null;

        if (estatusTexto || (Number.isInteger(idEstatusRaw) && idEstatusRaw > 0)) {
            joinsSql = `
              INNER JOIN usuarios u_est ON u_est.id_usuario = i.id_usuario
              INNER JOIN estatus_usuario eu_est ON eu_est.id_estatus = u_est.id_estatus
            `;

            if (estatusTexto && estatusTexto.toLowerCase() !== 'todos') {
                const limpio = estatusTexto.toLowerCase().trim();
                const normalizado = limpio === 'inactivos' ? 'inactivo' : limpio;
                params.push(normalizado);
                clauses.push(`LOWER(TRIM(eu_est.nombre_estatus)) = $${params.length}`);
            }

            if (Number.isInteger(idEstatusRaw) && idEstatusRaw > 0) {
                params.push(idEstatusRaw);
                clauses.push(`eu_est.id_estatus = $${params.length}`);
            }
        }

        return { joinsSql, estatusClauses: clauses };
    }

    router.get('/resumen', async (req, res, next) => {
        try {
            const [uCount, iStats, qCount] = await Promise.all([
                pool.query('SELECT COUNT(*)::int AS total FROM usuarios'),
                pool.query(
                    `SELECT
             COUNT(*)::int AS total,
             COALESCE(ROUND(AVG(sentimiento)::numeric, 3), 0)::float AS sentimiento_promedio,
             COALESCE(SUM(reacciones_recibidas), 0)::int AS total_reacciones
           FROM interacciones`
                ),
                pool.query('SELECT COUNT(*)::int AS total FROM interacciones_cuarentena'),
            ]);

            return res.status(200).json({
                usuarios_depurados: uCount.rows[0].total,
                interacciones_depuradas: iStats.rows[0].total,
                interacciones_cuarentena: qCount.rows[0].total,
                sentimiento_promedio_interacciones: iStats.rows[0].sentimiento_promedio,
                total_reacciones_recibidas: iStats.rows[0].total_reacciones,
                solicitado_por: req.user.correo,
            });
        } catch (err) {
            return next(err);
        }
    });

    router.get('/historico/resumen', async (req, res, next) => {
        try {
            const agrupacion = req.query.agrupacion === 'mes' ? 'month' : 'day';
            const v = validateInteraccionesQuery({ ...req.query, page: 1, pageSize: 1 });
            if (!v.ok) {
                return res.status(400).json({ error: 'Parámetros de consulta inválidos.', detalles: v.errors });
            }

            const { whereSql, params } = buildInteraccionesWhere(v.filters);
            const sql = `
        SELECT
          DATE_TRUNC('${agrupacion}', i.timestamp AT TIME ZONE 'UTC') AS periodo,
          COUNT(*)::int AS total_interacciones,
          COALESCE(ROUND(AVG(i.sentimiento)::numeric, 3), 0)::float AS sentimiento_promedio,
          COALESCE(SUM(i.reacciones_recibidas), 0)::int AS reacciones_recibidas
        FROM interacciones i
        LEFT JOIN usuarios u_busq ON u_busq.id_usuario = i.id_usuario
        ${whereSql}
        GROUP BY periodo
        ORDER BY periodo ASC
      `;

            const result = await pool.query(sql, params);
            return res.status(200).json({
                agrupacion: agrupacion === 'month' ? 'mes' : 'dia',
                filtros_aplicados: v.filters,
                serie: result.rows,
            });
        } catch (err) {
            return next(err);
        }
    });

    router.get('/catalogos', async (req, res, next) => {
        try {
            const [canales, tipos, temas, dispositivos, idiomas, etiquetas, estatusUsuario] = await Promise.all([
                pool.query('SELECT id_canal, nombre_canal FROM canales ORDER BY id_canal'),
                pool.query('SELECT id_tipo, nombre_tipo FROM tipos_interaccion ORDER BY id_tipo'),
                pool.query('SELECT id_tema, nombre_tema FROM temas ORDER BY id_tema'),
                pool.query('SELECT id_dispositivo, nombre_dispositivo FROM dispositivos ORDER BY id_dispositivo'),
                pool.query('SELECT id_idioma, codigo_idioma FROM idiomas ORDER BY id_idioma'),
                pool.query('SELECT id_etiqueta, nombre_etiqueta FROM etiquetas ORDER BY nombre_etiqueta'),
                pool.query('SELECT id_estatus, nombre_estatus FROM estatus_usuario ORDER BY id_estatus'),
            ]);

            return res.status(200).json({
                canales: canales.rows,
                tipos_interaccion: tipos.rows,
                temas: temas.rows,
                dispositivos: dispositivos.rows,
                idiomas: idiomas.rows,
                etiquetas: etiquetas.rows,
                estatus_usuario: estatusUsuario.rows,
            });
        } catch (err) {
            return next(err);
        }
    });

    router.get('/usuarios', async (req, res, next) => {
        try {
            const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
            const result = await pool.query(
                `SELECT u.id_usuario, u.alias, u.fecha_ingreso, u.ultima_actividad, u.consentimiento_datos,
                e.nombre_estatus AS estatus, p.nombre_plataforma AS plataforma
         FROM usuarios u
         JOIN estatus_usuario e ON e.id_estatus = u.id_estatus
         JOIN plataformas_principales p ON p.id_plataforma = u.id_plataforma
         ORDER BY u.id_usuario ASC
         LIMIT $1`,
                [limit]
            );
            return res.status(200).json({ total: result.rows.length, usuarios: result.rows });
        } catch (err) {
            return next(err);
        }
    });

    router.get('/interacciones', async (req, res, next) => {
        try {
            const v = validateInteraccionesQuery(req.query);
            if (!v.ok) {
                return res.status(400).json({ error: 'Parámetros de búsqueda inválidos.', detalles: v.errors });
            }

            const { page, pageSize, filters } = v;
            const offset = (page - 1) * pageSize;
            const { whereSql, params } = buildInteraccionesWhere(filters);
            const { joinsSql, estatusClauses } = buildEstatusUsuarioFilter(req.query, params);
            const allClauses = [];
            if (whereSql) allClauses.push(whereSql.replace(/^WHERE\s+/i, ''));
            if (estatusClauses.length > 0) allClauses.push(...estatusClauses);
            const fullWhereSql = allClauses.length > 0 ? `WHERE ${allClauses.join(' AND ')}` : '';

            const countRes = await pool.query(
                `SELECT COUNT(*)::int AS total
                 FROM interacciones i
                 LEFT JOIN usuarios u_busq ON u_busq.id_usuario = i.id_usuario
                 ${joinsSql}
                 ${fullWhereSql}`,
                params
            );
            const total = countRes.rows[0].total;
            const totalPages = Math.max(Math.ceil(total / pageSize), 1);

            const dataParams = [...params, pageSize, offset];
            const dataSql = `
        SELECT
          i.id_interaccion,
          i.id_usuario,
          u.alias AS alias_usuario,
          i.id_canal,
          c.nombre_canal AS canal,
          i.id_tipo,
          ti.nombre_tipo AS tipo,
          i.id_tema,
          t.nombre_tema AS tema,
          i.id_dispositivo,
          d.nombre_dispositivo AS dispositivo,
          i.id_idioma,
          idm.codigo_idioma AS idioma,
          i.id_ubicacion,
          i.timestamp,
          i.texto,
          i.sentimiento::float AS sentimiento,
          i.longitud_texto,
          i.reacciones_recibidas,
          COALESCE(
            ARRAY_AGG(et.nombre_etiqueta ORDER BY et.nombre_etiqueta) FILTER (WHERE et.nombre_etiqueta IS NOT NULL),
            '{}'
          ) AS etiquetas
        FROM interacciones i
        JOIN usuarios u ON u.id_usuario = i.id_usuario
        LEFT JOIN usuarios u_busq ON u_busq.id_usuario = i.id_usuario
        JOIN canales c ON c.id_canal = i.id_canal
        JOIN tipos_interaccion ti ON ti.id_tipo = i.id_tipo
        JOIN temas t ON t.id_tema = i.id_tema
        JOIN dispositivos d ON d.id_dispositivo = i.id_dispositivo
        JOIN idiomas idm ON idm.id_idioma = i.id_idioma
        LEFT JOIN interaccion_etiquetas ie ON ie.id_interaccion = i.id_interaccion
        LEFT JOIN etiquetas et ON et.id_etiqueta = ie.id_etiqueta
        ${joinsSql}
        ${fullWhereSql}
        GROUP BY i.id_interaccion, i.id_usuario, u.alias, c.nombre_canal, ti.nombre_tipo, t.nombre_tema, d.nombre_dispositivo, idm.codigo_idioma
        ORDER BY i.timestamp DESC, i.id_interaccion ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;

            const rowsRes = await pool.query(dataSql, dataParams);

            return res.status(200).json({
                page,
                pageSize,
                total,
                totalPages,
                filtros_aplicados: filters,
                interacciones: rowsRes.rows,
            });
        } catch (err) {
            return next(err);
        }
    });

    router.get('/interacciones/:id', async (req, res, next) => {
        try {
            const id = isNonEmptyString(req.params.id) ? req.params.id.trim() : '';
            if (!id || id.length > 20) {
                return res.status(400).json({ error: 'id_interaccion inválido.' });
            }

            const result = await pool.query(
                `SELECT
           i.id_interaccion,
           i.id_usuario,
           u.alias AS alias_usuario,
           i.id_canal,
           c.nombre_canal AS canal,
           i.id_tipo,
           ti.nombre_tipo AS tipo,
           i.id_tema,
           t.nombre_tema AS tema,
           i.id_dispositivo,
           d.nombre_dispositivo AS dispositivo,
           i.id_idioma,
           idm.codigo_idioma AS idioma,
           i.id_ubicacion,
           i.timestamp,
           i.texto,
           i.sentimiento::float AS sentimiento,
           i.longitud_texto,
           i.reacciones_recibidas,
           COALESCE(
             ARRAY_AGG(et.nombre_etiqueta ORDER BY et.nombre_etiqueta) FILTER (WHERE et.nombre_etiqueta IS NOT NULL),
             '{}'
           ) AS etiquetas
         FROM interacciones i
         JOIN usuarios u ON u.id_usuario = i.id_usuario
         JOIN canales c ON c.id_canal = i.id_canal
         JOIN tipos_interaccion ti ON ti.id_tipo = i.id_tipo
         JOIN temas t ON t.id_tema = i.id_tema
         JOIN dispositivos d ON d.id_dispositivo = i.id_dispositivo
         JOIN idiomas idm ON idm.id_idioma = i.id_idioma
         LEFT JOIN interaccion_etiquetas ie ON ie.id_interaccion = i.id_interaccion
         LEFT JOIN etiquetas et ON et.id_etiqueta = ie.id_etiqueta
         WHERE i.id_interaccion = $1
         GROUP BY i.id_interaccion, u.alias, c.nombre_canal, ti.nombre_tipo, t.nombre_tema, d.nombre_dispositivo, idm.codigo_idioma`,
                [id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Interacción no encontrada.' });
            }

            return res.status(200).json({ interaccion: result.rows[0] });
        } catch (err) {
            return next(err);
        }
    });

    router.post('/interacciones', async (req, res, next) => {
        const v = validateCreateInteraccion(req.body);
        if (!v.ok) {
            return res.status(400).json({ error: 'Datos de interacción inválidos.', detalles: v.errors });
        }

        const d = v.data;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const insertSql = `
        INSERT INTO interacciones (
          id_interaccion, id_usuario, id_canal, id_tipo, id_tema,
          id_dispositivo, id_idioma, id_ubicacion, timestamp, texto,
          sentimiento, longitud_texto, reacciones_recibidas
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING *
      `;

            const inserted = await client.query(insertSql, [
                d.id_interaccion,
                d.id_usuario,
                d.id_canal,
                d.id_tipo,
                d.id_tema,
                d.id_dispositivo,
                d.id_idioma,
                d.id_ubicacion,
                d.timestamp,
                d.texto,
                d.sentimiento,
                d.longitud_texto,
                d.reacciones_recibidas,
            ]);

            if (d.etiquetas.length > 0) {
                await syncEtiquetas(client, d.id_interaccion, d.etiquetas);
            }

            await client.query('COMMIT');

            if (typeof broadcastCambioInteraccion === 'function') {
                broadcastCambioInteraccion('creada', {
                    id_interaccion: inserted.rows[0].id_interaccion,
                    id_usuario: inserted.rows[0].id_usuario,
                    sentimiento: Number.parseFloat(inserted.rows[0].sentimiento),
                    reacciones_recibidas: inserted.rows[0].reacciones_recibidas,
                    etiquetas: d.etiquetas,
                });
            }

            return res.status(201).json({
                mensaje: 'Interacción creada correctamente.',
                interaccion: {
                    ...inserted.rows[0],
                    sentimiento: Number.parseFloat(inserted.rows[0].sentimiento),
                    etiquetas: d.etiquetas,
                },
            });
        } catch (err) {
            await client.query('ROLLBACK');
            return next(err);
        } finally {
            client.release();
        }
    });

    router.put('/interacciones/:id', async (req, res, next) => {
        const id = isNonEmptyString(req.params.id) ? req.params.id.trim() : '';
        if (!id || id.length > 20) {
            return res.status(400).json({ error: 'id_interaccion inválido.' });
        }

        const v = validateUpdateInteraccion(req.body);
        if (!v.ok) {
            return res.status(400).json({ error: 'Datos de actualización inválidos.', detalles: v.errors });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            let updatedRow = null;
            const entries = Object.entries(v.updates);

            if (entries.length > 0) {
                const setClauses = entries.map(([col], idx) => `${col} = $${idx + 1}`);
                const values = entries.map(([, val]) => val);
                values.push(id);

                const updateRes = await client.query(
                    `UPDATE interacciones
           SET ${setClauses.join(', ')}
           WHERE id_interaccion = $${values.length}
           RETURNING *`,
                    values
                );

                if (updateRes.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ error: 'Interacción no encontrada.' });
                }
                updatedRow = updateRes.rows[0];
            } else {
                const existsRes = await client.query(
                    'SELECT * FROM interacciones WHERE id_interaccion = $1',
                    [id]
                );
                if (existsRes.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ error: 'Interacción no encontrada.' });
                }
                updatedRow = existsRes.rows[0];
            }

            if (v.etiquetas !== undefined) {
                await syncEtiquetas(client, id, v.etiquetas);
            }

            const tagsRes = await client.query(
                `SELECT et.nombre_etiqueta
         FROM interaccion_etiquetas ie
         JOIN etiquetas et ON et.id_etiqueta = ie.id_etiqueta
         WHERE ie.id_interaccion = $1
         ORDER BY et.nombre_etiqueta`,
                [id]
            );

            await client.query('COMMIT');

            if (typeof broadcastCambioInteraccion === 'function') {
                broadcastCambioInteraccion('actualizada', {
                    id_interaccion: id,
                    id_usuario: updatedRow.id_usuario,
                    texto: updatedRow.texto,
                    sentimiento: Number.parseFloat(updatedRow.sentimiento),
                    reacciones_recibidas: updatedRow.reacciones_recibidas,
                    etiquetas: tagsRes.rows.map((r) => r.nombre_etiqueta),
                });
            }

            return res.status(200).json({
                mensaje: 'Interacción actualizada correctamente.',
                interaccion: {
                    ...updatedRow,
                    sentimiento: Number.parseFloat(updatedRow.sentimiento),
                    etiquetas: tagsRes.rows.map((r) => r.nombre_etiqueta),
                },
            });
        } catch (err) {
            await client.query('ROLLBACK');
            return next(err);
        } finally {
            client.release();
        }
    });

    router.delete('/interacciones/:id', async (req, res, next) => {
        try {
            const id = isNonEmptyString(req.params.id) ? req.params.id.trim() : '';
            if (!id || id.length > 20) {
                return res.status(400).json({ error: 'id_interaccion inválido.' });
            }

            const deleted = await pool.query(
                'DELETE FROM interacciones WHERE id_interaccion = $1 RETURNING id_interaccion',
                [id]
            );

            if (deleted.rows.length === 0) {
                return res.status(404).json({ error: 'Interacción no encontrada.' });
            }

            if (typeof broadcastCambioInteraccion === 'function') {
                broadcastCambioInteraccion('eliminada', {
                    id_interaccion: deleted.rows[0].id_interaccion,
                });
            }

            return res.status(200).json({
                mensaje: 'Interacción eliminada correctamente.',
                id_interaccion: deleted.rows[0].id_interaccion,
            });
        } catch (err) {
            return next(err);
        }
    });

    async function consultarAnalitica(filters = {}, extraQuery = {}) {
        const { whereSql, params } = buildInteraccionesWhere(filters);
        const { joinsSql, estatusClauses } = buildEstatusUsuarioFilter(extraQuery, params);
        const allClauses = [];
        if (whereSql) allClauses.push(whereSql.replace(/^WHERE\s+/i, ''));
        if (estatusClauses.length > 0) allClauses.push(...estatusClauses);
        const fullWhereSql = allClauses.length > 0 ? `WHERE ${allClauses.join(' AND ')}` : '';
        const andSql = allClauses.length > 0 ? `AND ${allClauses.join(' AND ')}` : '';
        const leftJoinsEstatusSql = joinsSql ? joinsSql.replace(/INNER JOIN/gi, 'LEFT JOIN') : '';

        const [
            kpisRes,
            cuarentenaRes,
            usuariosRes,
            canalesRes,
            polaridadRes,
            heatmapRes,
            serieRes,
            estatusRes,
        ] = await Promise.all([
            pool.query(
                `SELECT
                   COUNT(*)::int AS total_interacciones,
                   COALESCE(ROUND(AVG(i.sentimiento)::numeric, 4), 0)::float AS sentimiento_promedio,
                   COALESCE(SUM(i.reacciones_recibidas), 0)::int AS total_reacciones,
                   CASE
                     WHEN COUNT(*) > 0 THEN ROUND((COALESCE(SUM(i.reacciones_recibidas), 0)::numeric / COUNT(*)::numeric), 2)::float
                     ELSE 0
                   END AS engagement_promedio
                 FROM interacciones i
                 LEFT JOIN usuarios u_busq ON u_busq.id_usuario = i.id_usuario
                 ${joinsSql}
                 ${fullWhereSql}`,
                params
            ),
            pool.query('SELECT COUNT(*)::int AS total FROM interacciones_cuarentena'),
            pool.query('SELECT COUNT(*)::int AS total FROM usuarios'),
            pool.query(
                `SELECT
                   c.nombre_canal AS etiqueta,
                   COUNT(i.id_interaccion)::int AS total_interacciones,
                   COALESCE(SUM(i.reacciones_recibidas), 0)::int AS total_reacciones,
                   COALESCE(ROUND(AVG(i.sentimiento)::numeric, 3), 0)::float AS sentimiento_promedio
                 FROM canales c
                 LEFT JOIN interacciones i ON i.id_canal = c.id_canal
                 LEFT JOIN usuarios u_busq ON u_busq.id_usuario = i.id_usuario
                 ${leftJoinsEstatusSql}
                 ${andSql}
                 GROUP BY c.id_canal, c.nombre_canal
                 ORDER BY c.id_canal ASC`,
                params
            ),
            pool.query(
                `SELECT
                   COUNT(*) FILTER (WHERE i.sentimiento > 0.1)::int AS positivo,
                   COUNT(*) FILTER (WHERE i.sentimiento BETWEEN -0.1 AND 0.1)::int AS neutro,
                   COUNT(*) FILTER (WHERE i.sentimiento < -0.1)::int AS negativo
                 FROM interacciones i
                 LEFT JOIN usuarios u_busq ON u_busq.id_usuario = i.id_usuario
                 ${joinsSql}
                 ${fullWhereSql}`,
                params
            ),
            pool.query(
                `SELECT
                   EXTRACT(ISODOW FROM (i.timestamp AT TIME ZONE 'UTC'))::int AS dia_iso,
                   EXTRACT(HOUR FROM (i.timestamp AT TIME ZONE 'UTC'))::int AS hora_utc,
                   COUNT(*)::int AS cantidad
                 FROM interacciones i
                 LEFT JOIN usuarios u_busq ON u_busq.id_usuario = i.id_usuario
                 ${joinsSql}
                 ${fullWhereSql}
                 GROUP BY dia_iso, hora_utc
                 ORDER BY dia_iso ASC, hora_utc ASC`,
                params
            ),
            pool.query(
                `SELECT
                   TO_CHAR(DATE_TRUNC('day', i.timestamp AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS fecha,
                   COUNT(*)::int AS total_interacciones,
                   COALESCE(ROUND(AVG(i.sentimiento)::numeric, 3), 0)::float AS sentimiento_promedio,
                   COALESCE(SUM(i.reacciones_recibidas), 0)::int AS reacciones_recibidas
                 FROM interacciones i
                 LEFT JOIN usuarios u_busq ON u_busq.id_usuario = i.id_usuario
                 ${joinsSql}
                 ${fullWhereSql}
                 GROUP BY DATE_TRUNC('day', i.timestamp AT TIME ZONE 'UTC')
                 ORDER BY fecha ASC`,
                params
            ),
            pool.query(
                `SELECT
                   eu.id_estatus,
                   eu.nombre_estatus AS etiqueta,
                   COUNT(DISTINCT u.id_usuario)::int AS total_usuarios,
                   COUNT(i.id_interaccion)::int AS total_interacciones,
                   COALESCE(ROUND(AVG(i.sentimiento)::numeric, 3), 0)::float AS sentimiento_promedio
                 FROM estatus_usuario eu
                 LEFT JOIN usuarios u ON u.id_estatus = eu.id_estatus
                 LEFT JOIN interacciones i ON i.id_usuario = u.id_usuario
                 LEFT JOIN usuarios u_busq ON u_busq.id_usuario = i.id_usuario
                 ${leftJoinsEstatusSql}
                 ${andSql}
                 GROUP BY eu.id_estatus, eu.nombre_estatus
                 ORDER BY eu.id_estatus ASC`,
                params
            ),
        ]);

        const kpisBase = kpisRes.rows[0];
        const pol = polaridadRes.rows[0];
        const totalPol = pol.positivo + pol.neutro + pol.negativo;

        return {
            definiciones_matematicas: {
                total_interacciones: 'N = |I| (conteo de interacciones depuradas)',
                sentimiento_promedio: 'S_bar = (1 / N) * sum(s_i) para N > 0; 0 si N = 0',
                total_reacciones: 'R_total = sum(r_i)',
                engagement_promedio: 'E_bar = R_total / N para N > 0; 0 si N = 0',
                polaridad: 'P_k = (n_k / N) * 100 donde Positivo: s > 0.1, Neutro: -0.1 <= s <= 0.1, Negativo: s < -0.1',
                mapa_calor: 'H_{d,h} = conteo por dia ISO (1=Lun..7=Dom) y hora UTC (0..23)',
            },
            kpis: {
                usuarios_depurados: usuariosRes.rows[0].total,
                interacciones_depuradas: kpisBase.total_interacciones,
                interacciones_cuarentena: cuarentenaRes.rows[0].total,
                sentimiento_promedio: kpisBase.sentimiento_promedio,
                total_reacciones: kpisBase.total_reacciones,
                engagement_promedio: kpisBase.engagement_promedio,
            },
            barras_canales: canalesRes.rows,
            dona_polaridad: {
                totales: {
                    positivo: pol.positivo,
                    neutro: pol.neutro,
                    negativo: pol.negativo,
                },
                porcentajes: {
                    positivo: totalPol > 0 ? Number(((pol.positivo / totalPol) * 100).toFixed(1)) : 0,
                    neutro: totalPol > 0 ? Number(((pol.neutro / totalPol) * 100).toFixed(1)) : 0,
                    negativo: totalPol > 0 ? Number(((pol.negativo / totalPol) * 100).toFixed(1)) : 0,
                },
            },
            heatmap: heatmapRes.rows,
            serie_historica: serieRes.rows,
            por_estatus_usuario: estatusRes.rows,
        };
    }

    router.get('/analitica/estadisticas', async (req, res, next) => {
        try {
            const v = validateInteraccionesQuery({ ...req.query, page: 1, pageSize: 1 });
            if (!v.ok) {
                return res.status(400).json({ error: 'Parámetros de filtro inválidos.', detalles: v.errors });
            }
            const analitica = await consultarAnalitica(v.filters, req.query);
            return res.status(200).json({
                filtros_aplicados: v.filters,
                ...analitica,
            });
        } catch (err) {
            return next(err);
        }
    });

    return router;
}

module.exports = { createApiRouter };