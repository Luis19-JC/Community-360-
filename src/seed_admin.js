const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

async function seedAdmin() {
    if (!process.env.DATABASE_URL) {
        throw new Error('Falta DATABASE_URL en el archivo .env');
    }

    const correo = (process.argv[2] || 'admin@community360.local').trim().toLowerCase();
    const passwordPlano = process.argv[3] || 'AdminSegura#2026';
    const rol = (process.argv[4] || 'admin').trim();

    if (passwordPlano.length < 8) {
        throw new Error('La contraseña debe tener al menos 8 caracteres');
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });

    const client = await pool.connect();
    try {
        const saltRounds = 12;
        const passwordHash = await bcrypt.hash(passwordPlano, saltRounds);

        const query = `
      INSERT INTO usuarios_sistema (correo, password_hash, rol, activo)
      VALUES ($1, $2, $3, TRUE)
      ON CONFLICT (correo)
      DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        rol = EXCLUDED.rol,
        activo = TRUE
      RETURNING id_auth, correo, rol, activo
    `;

        const res = await client.query(query, [correo, passwordHash, rol]);
        console.log('Usuario autorizado guardado/actualizado con hash seguro:', res.rows[0]);
    } finally {
        client.release();
        await pool.end();
    }
}

seedAdmin().catch((err) => {
    console.error('Error al crear usuario autorizado:', err.message);
    process.exit(1);
});