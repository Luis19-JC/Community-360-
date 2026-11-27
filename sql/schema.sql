-- 1. Catálogos de usuarios (6 tablas)
CREATE TABLE IF NOT EXISTS rangos_edad (
    id_rango_edad SERIAL PRIMARY KEY,
    etiqueta_rango VARCHAR(20) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS especies_fursona (
    id_especie SERIAL PRIMARY KEY,
    nombre_especie VARCHAR(40) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS intereses_principales (
    id_interes SERIAL PRIMARY KEY,
    nombre_interes VARCHAR(60) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS plataformas_principales (
    id_plataforma SERIAL PRIMARY KEY,
    nombre_plataforma VARCHAR(40) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS estatus_usuario (
    id_estatus SERIAL PRIMARY KEY,
    nombre_estatus VARCHAR(20) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS ubicaciones (
    id_ubicacion SERIAL PRIMARY KEY,
    pais VARCHAR(60) NOT NULL,
    estado VARCHAR(80) NOT NULL,
    ciudad VARCHAR(80) NOT NULL,
    zona_horaria VARCHAR(60),
    CONSTRAINT uq_ubicaciones_geo_tz UNIQUE (pais, estado, ciudad, zona_horaria)
);

-- 2. Tabla principal usuarios (1 tabla)
CREATE TABLE IF NOT EXISTS usuarios (
    id_usuario VARCHAR(20) PRIMARY KEY,
    alias VARCHAR(80) NOT NULL UNIQUE,
    fecha_ingreso DATE NOT NULL,
    id_ubicacion INT REFERENCES ubicaciones(id_ubicacion) ON DELETE SET NULL,
    latitud DECIMAL(9,6) CHECK (latitud IS NULL OR (latitud BETWEEN -90 AND 90)),
    longitud DECIMAL(9,6) CHECK (longitud IS NULL OR (longitud BETWEEN -180 AND 180)),
    id_rango_edad INT NOT NULL REFERENCES rangos_edad(id_rango_edad) ON DELETE RESTRICT,
    id_especie INT NOT NULL REFERENCES especies_fursona(id_especie) ON DELETE RESTRICT,
    id_interes INT NOT NULL REFERENCES intereses_principales(id_interes) ON DELETE RESTRICT,
    id_plataforma INT NOT NULL REFERENCES plataformas_principales(id_plataforma) ON DELETE RESTRICT,
    es_artista SMALLINT NOT NULL CHECK (es_artista IN (0, 1)),
    mensajes_30d INT NOT NULL DEFAULT 0 CHECK (mensajes_30d >= 0),
    reacciones_30d INT NOT NULL DEFAULT 0 CHECK (reacciones_30d >= 0),
    eventos_asistidos INT NOT NULL DEFAULT 0 CHECK (eventos_asistidos >= 0),
    comisiones_compradas INT NOT NULL DEFAULT 0 CHECK (comisiones_compradas >= 0),
    sentimiento_promedio DECIMAL(6,3) NOT NULL CHECK (sentimiento_promedio BETWEEN -1 AND 1),
    ultima_actividad DATE NOT NULL,
    id_estatus INT NOT NULL REFERENCES estatus_usuario(id_estatus) ON DELETE RESTRICT,
    consentimiento_datos VARCHAR(5) NOT NULL CHECK (consentimiento_datos IN ('si', 'no')),
    CONSTRAINT chk_privacidad_geo CHECK (
        consentimiento_datos <> 'no'
        OR (id_ubicacion IS NULL AND latitud IS NULL AND longitud IS NULL)
    )
);

-- 3. Catálogos de interacciones (5 tablas)
CREATE TABLE IF NOT EXISTS canales (
    id_canal SERIAL PRIMARY KEY,
    nombre_canal VARCHAR(40) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS tipos_interaccion (
    id_tipo SERIAL PRIMARY KEY,
    nombre_tipo VARCHAR(30) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS temas (
    id_tema SERIAL PRIMARY KEY,
    nombre_tema VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS dispositivos (
    id_dispositivo SERIAL PRIMARY KEY,
    nombre_dispositivo VARCHAR(30) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS idiomas (
    id_idioma SERIAL PRIMARY KEY,
    codigo_idioma VARCHAR(10) NOT NULL UNIQUE
);

-- 4. Tabla principal interacciones (1 tabla)
CREATE TABLE IF NOT EXISTS interacciones (
    id_interaccion VARCHAR(20) PRIMARY KEY,
    id_usuario VARCHAR(20) NOT NULL REFERENCES usuarios(id_usuario) ON DELETE RESTRICT,
    id_canal INT NOT NULL REFERENCES canales(id_canal) ON DELETE RESTRICT,
    id_tipo INT NOT NULL REFERENCES tipos_interaccion(id_tipo) ON DELETE RESTRICT,
    id_tema INT NOT NULL REFERENCES temas(id_tema) ON DELETE RESTRICT,
    id_dispositivo INT NOT NULL REFERENCES dispositivos(id_dispositivo) ON DELETE RESTRICT,
    id_idioma INT NOT NULL REFERENCES idiomas(id_idioma) ON DELETE RESTRICT,
    id_ubicacion INT REFERENCES ubicaciones(id_ubicacion) ON DELETE SET NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    texto TEXT,
    sentimiento DECIMAL(5,2) NOT NULL CHECK (sentimiento BETWEEN -1 AND 1),
    longitud_texto INT NOT NULL DEFAULT 0 CHECK (longitud_texto >= 0),
    reacciones_recibidas INT NOT NULL DEFAULT 0 CHECK (reacciones_recibidas >= 0)
);

-- 5. Etiquetas normalizadas y tabla puente N:M (2 tablas)
CREATE TABLE IF NOT EXISTS etiquetas (
    id_etiqueta SERIAL PRIMARY KEY,
    nombre_etiqueta VARCHAR(40) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS interaccion_etiquetas (
    id_interaccion VARCHAR(20) NOT NULL REFERENCES interacciones(id_interaccion) ON DELETE CASCADE,
    id_etiqueta INT NOT NULL REFERENCES etiquetas(id_etiqueta) ON DELETE RESTRICT,
    PRIMARY KEY (id_interaccion, id_etiqueta)
);

-- 6. Tabla de cuarentena sin FK hacia usuarios (1 tabla)
CREATE TABLE IF NOT EXISTS interacciones_cuarentena (
    id_interaccion VARCHAR(20) PRIMARY KEY,
    id_usuario_origen VARCHAR(20) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    canal VARCHAR(40) NOT NULL,
    tipo VARCHAR(30) NOT NULL,
    texto TEXT,
    tema VARCHAR(50) NOT NULL,
    dispositivo VARCHAR(30) NOT NULL,
    etiquetas_raw TEXT,
    motivo_rechazo VARCHAR(120) NOT NULL,
    fecha_cuarentena TIMESTAMPTZ NOT NULL
);

-- 7. Tabla de cuentas del sistema (1 tabla)
CREATE TABLE IF NOT EXISTS usuarios_sistema (
    id_auth SERIAL PRIMARY KEY,
    correo VARCHAR(120) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    rol VARCHAR(30) NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE
);