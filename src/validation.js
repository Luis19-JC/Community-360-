function isNonEmptyString(val) {
    return typeof val === 'string' && val.trim().length > 0;
}

function parsePositiveInt(val) {
    if (typeof val === 'number' && Number.isInteger(val) && val > 0) return val;
    if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
        const n = Number.parseInt(val.trim(), 10);
        return n > 0 ? n : null;
    }
    return null;
}

function parseNonNegativeInt(val) {
    if (typeof val === 'number' && Number.isInteger(val) && val >= 0) return val;
    if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
        const n = Number.parseInt(val.trim(), 10);
        return n >= 0 ? n : null;
    }
    return null;
}

function parseSentiment(val) {
    if (val === null || val === undefined || val === '') return null;
    const num = typeof val === 'number' ? val : Number.parseFloat(String(val).trim());
    if (!Number.isFinite(num) || num < -1 || num > 1) return null;
    return Math.round(num * 100) / 100;
}

function parseIsoDate(val) {
    if (!isNonEmptyString(val)) return null;
    const d = new Date(val.trim());
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
}

function validateEtiquetasInput(rawEtiquetas) {
    if (rawEtiquetas === undefined || rawEtiquetas === null) return [];
    if (!Array.isArray(rawEtiquetas)) return null;

    const cleaned = [];
    const seen = new Set();
    for (const item of rawEtiquetas) {
        if (typeof item !== 'string') return null;
        const tag = item.trim().toLowerCase();
        if (!tag) continue;
        if (tag.length > 40) return null;
        if (!seen.has(tag)) {
            seen.add(tag);
            cleaned.push(tag);
        }
    }
    return cleaned;
}

function validateCreateInteraccion(body) {
    const errors = [];
    if (!body || typeof body !== 'object') {
        return { ok: false, errors: ['El cuerpo de la petición debe ser un objeto JSON.'] };
    }

    const idInteraccion = isNonEmptyString(body.id_interaccion) ? body.id_interaccion.trim() : '';
    if (!idInteraccion || idInteraccion.length > 20) {
        errors.push('id_interaccion es obligatorio y debe tener máximo 20 caracteres.');
    }

    const idUsuario = isNonEmptyString(body.id_usuario) ? body.id_usuario.trim() : '';
    if (!idUsuario || idUsuario.length > 20) {
        errors.push('id_usuario es obligatorio y debe tener máximo 20 caracteres.');
    }

    const idCanal = parsePositiveInt(body.id_canal);
    if (!idCanal) errors.push('id_canal debe ser un entero positivo.');

    const idTipo = parsePositiveInt(body.id_tipo);
    if (!idTipo) errors.push('id_tipo debe ser un entero positivo.');

    const idTema = parsePositiveInt(body.id_tema);
    if (!idTema) errors.push('id_tema debe ser un entero positivo.');

    const idDispositivo = parsePositiveInt(body.id_dispositivo);
    if (!idDispositivo) errors.push('id_dispositivo debe ser un entero positivo.');

    const idIdioma = parsePositiveInt(body.id_idioma);
    if (!idIdioma) errors.push('id_idioma debe ser un entero positivo.');

    let idUbicacion = null;
    if (body.id_ubicacion !== undefined && body.id_ubicacion !== null && body.id_ubicacion !== '') {
        idUbicacion = parsePositiveInt(body.id_ubicacion);
        if (!idUbicacion) errors.push('id_ubicacion debe ser un entero positivo o nulo.');
    }

    const timestamp = parseIsoDate(body.timestamp);
    if (!timestamp) errors.push('timestamp es obligatorio y debe ser una fecha/hora válida.');

    let texto = null;
    if (body.texto !== undefined && body.texto !== null) {
        if (typeof body.texto !== 'string') {
            errors.push('texto debe ser una cadena de texto.');
        } else {
            texto = body.texto;
        }
    }

    const sentimiento = parseSentiment(body.sentimiento);
    if (sentimiento === null) {
        errors.push('sentimiento es obligatorio y debe ser un número entre -1 y 1.');
    }

    let longitudTexto;
    if (body.longitud_texto === undefined || body.longitud_texto === null || body.longitud_texto === '') {
        longitudTexto = texto ? texto.length : 0;
    } else {
        longitudTexto = parseNonNegativeInt(body.longitud_texto);
        if (longitudTexto === null) errors.push('longitud_texto debe ser un entero mayor o igual a 0.');
    }

    let reaccionesRecibidas = 0;
    if (body.reacciones_recibidas !== undefined && body.reacciones_recibidas !== null && body.reacciones_recibidas !== '') {
        reaccionesRecibidas = parseNonNegativeInt(body.reacciones_recibidas);
        if (reaccionesRecibidas === null) {
            errors.push('reacciones_recibidas debe ser un entero mayor o igual a 0.');
        }
    }

    const etiquetas = validateEtiquetasInput(body.etiquetas);
    if (etiquetas === null) {
        errors.push('etiquetas debe ser un arreglo de textos de máximo 40 caracteres cada uno.');
    }

    if (errors.length > 0) return { ok: false, errors };

    return {
        ok: true,
        data: {
            id_interaccion: idInteraccion,
            id_usuario: idUsuario,
            id_canal: idCanal,
            id_tipo: idTipo,
            id_tema: idTema,
            id_dispositivo: idDispositivo,
            id_idioma: idIdioma,
            id_ubicacion: idUbicacion,
            timestamp,
            texto,
            sentimiento,
            longitud_texto: longitudTexto,
            reacciones_recibidas: reaccionesRecibidas,
            etiquetas: etiquetas || [],
        },
    };
}

