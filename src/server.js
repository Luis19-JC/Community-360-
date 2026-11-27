const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const { createApiRouter } = require('./routes/api');
const { initWebSocket } = require('./websocket');

const app = express();

if (!process.env.DATABASE_URL) {
    throw new Error('Falta DATABASE_URL en el archivo .env o en las variables de entorno');
}
if (!process.env.JWT_SECRET) {
    throw new Error('Falta JWT_SECRET en el archivo .env o en las variables de entorno');
}

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const SESSION_EXPIRES_IN = process.env.SESSION_EXPIRES_IN || '2h';
const COOKIE_NAME = 'c360_session';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

// Archivos públicos (solo login y recursos no sensibles)
app.use(express.static(path.join(__dirname, '../public')));

function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: SESSION_EXPIRES_IN });
}

function verifyTokenFromReq(req) {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return null;
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

// Middleware para rutas de páginas protegidas (HTML)
function requireAuthPage(req, res, next) {
    const user = verifyTokenFromReq(req);
    if (!user) {
        return res.redirect('/login');
    }
    req.user = user;
    return next();
}

// Middleware para endpoints REST protegidos
function requireAuthApi(req, res, next) {
    const user = verifyTokenFromReq(req);
    if (!user) {
        return res.status(401).json({ error: 'No autenticado. Inicia sesión para continuar.' });
    }
    req.user = user;
    return next();
}

function setSessionCookie(req, res, token) {
    const isHttps =
        req.secure ||
        req.headers['x-forwarded-proto'] === 'https' ||
        process.env.NODE_ENV === 'production';

    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: Boolean(isHttps),
        maxAge: 2 * 60 * 60 * 1000,
        path: '/',
    });
}

// Rutas de páginas
app.get('/', (req, res) => {
    const user = verifyTokenFromReq(req);
    if (user) return res.redirect('/dashboard');
    return res.redirect('/login');
});

app.get('/login', (req, res) => {
    const user = verifyTokenFromReq(req);
    if (user) return res.redirect('/dashboard');
    return res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.get('/dashboard', requireAuthPage, (req, res) => {
    return res.sendFile(path.join(__dirname, '../views/dashboard.html'));
});

// Endpoints de autenticación
app.post('/api/auth/login', async (req, res) => {
    try {
        const correo = typeof req.body?.correo === 'string' ? req.body.correo.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        if (!correo || !password) {
            return res.status(400).json({ error: 'Correo y contraseña requeridos.' });
        }

        const result = await pool.query(
            'SELECT id_auth, correo, password_hash, rol, activo FROM usuarios_sistema WHERE LOWER(correo) = $1 LIMIT 1',
            [correo]
        );

        const account = result.rows[0];
        if (!account || !account.activo) {
            return res.status(401).json({ error: 'Credenciales inválidas o cuenta inactiva.' });
        }

        const validPassword = await bcrypt.compare(password, account.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Credenciales inválidas o cuenta inactiva.' });
        }

        const token = signToken({
            id_auth: account.id_auth,
            correo: account.correo,
            rol: account.rol,
        });

        setSessionCookie(req, res, token);

        return res.status(200).json({
            mensaje: 'Inicio de sesión exitoso.',
            usuario: {
                id_auth: account.id_auth,
                correo: account.correo,
                rol: account.rol,
            },
        });
    } catch (err) {
        console.error('Error en POST /api/auth/login:', err);
        return res.status(500).json({ error: 'Error interno al validar credenciales.' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return res.status(200).json({ mensaje: 'Sesión cerrada correctamente.' });
});

app.get('/api/auth/me', requireAuthApi, (req, res) => {
    return res.status(200).json({ usuario: req.user });
});

// Servidor HTTP + WebSockets
const server = http.createServer(app);
const { broadcastCambioInteraccion } = initWebSocket(server, {
    jwtSecret: JWT_SECRET,
    cookieName: COOKIE_NAME,
    pool,
});

// Endpoints REST protegidos de Fase 4 (histórico, catálogos y CRUD de interacciones)
app.use('/api', requireAuthApi, createApiRouter(pool, broadcastCambioInteraccion));

// JSON inválido en el body -> 400
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: 'JSON mal formado en la petición.' });
    }
    return next(err);
});

// Errores de PostgreSQL y generales
app.use((err, req, res, next) => {
    if (err?.code === '23505') {
        return res.status(409).json({ error: 'Conflicto: ya existe un registro con esa clave única.' });
    }
    if (err?.code === '23503') {
        return res.status(400).json({
            error: 'Referencia inválida: verifique que id_usuario y los catálogos existan en la base de datos.',
        });
    }
    if (err?.code === '22P02' || err?.code === '23514') {
        return res.status(400).json({ error: 'Datos inválidos o fuera de rango permitido por la base de datos.' });
    }
    console.error('Error no controlado en API:', err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor Community 360 activo en el puerto ${PORT}`);
});