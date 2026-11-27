const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { Pool } = require('pg');

const USUARIOS_CSV = path.join(__dirname, '../data/raw/comunidad_virtual_usuarios.csv');
const INTERACCIONES_CSV = path.join(__dirname, '../data/raw/comunidad_virtual_1000_interacciones.csv');

const cleanStr = (val) => {
    if (val === undefined || val === null) return null;
    const s = String(val).trim();
    return s === '' ? null : s;
};

const parseFechaDDMMYYYY = (val) => {
    const s = cleanStr(val);
    if (!s) return null;
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (!m) return null;
    const [, dd, mm, yyyy] = m;
    const iso = `${yyyy}-${mm}-${dd}`;
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : iso;
};

const parseIntStrict = (val) => {
    const s = cleanStr(val);
    if (s === null || !/^-?\d+$/.test(s)) return null;
    const n = Number.parseInt(s, 10);
    return Number.isSafeInteger(n) ? n : null;
};

const parseFloatStrict = (val) => {
    const s = cleanStr(val);
    if (s === null || !/^-?\d+(\.\d+)?$/.test(s)) return null;
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : null;
};

async function runETL() {
    if (!process.env.DATABASE_URL) {
        throw new Error('Falta DATABASE_URL en el archivo .env');
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });

    // Lectura de CSV de entrada
    const rawUsuarios = parse(fs.readFileSync(USUARIOS_CSV, 'utf8'), {
        columns: true,
        skip_empty_lines: true,
        bom: true,
    });
    const rawInteracciones = parse(fs.readFileSync(INTERACCIONES_CSV, 'utf8'), {
        columns: true,
        skip_empty_lines: true,
        bom: true,
    });

    // ETAPA 1, 2, 3, 4 y 6 en USUARIOS
    const seenUserIds = new Set();
    const seenAliases = new Set();
    const usuariosLimpios = [];

    for (const row of rawUsuarios) {
        const id_usuario = cleanStr(row.id_usuario);
        const alias = cleanStr(row.alias);
        if (!id_usuario || !alias) continue;
        if (seenUserIds.has(id_usuario) || seenAliases.has(alias.toLowerCase())) continue;

        const fecha_ingreso = parseFechaDDMMYYYY(row.fecha_ingreso);
        const ultima_actividad = parseFechaDDMMYYYY(row.ultima_actividad);
        const rango_edad = cleanStr(row.rango_edad);
        const especie_fursona = cleanStr(row.especie_fursona);
        const interes_principal = cleanStr(row.interes_principal);
        const plataforma_principal = cleanStr(row.plataforma_principal);
        const estatus = cleanStr(row.estatus)?.toLowerCase() || null;
        const consentRaw = cleanStr(row.consentimiento_datos)?.toLowerCase();
        const consentimiento_datos = consentRaw === 'si' || consentRaw === 'no' ? consentRaw : null;

        const es_artista = parseIntStrict(row.es_artista);
        const mensajes_30d = parseIntStrict(row.mensajes_30d);
        const reacciones_30d = parseIntStrict(row.reacciones_30d);
        const eventos_asistidos = parseIntStrict(row.eventos_asistidos);
        const comisiones_compradas = parseIntStrict(row.comisiones_compradas);
        const sentimiento_promedio = parseFloatStrict(row.sentimiento_promedio);

        if (
            !fecha_ingreso ||
            !ultima_actividad ||
            !rango_edad ||
            !especie_fursona ||
            !interes_principal ||
            !plataforma_principal ||
            !estatus ||
            !consentimiento_datos ||
            (es_artista !== 0 && es_artista !== 1) ||
            mensajes_30d === null || mensajes_30d < 0 ||
            reacciones_30d === null || reacciones_30d < 0 ||
            eventos_asistidos === null || eventos_asistidos < 0 ||
            comisiones_compradas === null || comisiones_compradas < 0 ||
            sentimiento_promedio === null || sentimiento_promedio < -1 || sentimiento_promedio > 1
        ) {
            continue;
        }

        // Etapa 6: Eliminación de datos geográficos sin consentimiento
        let pais = cleanStr(row.pais);
        let estado = cleanStr(row.estado);
        let ciudad = cleanStr(row.ciudad);
        let zona_horaria = cleanStr(row.zona_horaria);
        let latitud = parseFloatStrict(row.latitud);
        let longitud = parseFloatStrict(row.longitud);

        if (latitud !== null && (latitud < -90 || latitud > 90)) latitud = null;
        if (longitud !== null && (longitud < -180 || longitud > 180)) longitud = null;

        if (consentimiento_datos === 'no') {
            pais = null;
            estado = null;
            ciudad = null;
            zona_horaria = null;
            latitud = null;
            longitud = null;
        }

        seenUserIds.add(id_usuario);
        seenAliases.add(alias.toLowerCase());

        usuariosLimpios.push({
            id_usuario,
            alias,
            fecha_ingreso,
            pais,
            estado,
            ciudad,
            latitud,
            longitud,
            zona_horaria,
            rango_edad,
            especie_fursona,
            interes_principal,
            plataforma_principal,
            es_artista,
            mensajes_30d,
            reacciones_30d,
            eventos_asistidos,
            comisiones_compradas,
            sentimiento_promedio,
            ultima_actividad,
            estatus,
            consentimiento_datos,
        });
    }

    const validUserIds = new Set(usuariosLimpios.map((u) => u.id_usuario));

    // ETAPA 1, 2, 3, 4 y 5 en INTERACCIONES
    const seenInteracciones = new Set();
    const interaccionesLimpias = [];
    const cuarentena = [];
    const ahoraIso = new Date().toISOString();

    for (const row of rawInteracciones) {
        const id_interaccion = cleanStr(row.id_interaccion) || `SIN_ID_${cuarentena.length + 1}`;
        const id_usuario = cleanStr(row.id_usuario) || 'SIN_USUARIO';
        const tsRaw = cleanStr(row.timestamp);
        const tsDate = tsRaw ? new Date(tsRaw) : null;
        const timestamp = tsDate && !Number.isNaN(tsDate.getTime()) ? tsDate.toISOString() : null;

        const canal = cleanStr(row.canal);
        const tipo = cleanStr(row.tipo)?.toLowerCase() || null;
        const texto = cleanStr(row.texto);
        const tema = cleanStr(row.tema)?.toLowerCase() || null;
        const sentimiento = parseFloatStrict(row.sentimiento);
        const idioma = cleanStr(row.idioma)?.toLowerCase() || null;
        const pais = cleanStr(row.pais);
        const estado = cleanStr(row.estado);
        const ciudad = cleanStr(row.ciudad);
        const dispositivo = cleanStr(row.dispositivo);
        const longitud_texto = parseIntStrict(row.longitud_texto);
        const reacciones_recibidas = parseIntStrict(row.reacciones_recibidas);

        const etiquetasRaw = cleanStr(row.etiquetas);
        const etiquetas = etiquetasRaw
            ? [...new Set(etiquetasRaw.split('|').map((t) => t.trim().toLowerCase()).filter(Boolean))]
            : [];

        if (!cleanStr(row.id_interaccion)) {
            cuarentena.push({
                id_interaccion,
                id_usuario_origen: id_usuario,
                timestamp: timestamp || ahoraIso,
                canal: canal || 'desconocido',
                tipo: tipo || 'desconocido',
                texto,
                tema: tema || 'general',
                dispositivo: dispositivo || 'desconocido',
                etiquetas_raw: etiquetasRaw,
                motivo_rechazo: 'id_interaccion faltante o vacío',
                fecha_cuarentena: ahoraIso,
            });
            continue;
        }

        if (seenInteracciones.has(id_interaccion)) {
            cuarentena.push({
                id_interaccion: `${id_interaccion}_DUP_${cuarentena.length + 1}`,
                id_usuario_origen: id_usuario,
                timestamp: timestamp || ahoraIso,
                canal: canal || 'desconocido',
                tipo: tipo || 'desconocido',
                texto,
                tema: tema || 'general',
                dispositivo: dispositivo || 'desconocido',
                etiquetas_raw: etiquetasRaw,
                motivo_rechazo: 'id_interaccion duplicado',
                fecha_cuarentena: ahoraIso,
            });
            continue;
        }
        seenInteracciones.add(id_interaccion);

        // Etapa 5: Referencia hacia usuarios
        if (!validUserIds.has(id_usuario)) {
            cuarentena.push({
                id_interaccion,
                id_usuario_origen: id_usuario,
                timestamp: timestamp || ahoraIso,
                canal: canal || 'desconocido',
                tipo: tipo || 'desconocido',
                texto,
                tema: tema || 'general',
                dispositivo: dispositivo || 'desconocido',
                etiquetas_raw: etiquetasRaw,
                motivo_rechazo: `id_usuario inexistente en usuarios (${id_usuario})`,
                fecha_cuarentena: ahoraIso,
            });
            continue;
        }

        // Etapa 4: Validación de tipos y rangos
        if (
            !timestamp ||
            !canal ||
            !tipo ||
            !tema ||
            !dispositivo ||
            !idioma ||
            sentimiento === null || sentimiento < -1 || sentimiento > 1 ||
            longitud_texto === null || longitud_texto < 0 ||
            reacciones_recibidas === null || reacciones_recibidas < 0
        ) {
            cuarentena.push({
                id_interaccion,
                id_usuario_origen: id_usuario,
                timestamp: timestamp || ahoraIso,
                canal: canal || 'desconocido',
                tipo: tipo || 'desconocido',
                texto,
                tema: tema || 'general',
                dispositivo: dispositivo || 'desconocido',
                etiquetas_raw: etiquetasRaw,
                motivo_rechazo: 'Tipo de dato inválido o campo obligatorio faltante',
                fecha_cuarentena: ahoraIso,
            });
            continue;
        }

        interaccionesLimpias.push({
            id_interaccion,
            id_usuario,
            timestamp,
            canal,
            tipo,
            texto,
            tema,
            sentimiento,
            idioma,
            pais,
            estado,
            ciudad,
            dispositivo,
            longitud_texto,
            reacciones_recibidas,
            etiquetas,
        });
    }

    // ETAPA 7: Generación de archivos depurados locales
    fs.writeFileSync(
        path.join(__dirname, '../data/processed/usuarios_depurados.csv'),
        stringify(usuariosLimpios, { header: true }),
        'utf8'
    );
    fs.writeFileSync(
        path.join(__dirname, '../data/processed/interacciones_depuradas.csv'),
        stringify(
            interaccionesLimpias.map((x) => ({ ...x, etiquetas: x.etiquetas.join('|') })),
            { header: true }
        ),
        'utf8'
    );
    fs.writeFileSync(
        path.join(__dirname, '../data/processed/interacciones_cuarentena.csv'),
        stringify(cuarentena, { header: true }),
        'utf8'
    );

    // ETAPA 8: Carga en PostgreSQL (Render)
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Catálogos de usuarios
        for (const r of [...new Set(usuariosLimpios.map((u) => u.rango_edad))]) {
            await client.query(
                'INSERT INTO rangos_edad (etiqueta_rango) VALUES ($1) ON CONFLICT (etiqueta_rango) DO NOTHING',
                [r]
            );
        }
        for (const e of [...new Set(usuariosLimpios.map((u) => u.especie_fursona))]) {
            await client.query(
                'INSERT INTO especies_fursona (nombre_especie) VALUES ($1) ON CONFLICT (nombre_especie) DO NOTHING',
                [e]
            );
        }
        for (const n of [...new Set(usuariosLimpios.map((u) => u.interes_principal))]) {
            await client.query(
                'INSERT INTO intereses_principales (nombre_interes) VALUES ($1) ON CONFLICT (nombre_interes) DO NOTHING',
                [n]
            );
        }
        for (const p of [...new Set(usuariosLimpios.map((u) => u.plataforma_principal))]) {
            await client.query(
                'INSERT INTO plataformas_principales (nombre_plataforma) VALUES ($1) ON CONFLICT (nombre_plataforma) DO NOTHING',
                [p]
            );
        }
        for (const s of [...new Set(usuariosLimpios.map((u) => u.estatus))]) {
            await client.query(
                'INSERT INTO estatus_usuario (nombre_estatus) VALUES ($1) ON CONFLICT (nombre_estatus) DO NOTHING',
                [s]
            );
        }

        // Ubicaciones (solo cuando hay pais, estado, ciudad y consentimiento != 'no')
        const ubicacionMap = new Map();
        const allGeoRows = [
            ...usuariosLimpios
                .filter((u) => u.consentimiento_datos === 'si' && u.pais && u.estado && u.ciudad)
                .map((u) => ({ pais: u.pais, estado: u.estado, ciudad: u.ciudad, zona_horaria: u.zona_horaria })),
            ...interaccionesLimpias
                .filter((i) => i.pais && i.estado && i.ciudad)
                .map((i) => ({ pais: i.pais, estado: i.estado, ciudad: i.ciudad, zona_horaria: null })),
        ];

        for (const g of allGeoRows) {
            const key = `${g.pais}||${g.estado}||${g.ciudad}||${g.zona_horaria || ''}`;
            if (!ubicacionMap.has(key)) {
                const res = await client.query(
                    `INSERT INTO ubicaciones (pais, estado, ciudad, zona_horaria)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (pais, estado, ciudad, zona_horaria)
           DO UPDATE SET zona_horaria = COALESCE(ubicaciones.zona_horaria, EXCLUDED.zona_horaria)
           RETURNING id_ubicacion`,
                    [g.pais, g.estado, g.ciudad, g.zona_horaria]
                );
                ubicacionMap.set(key, res.rows[0].id_ubicacion);
            }
        }

        // Mapas de IDs de catálogos de usuarios
        const rangoMap = new Map((await client.query('SELECT id_rango_edad, etiqueta_rango FROM rangos_edad')).rows.map((x) => [x.etiqueta_rango, x.id_rango_edad]));
        const especieMap = new Map((await client.query('SELECT id_especie, nombre_especie FROM especies_fursona')).rows.map((x) => [x.nombre_especie, x.id_especie]));
        const interesMap = new Map((await client.query('SELECT id_interes, nombre_interes FROM intereses_principales')).rows.map((x) => [x.nombre_interes, x.id_interes]));
        const plataformaMap = new Map((await client.query('SELECT id_plataforma, nombre_plataforma FROM plataformas_principales')).rows.map((x) => [x.nombre_plataforma, x.id_plataforma]));
        const estatusMap = new Map((await client.query('SELECT id_estatus, nombre_estatus FROM estatus_usuario')).rows.map((x) => [x.nombre_estatus, x.id_estatus]));

        // Carga de usuarios
        for (const u of usuariosLimpios) {
            const id_ubicacion =
                u.consentimiento_datos === 'si' && u.pais && u.estado && u.ciudad
                    ? ubicacionMap.get(`${u.pais}||${u.estado}||${u.ciudad}||${u.zona_horaria || ''}`) || null
                    : null;

            await client.query(
                `INSERT INTO usuarios (
          id_usuario, alias, fecha_ingreso, id_ubicacion, latitud, longitud,
          id_rango_edad, id_especie, id_interes, id_plataforma, es_artista,
          mensajes_30d, reacciones_30d, eventos_asistidos, comisiones_compradas,
          sentimiento_promedio, ultima_actividad, id_estatus, consentimiento_datos
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15,
          $16, $17, $18, $19
        ) ON CONFLICT (id_usuario) DO NOTHING`,
                [
                    u.id_usuario,
                    u.alias,
                    u.fecha_ingreso,
                    id_ubicacion,
                    u.latitud,
                    u.longitud,
                    rangoMap.get(u.rango_edad),
                    especieMap.get(u.especie_fursona),
                    interesMap.get(u.interes_principal),
                    plataformaMap.get(u.plataforma_principal),
                    u.es_artista,
                    u.mensajes_30d,
                    u.reacciones_30d,
                    u.eventos_asistidos,
                    u.comisiones_compradas,
                    u.sentimiento_promedio,
                    u.ultima_actividad,
                    estatusMap.get(u.estatus),
                    u.consentimiento_datos,
                ]
            );
        }

        // Catálogos de interacciones
        for (const c of [...new Set(interaccionesLimpias.map((i) => i.canal))]) {
            await client.query('INSERT INTO canales (nombre_canal) VALUES ($1) ON CONFLICT (nombre_canal) DO NOTHING', [c]);
        }
        for (const t of [...new Set(interaccionesLimpias.map((i) => i.tipo))]) {
            await client.query('INSERT INTO tipos_interaccion (nombre_tipo) VALUES ($1) ON CONFLICT (nombre_tipo) DO NOTHING', [t]);
        }
        for (const tm of [...new Set(interaccionesLimpias.map((i) => i.tema))]) {
            await client.query('INSERT INTO temas (nombre_tema) VALUES ($1) ON CONFLICT (nombre_tema) DO NOTHING', [tm]);
        }
        for (const d of [...new Set(interaccionesLimpias.map((i) => i.dispositivo))]) {
            await client.query('INSERT INTO dispositivos (nombre_dispositivo) VALUES ($1) ON CONFLICT (nombre_dispositivo) DO NOTHING', [d]);
        }
        for (const l of [...new Set(interaccionesLimpias.map((i) => i.idioma))]) {
            await client.query('INSERT INTO idiomas (codigo_idioma) VALUES ($1) ON CONFLICT (codigo_idioma) DO NOTHING', [l]);
        }

        const canalMap = new Map((await client.query('SELECT id_canal, nombre_canal FROM canales')).rows.map((x) => [x.nombre_canal, x.id_canal]));
        const tipoMap = new Map((await client.query('SELECT id_tipo, nombre_tipo FROM tipos_interaccion')).rows.map((x) => [x.nombre_tipo, x.id_tipo]));
        const temaMap = new Map((await client.query('SELECT id_tema, nombre_tema FROM temas')).rows.map((x) => [x.nombre_tema, x.id_tema]));
        const dispMap = new Map((await client.query('SELECT id_dispositivo, nombre_dispositivo FROM dispositivos')).rows.map((x) => [x.nombre_dispositivo, x.id_dispositivo]));
        const idiomaMap = new Map((await client.query('SELECT id_idioma, codigo_idioma FROM idiomas')).rows.map((x) => [x.codigo_idioma, x.id_idioma]));

        // Carga de interacciones y etiquetas
        for (const inter of interaccionesLimpias) {
            const id_ubicacion =
                inter.pais && inter.estado && inter.ciudad
                    ? ubicacionMap.get(`${inter.pais}||${inter.estado}||${inter.ciudad}||`) || null
                    : null;

            await client.query(
                `INSERT INTO interacciones (
          id_interaccion, id_usuario, id_canal, id_tipo, id_tema,
          id_dispositivo, id_idioma, id_ubicacion, timestamp, texto,
          sentimiento, longitud_texto, reacciones_recibidas
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13
        ) ON CONFLICT (id_interaccion) DO NOTHING`,
                [
                    inter.id_interaccion,
                    inter.id_usuario,
                    canalMap.get(inter.canal),
                    tipoMap.get(inter.tipo),
                    temaMap.get(inter.tema),
                    dispMap.get(inter.dispositivo),
                    idiomaMap.get(inter.idioma),
                    id_ubicacion,
                    inter.timestamp,
                    inter.texto,
                    inter.sentimiento,
                    inter.longitud_texto,
                    inter.reacciones_recibidas,
                ]
            );

            for (const tag of inter.etiquetas) {
                const tagRes = await client.query(
                    `INSERT INTO etiquetas (nombre_etiqueta) VALUES ($1)
           ON CONFLICT (nombre_etiqueta) DO UPDATE SET nombre_etiqueta = EXCLUDED.nombre_etiqueta
           RETURNING id_etiqueta`,
                    [tag]
                );
                const id_etiqueta = tagRes.rows[0].id_etiqueta;
                await client.query(
                    `INSERT INTO interaccion_etiquetas (id_interaccion, id_etiqueta)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                    [inter.id_interaccion, id_etiqueta]
                );
            }
        }

        // Carga de cuarentena
        for (const q of cuarentena) {
            await client.query(
                `INSERT INTO interacciones_cuarentena (
          id_interaccion, id_usuario_origen, timestamp, canal, tipo,
          texto, tema, dispositivo, etiquetas_raw, motivo_rechazo, fecha_cuarentena
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id_interaccion) DO NOTHING`,
                [
                    q.id_interaccion,
                    q.id_usuario_origen,
                    q.timestamp,
                    q.canal,
                    q.tipo,
                    q.texto,
                    q.tema,
                    q.dispositivo,
                    q.etiquetas_raw,
                    q.motivo_rechazo,
                    q.fecha_cuarentena,
                ]
            );
        }

        await client.query('COMMIT');
        console.log('ETL completado con éxito:', {
            usuarios_cargados: usuariosLimpios.length,
            interacciones_cargadas: interaccionesLimpias.length,
            interacciones_cuarentena: cuarentena.length,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

runETL().catch((err) => {
    console.error('Error en ETL:', err);
    process.exit(1);
});