function validateUpdateInteraccion(body) {
    const errors = [];
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, errors: ['El cuerpo de la petición debe ser un objeto JSON.'] };
    }

    const updates = {};

    if (body.id_usuario !== undefined) {
        if (!isNonEmptyString(body.id_usuario) || body.id_usuario.trim().length > 20) {
            errors.push('id_usuario debe ser un texto válido de máximo 20 caracteres.');
        } else {
            updates.id_usuario = body.id_usuario.trim();
        }
    }

    const fkFields = ['id_canal', 'id_tipo', 'id_tema', 'id_dispositivo', 'id_idioma'];
    for (const field of fkFields) {
        if (body[field] !== undefined) {
            const parsed = parsePositiveInt(body[field]);
            if (!parsed) errors.push(`${field} debe ser un entero positivo.`);
            else updates[field] = parsed;
        }
    }

    if (body.id_ubicacion !== undefined) {
        if (body.id_ubicacion === null || body.id_ubicacion === '') {
            updates.id_ubicacion = null;
        } else {
            const parsed = parsePositiveInt(body.id_ubicacion);
            if (!parsed) errors.push('id_ubicacion debe ser un entero positivo o nulo.');
            else updates.id_ubicacion = parsed;
        }
    }

    if (body.timestamp !== undefined) {
        const parsedTs = parseIsoDate(body.timestamp);
        if (!parsedTs) errors.push('timestamp debe ser una fecha/hora válida.');
        else updates.timestamp = parsedTs;
    }

    if (body.texto !== undefined) {
        if (body.texto === null) {
            updates.texto = null;
        } else if (typeof body.texto !== 'string') {
            errors.push('texto debe ser una cadena de texto o nulo.');
        } else {
            updates.texto = body.texto;
        }
    }

    if (body.sentimiento !== undefined) {
        const parsedSent = parseSentiment(body.sentimiento);
        if (parsedSent === null) errors.push('sentimiento debe ser un número entre -1 y 1.');
        else updates.sentimiento = parsedSent;
    }

    if (body.longitud_texto !== undefined) {
        const parsedLen = parseNonNegativeInt(body.longitud_texto);
        if (parsedLen === null) errors.push('longitud_texto debe ser un entero mayor o igual a 0.');
        else updates.longitud_texto = parsedLen;
    } else if (updates.texto !== undefined && body.longitud_texto === undefined) {
        updates.longitud_texto = updates.texto ? updates.texto.length : 0;
    }

    if (body.reacciones_recibidas !== undefined) {
        const parsedReac = parseNonNegativeInt(body.reacciones_recibidas);
        if (parsedReac === null) errors.push('reacciones_recibidas debe ser un entero mayor o igual a 0.');
        else updates.reacciones_recibidas = parsedReac;
    }

    let etiquetas = undefined;
    if (body.etiquetas !== undefined) {
        etiquetas = validateEtiquetasInput(body.etiquetas);
        if (etiquetas === null) {
            errors.push('etiquetas debe ser un arreglo de textos de máximo 40 caracteres cada uno.');
        }
    }

    if (Object.keys(updates).length === 0 && etiquetas === undefined) {
        errors.push('Debe enviar al menos un campo válido para actualizar.');
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, updates, etiquetas };
}

function validateInteraccionesQuery(query) {
    const errors = [];
    const page = query.page === undefined ? 1 : parsePositiveInt(query.page);
    const pageSize = query.pageSize === undefined ? 20 : parsePositiveInt(query.pageSize);

    if (!page) errors.push('page debe ser un entero positivo.');
    if (!pageSize || pageSize > 100) errors.push('pageSize debe ser un entero entre 1 y 100.');

    const filters = {};
    const positiveIntParams = ['id_canal', 'id_tipo', 'id_tema', 'id_dispositivo', 'id_idioma', 'id_etiqueta'];
    for (const param of positiveIntParams) {
        if (query[param] !== undefined && query[param] !== '') {
            const parsed = parsePositiveInt(query[param]);
            if (!parsed) errors.push(`${param} debe ser un entero positivo.`);
            else filters[param] = parsed;
        }
    }

    if (query.id_usuario !== undefined && String(query.id_usuario).trim() !== '') {
        const u = String(query.id_usuario).trim();
        if (u.length > 20) errors.push('id_usuario no puede exceder 20 caracteres.');
        else filters.id_usuario = u;
    }

    if (query.desde !== undefined && String(query.desde).trim() !== '') {
        const d = parseIsoDate(query.desde);
        if (!d) errors.push('desde debe ser una fecha válida.');
        else filters.desde = d;
    }

    if (query.hasta !== undefined && String(query.hasta).trim() !== '') {
        const h = parseIsoDate(query.hasta);
        if (!h) errors.push('hasta debe ser una fecha válida.');
        else filters.hasta = h;
    }

    if (filters.desde && filters.hasta && new Date(filters.desde) > new Date(filters.hasta)) {
        errors.push('desde no puede ser posterior a hasta.');
    }

    if (query.sentimiento_min !== undefined && String(query.sentimiento_min).trim() !== '') {
        const sMin = parseSentiment(query.sentimiento_min);
        if (sMin === null) errors.push('sentimiento_min debe estar entre -1 y 1.');
        else filters.sentimiento_min = sMin;
    }

    if (query.sentimiento_max !== undefined && String(query.sentimiento_max).trim() !== '') {
        const sMax = parseSentiment(query.sentimiento_max);
        if (sMax === null) errors.push('sentimiento_max debe estar entre -1 y 1.');
        else filters.sentimiento_max = sMax;
    }

    if (
        filters.sentimiento_min !== undefined &&
        filters.sentimiento_max !== undefined &&
        filters.sentimiento_min > filters.sentimiento_max
    ) {
        errors.push('sentimiento_min no puede ser mayor que sentimiento_max.');
    }

    if (query.q !== undefined && String(query.q).trim() !== '') {
        const q = String(query.q).trim();
        if (q.length > 120) errors.push('q no puede exceder 120 caracteres.');
        else filters.q = q;
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, page, pageSize, filters };
}

module.exports = {
    isNonEmptyString,
    parsePositiveInt,
    validateCreateInteraccion,
    validateUpdateInteraccion,
    validateInteraccionesQuery,
};