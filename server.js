const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const stream = require('stream');
const axios = require('axios'); // Agrega axios para llamadas HTTP
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

// Seguimiento de sockets para detectar conexiones fantasma e inactividad
const connectedSockets = {};
const SOCKET_IDLE_MS = 3 * 60 * 1000; // desconectar tras 3 minutos sin actividad
const SOCKET_CLEANUP_INTERVAL_MS = 30 * 1000; // revisar cada 30s

// Función para cerrar MongoDB inmediatamente
async function closeMongoNow() {
    try {
        if (mongoClient) {
            await mongoClient.close();
            mongoClient = null;
            db = null;
            cursosCol = null;
            usuariosCol = null;
            sitiosCol = null;
            adminTicketsCol = null;
            gfs = null;
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            console.log('MongoDB connection closed immediately by cleanup');
        }
    } catch (err) {
        console.error('Error closing MongoDB immediately:', err);
    }
}

// Periodicamente desconectar sockets inactivos
const socketCleanupInterval = setInterval(() => {
    try {
        const now = Date.now();
        Object.keys(connectedSockets).forEach(id => {
            const info = connectedSockets[id];
            if (!info) return;
            if (now - info.lastSeen > SOCKET_IDLE_MS) {
                const s = io.sockets.sockets.get(id);
                if (s) {
                    console.log(`[socket-cleanup] disconnecting idle socket ${id} addr=${info.addr}`);
                    try { s.disconnect(true); } catch (e) { /* ignore */ }
                }
                delete connectedSockets[id];
            }
        });
        // Si no quedan sockets conectados, cerrar MongoDB de inmediato
        if (Object.keys(connectedSockets).length === 0) {
            closeMongoNow().catch(e => console.error('closeMongoNow error:', e));
        }
    } catch (e) {
        console.error('Error en limpieza de sockets:', e);
    }
}, SOCKET_CLEANUP_INTERVAL_MS);
// Evita que el timer mantenga el proceso vivo cuando no hay actividad (por ejemplo en Render):
if (typeof socketCleanupInterval.unref === 'function') {
    try { socketCleanupInterval.unref(); } catch (e) { /* no crítico */ }
}

// Endpoint de diagnóstico de sockets
app.get('/api/socket-status', (req, res) => {
    try {
        const list = Object.values(connectedSockets).map(s => ({ id: s.id, addr: s.addr, ua: s.ua, lastSeenAgoMs: Date.now() - s.lastSeen }));
        res.json({ count: io.sockets.sockets.size || 0, clientsCount: io.engine && io.engine.clientsCount ? io.engine.clientsCount : undefined, sockets: list });
    } catch (e) {
        res.status(500).json({ error: 'Error obteniendo estado de sockets' });
    }
});

// Endpoint para desconectar sockets manualmente
// Uso: GET /api/socket-disconnect?id=<socketId>
// O:  GET /api/socket-disconnect?olderThanMs=60000  -> desconecta sockets inactivos > 60s
app.get('/api/socket-disconnect', (req, res) => {
    try {
        const id = req.query.id;
        const olderThanMs = req.query.olderThanMs ? parseInt(req.query.olderThanMs, 10) : null;
        const now = Date.now();
        const disconnected = [];

        if (id) {
            const s = io.sockets.sockets.get(id);
            if (s) {
                try { s.disconnect(true); } catch (e) { /* ignore */ }
            }
            if (connectedSockets[id]) {
                disconnected.push(id);
                delete connectedSockets[id];
            }
        }

        if (olderThanMs) {
            Object.keys(connectedSockets).forEach(sid => {
                const info = connectedSockets[sid];
                if (now - info.lastSeen > olderThanMs) {
                    const s = io.sockets.sockets.get(sid);
                    if (s) {
                        try { s.disconnect(true); } catch (e) { /* ignore */ }
                    }
                    disconnected.push(sid);
                    delete connectedSockets[sid];
                }
            });
        }

        res.json({ disconnected, remaining: Object.keys(connectedSockets).length });
    } catch (err) {
        console.error('Error en /api/socket-disconnect:', err);
        res.status(500).json({ error: 'Error desconectando sockets' });
    }
});

// Connection manager: reconecta bajo demanda y cierra la conexión si hay inactividad
let mongoClient = null;
// Cerrar rápido para que no haya conexiones cuando no se usa (1 minuto)
const IDLE_CLOSE_MS = 1 * 60 * 1000; // 1 minuto
let idleTimer = null;
async function ensureConnected() {
    if (db) {
        scheduleIdleClose();
        return;
    }
    try {
        // Limitar tamaño del pool para reducir conexiones simultáneas en Atlas (1 conexión)
        mongoClient = await MongoClient.connect(MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true, maxPoolSize: 1, minPoolSize: 0 });
        db = mongoClient.db(DB_NAME);
        cursosCol = db.collection('cursos');
        usuariosCol = db.collection('usuarios');
        // Asegura que inventariosCol también esté disponible cuando conectemos bajo demanda
        inventariosCol = db.collection('inventarios');
        sitiosCol = db.collection('sitios');
        adminTicketsCol = db.collection('adminTickets');
        // Colección para empresas
        empresasCol = db.collection('empresas');
        gfs = new GridFSBucket(db, { bucketName: 'imagenes' });
        console.log('MongoDB conectado bajo demanda');
        scheduleIdleClose();
    } catch (e) {
        console.error('Error conectando a MongoDB en ensureConnected:', e);
        throw e;
    }
}
function scheduleIdleClose() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
        try {
            if (mongoClient) {
                await mongoClient.close();
                mongoClient = null;
                db = null;
                cursosCol = null;
                usuariosCol = null;
                sitiosCol = null;
                adminTicketsCol = null;
                gfs = null;
                console.log('MongoDB connection closed due to inactivity');
            }
        } catch (err) {
            console.error('Error closing MongoDB connection:', err);
        }
    }, IDLE_CLOSE_MS);
    // Permite que el proceso termine/suspenda aunque exista este timer
    if (typeof idleTimer.unref === 'function') {
        try { idleTimer.unref(); } catch (e) { /* no crítico */ }
    }
}

// Middleware: evita abrir conexión para sondas/OPTIONS y endpoints de diagnóstico
app.use(async (req, res, next) => {
    if (req.path === '/health' || req.method === 'OPTIONS' || req.path === '/api/socket-status' || req.path === '/api/socket-disconnect') {
        return next();
    }
    try {
        await ensureConnected();
        next();
    } catch (e) {
        next(e);
    }
});

// --- MongoDB config ---
const MONGO_URL = 'mongodb+srv://daniel:daniel25@capacitacion.nxd7yl9.mongodb.net/?retryWrites=true&w=majority&appName=capacitacion&authSource=admin';
const DB_NAME = 'capacitacion';
let db, cursosCol, usuariosCol, sitiosCol, gfs, adminTicketsCol, empresasCol, inventariosCol;

const VAPID_PUBLIC_KEY = 'BE3OGd8E0TxFDNvAL85myO8GEFwkOhqOrkfqiJbXXveQQkpNF3_HwmWrd5SemRV9SN9EXXe1ZPFET0hnDcw2-Uc';
const VAPID_PRIVATE_KEY = '8PxGNwSHAy-_Fb55XlpY5NGN3N2VeNXfxXJuTcw93s'; // <-- Reemplaza por una clave privada VAPID válida
// webpush.setVapidDetails(
//     'mailto:naisatasoluciones@gmail.com',
//     VAPID_PUBLIC_KEY,
//     VAPID_PRIVATE_KEY
// );
// ADVERTENCIA: Debes generar una clave privada VAPID válida y descomentar la línea anterior.

// Helper para enviar push con timeout y logging (evita que un envío bloquee el event loop)
async function safeSendPush(subscription, payload, timeoutMs = 7000) {
    if (!subscription) return false;
    try {
        const sendPromise = webpush.sendNotification(subscription, payload);
        const result = await Promise.race([
            sendPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('push-timeout')), timeoutMs))
        ]);
        console.log('[push] enviado OK');
        return true;
    } catch (err) {
        console.error('[push] error enviando notificación:', err && err.message ? err.message : err);
        return false;
    }
}

// Endpoint para revisar estado de suscripciones push en la base de datos
app.get('/api/push-status', async (req, res) => {
    try {
        await ensureConnected();
        const usersWithPush = await usuariosCol.find({ pushSubscription: { $exists: true, $ne: null } }).project({ usuario: 1, pushSubscription: 1 }).toArray();
        res.json({ count: usersWithPush.length, users: usersWithPush.map(u => ({ usuario: u.usuario, hasPush: !!u.pushSubscription })) });
    } catch (e) {
        console.error('Error en /api/push-status:', e);
        res.status(500).json({ error: 'Error obteniendo estado de push' });
    }
});

MongoClient.connect(MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true, maxPoolSize: 1, minPoolSize: 0 })
    .then(client => {
        // Guarda referencia al cliente y programa cierre por inactividad
        mongoClient = client;
         db = client.db(DB_NAME);
         cursosCol = db.collection('cursos');
         usuariosCol = db.collection('usuarios');
         // Crear inventariosCol global igual que en ensureConnected
         inventariosCol = db.collection('inventarios');
         sitiosCol = db.collection('sitios');
         adminTicketsCol = db.collection('adminTickets');
         // Crear colección empresas
         empresasCol = db.collection('empresas');
         gfs = new GridFSBucket(db, { bucketName: 'imagenes' });
         console.log('Conectado a MongoDB y GridFS');
         scheduleIdleClose();

         // Colección para inventario por usuario
         // (inventariosCol ya asignada globalmente)
        
        // Helper: formatea fecha para PDF (DD/MM/YYYY HH:MM)
        function formatDateForPDF(d) {
            try {
                const date = d ? new Date(d) : new Date();
                const opts = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' };
                // 'es-ES' para formato  dd/mm/yyyy, quitar coma si la hay
                return date.toLocaleString('es-ES', opts).replace(',', '');
            } catch (e) {
                return String(d);
            }
        }

        // Configuración SMTP Gmail
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: 'naisatasoluciones@gmail.com',
                pass: 'mmjxjczkksrzxzaq',
            }
        });

        // Función para enviar correo
        async function enviarCorreo(destino, asunto, mensaje) {
            try {
                await transporter.sendMail({
                    from: 'Inventario Naisata <naisatasoluciones@gmail.com>',
                    to: destino,
                    subject: asunto,
                    html: mensaje
                });
            } catch (err) {
                console.error('Error enviando correo:', err);
            }
        }
        // Importar insumos desde archivo .json a un proyecto
        const multerImport = multer({ storage: multer.memoryStorage() });
        app.post('/api/inventario/importar-insumos', multerImport.single('archivo'), async (req, res) => {
            const { usuario, proyectoIdx } = req.body;
            if (!usuario || proyectoIdx == null || !req.file) return res.status(400).json({ error: 'Faltan datos o archivo' });
            try {
                const jsonStr = req.file.buffer.toString('utf8');
                let insumos = [];
                try {
                    const parsed = JSON.parse(jsonStr);
                    if (Array.isArray(parsed)) {
                        insumos = parsed;
                    } else if (typeof parsed === 'object') {
                        insumos = [parsed];
                    }
                } catch (err) {
                    return res.status(400).json({ error: 'Archivo JSON inválido' });
                }
                // Formatear insumos para inventario
                const items = insumos.map(i => ({
                    nombre: i.nombre || '',
                    parte: i.numero_parte || '',
                    ubicacion: i.ubicacion || '',
                    cantidad: i.cantidad || 0,
                    marca: i.marca || '',
                    tipo: i.tipo || '',
                    fecha: i.fecha || '',
                    id: i.id || ''
                }));
                // Agregar insumos al inventario del proyecto
                await inventariosCol.updateOne(
                    { usuario },
                    { $push: { [`proyectos.${proyectoIdx}.inventario`]: { $each: items } } }
                );
                res.json({ mensaje: 'Insumos importados correctamente', cantidad: items.length });
            } catch (err) {
                res.status(500).json({ error: 'Error al importar insumos' });
            }
        });

        // Crear proyecto de inventario para usuario
        app.post('/api/inventario/proyecto', async (req, res) => {
            const { usuario, nombreProyecto } = req.body;
            if (!usuario || !nombreProyecto) return res.status(400).json({ error: 'Faltan datos' });
            try {
                let doc = await inventariosCol.findOne({ usuario });
                if (!doc) {
                    // Crear documento nuevo para el usuario
                    await inventariosCol.insertOne({ usuario, proyectos: [{ nombre: nombreProyecto, inventario: [] }] });
                } else {
                    // Agregar proyecto al array
                    await inventariosCol.updateOne(
                        { usuario },
                        { $push: { proyectos: { nombre: nombreProyecto, inventario: [] } } }
                    );
                }
                res.json({ mensaje: 'Proyecto creado' });
            } catch (err) {
                res.status(500).json({ error: 'Error al crear proyecto' });
            }
        });

        // Obtener proyectos de inventario por usuario
        app.get('/api/inventario/proyectos/:usuario', async (req, res) => {
            const usuario = req.params.usuario;
            try {
                const doc = await inventariosCol.findOne({ usuario });
                res.json({ proyectos: doc ? doc.proyectos : [] });
            } catch (err) {
                res.status(500).json({ error: 'Error al obtener proyectos' });
            }
        });

        // Agregar item a un proyecto
        app.post('/api/inventario/item', async (req, res) => {
            let { usuario, proyectoIdx, nombre, marca, parte, ubicacion, cantidad } = req.body;
            if (!usuario || proyectoIdx == null || !nombre || !marca || !parte || !ubicacion || cantidad == null) return res.status(400).json({ error: 'Faltan datos' });
            // Guardar todo en mayúsculas
            nombre = nombre.toUpperCase();
            marca = marca.toUpperCase();
            parte = parte.toUpperCase();
            ubicacion = ubicacion.toUpperCase();
            try {
                const update = {};
                update[`proyectos.${proyectoIdx}.inventario`] = { nombre, marca, parte, ubicacion, cantidad };
                await inventariosCol.updateOne(
                    { usuario },
                    { $push: update }
                );
                res.json({ mensaje: 'Producto agregado' });
            } catch (err) {
                res.status(500).json({ error: 'Error al agregar producto' });
            }
        });

        // Editar item de inventario
        app.put('/api/inventario/item', async (req, res) => {
            let { usuario, proyectoIdx, itemIdx, nombre, marca, parte, ubicacion, cantidad } = req.body;
            if (!usuario || proyectoIdx == null || itemIdx == null || !nombre || !marca || !parte || !ubicacion || cantidad == null) return res.status(400).json({ error: 'Faltan datos' });
            // Guardar todo en mayúsculas
            nombre = nombre.toUpperCase();
            marca = marca.toUpperCase();
            parte = parte.toUpperCase();
            ubicacion = ubicacion.toUpperCase();
            try {
                const update = {};
                if (nombre !== undefined) update[`proyectos.${proyectoIdx}.inventario.${itemIdx}.nombre`] = nombre;
                if (marca !== undefined) update[`proyectos.${proyectoIdx}.inventario.${itemIdx}.marca`] = marca;
                if (parte !== undefined) update[`proyectos.${proyectoIdx}.inventario.${itemIdx}.parte`] = parte;
                if (ubicacion !== undefined) update[`proyectos.${proyectoIdx}.inventario.${itemIdx}.ubicacion`] = ubicacion;
                if (cantidad !== undefined) update[`proyectos.${proyectoIdx}.inventario.${itemIdx}.cantidad`] = cantidad;
                await inventariosCol.updateOne(
                    { usuario },
                    { $set: update }
                );
                res.json({ mensaje: 'Producto editado' });
            } catch (err) {
                res.status(500).json({ error: 'Error al editar producto' });
            }
        });

        // Eliminar item de inventario
        app.delete('/api/inventario/item', async (req, res) => {
            const { usuario, proyectoIdx, itemIdx } = req.body;
            if (!usuario || proyectoIdx == null || itemIdx == null) return res.status(400).json({ error: 'Faltan datos' });
            try {
                // Usar $unset y luego $pull para limpiar nulls
                const unsetField = `proyectos.${proyectoIdx}.inventario.${itemIdx}`;
                await inventariosCol.updateOne(
                    { usuario },
                    { $unset: { [unsetField]: 1 } }
                );
                await inventariosCol.updateOne(
                    { usuario },
                    { $pull: { [`proyectos.${proyectoIdx}.inventario`]: null } }
                );
                res.json({ mensaje: 'Producto eliminado' });
            } catch (err) {
                res.status(500).json({ error: 'Error al eliminar producto' });
            }
        });
            // Eliminar proyecto solo si la contraseña es válida
            app.post('/api/inventario/proyecto/eliminar', async (req, res) => {
                const { usuario, proyectoIdx } = req.body;
                if (!usuario || proyectoIdx == null) return res.status(400).json({ error: 'Faltan datos' });
                try {
                    // Elimina el proyecto del array
                    const doc = await inventariosCol.findOne({ usuario });
                    if (!doc || !doc.proyectos || !doc.proyectos[proyectoIdx]) {
                        return res.status(404).json({ error: 'Proyecto no encontrado' });
                    }
                    // Usar $unset y luego $pull para limpiar nulls
                    const unsetField = `proyectos.${proyectoIdx}`;
                    await inventariosCol.updateOne(
                        { usuario },
                        { $unset: { [unsetField]: 1 } }
                    );
                    await inventariosCol.updateOne(
                        { usuario },
                        { $pull: { proyectos: null } }
                    );
                    res.json({ mensaje: 'Proyecto eliminado' });
                } catch (err) {
                    res.status(500).json({ error: 'Error al eliminar proyecto' });
                }
            });
                // Transferir proyecto a otro usuario
                app.post('/api/inventario/proyecto/transferir', async (req, res) => {
                    const { usuarioOrigen, proyectoIdx, usuarioDestino } = req.body;
                    if (!usuarioOrigen || proyectoIdx == null || !usuarioDestino) return res.status(400).json({ error: 'Faltan datos' });
                    try {
                        // Buscar proyecto en usuario origen
                        const docOrigen = await inventariosCol.findOne({ usuario: usuarioOrigen });
                        if (!docOrigen || !docOrigen.proyectos || !docOrigen.proyectos[proyectoIdx]) {
                            return res.status(404).json({ error: 'Proyecto no encontrado en usuario origen' });
                        }
                        const proyecto = docOrigen.proyectos[proyectoIdx];
                        // Quitar proyecto del usuario origen
                        const unsetField = `proyectos.${proyectoIdx}`;
                        await inventariosCol.updateOne(
                            { usuario: usuarioOrigen },
                            { $unset: { [unsetField]: 1 } }
                        );
                        await inventariosCol.updateOne(
                            { usuario: usuarioOrigen },
                            { $pull: { proyectos: null } }
                        );
                        // Agregar proyecto al usuario destino
                        const docDestino = await inventariosCol.findOne({ usuario: usuarioDestino });
                        if (!docDestino) {
                            // Si no existe, crear documento nuevo
                            await inventariosCol.insertOne({ usuario: usuarioDestino, proyectos: [proyecto] });
                        } else {
                            await inventariosCol.updateOne(
                                { usuario: usuarioDestino },
                                { $push: { proyectos: proyecto } }
                            );
                        }
                        // Buscar correo y subscription push del usuario destino
                        const usuarioDoc = await usuariosCol.findOne({ usuario: usuarioDestino });
                        if (usuarioDoc && usuarioDoc.correo) {
                            await enviarCorreo(
                                usuarioDoc.correo,
                                'Te han transferido un proyecto',
                                `<h2>¡Hola ${usuarioDestino}!</h2><p>Se te ha transferido el proyecto <b>${proyecto.nombre}</b> en el sistema de inventario Naisata.</p>`
                            );
                        }
                        // Emitir notificación por Socket.IO
                        io.emit('proyecto-transferido', {
                            destino: usuarioDestino,
                            nombre: proyecto.nombre,
                            origen: usuarioOrigen
                        });
                        // Notificación push al usuario destino
                        if (usuarioDoc && usuarioDoc.pushSubscription) {
                            try {
                                const payload = JSON.stringify({
                                    title: '¡Te han transferido un proyecto!',
                                    body: `Has recibido el proyecto "${proyecto.nombre}" de ${usuarioOrigen}.`,
                                    icon: 'https://capacitacion-x7et.onrender.com/log.png'
                                });
                                const ok = await safeSendPush(usuarioDoc.pushSubscription, payload);
                                if (!ok) console.warn('[push] fallo al enviar push a', usuarioDestino);
                            } catch (err) {
                                console.error('Error en safeSendPush:', err);
                            }
                        }
                        res.json({ mensaje: 'Proyecto transferido correctamente y notificación enviada' });
                    } catch (err) {
                        res.status(500).json({ error: 'Error al transferir proyecto' });
                    }
                });
        // Registrar movimiento de inventario (salida/entrada)
        app.post('/api/inventario/movimiento', async (req, res) => {
            const { usuario, proyectoIdx, productoIdx, tipo, cantidad, responsable, destino } = req.body;
            if (!usuario || proyectoIdx == null || productoIdx == null || !tipo || cantidad == null || !responsable || !destino) return res.status(400).json({ error: 'Faltan datos' });
            try {
                // Obtener inventario actual
                const doc = await inventariosCol.findOne({ usuario });
                if (!doc || !doc.proyectos || !doc.proyectos[proyectoIdx] || !doc.proyectos[proyectoIdx].inventario[productoIdx]) {
                    return res.status(404).json({ error: 'Producto no encontrado' });
                }
                const producto = doc.proyectos[proyectoIdx].inventario[productoIdx];
                let nuevaCantidad = producto.cantidad;
                if (tipo === 'salida') {
                    nuevaCantidad -= cantidad;
                    if (nuevaCantidad < 0) return res.status(400).json({ error: 'No hay suficiente cantidad en inventario' });
                } else if (tipo === 'entrada') {
                    nuevaCantidad += cantidad;
                }
                // Actualizar cantidad
                await inventariosCol.updateOne(
                    { usuario },
                    { $set: { [`proyectos.${proyectoIdx}.inventario.${productoIdx}.cantidad`]: nuevaCantidad } }
                );
                // Registrar movimiento
                const movimiento = {
                    tipo,
                    productoIdx,
                    cantidad,
                    responsable,
                    destino,
                    fecha: new Date()
                };
                await inventariosCol.updateOne(
                    { usuario },
                    { $push: { [`proyectos.${proyectoIdx}.movimientos`]: movimiento } }
                );
                res.json({ mensaje: 'Movimiento registrado' });
            } catch (err) {
                res.status(500).json({ error: 'Error al registrar movimiento' });
            }
        });

            // Descargar PDF de movimientos seleccionados con diseño profesional y nombre de la empresa Naisata
            app.post('/api/inventario/movimientos/pdf', async (req, res) => {
                const { usuario, proyectoIdx, movimientosIdxs } = req.body;
                if (!usuario || proyectoIdx == null || !Array.isArray(movimientosIdxs)) return res.status(400).json({ error: 'Faltan datos' });
                try {
                    const doc = await db.collection('inventarios').findOne({ usuario });
                    if (!doc || !doc.proyectos || !doc.proyectos[proyectoIdx]) {
                        return res.status(404).json({ error: 'Proyecto o movimientos no encontrados' });
                    }
                    const proyecto = doc.proyectos[proyectoIdx];
                    // Asegura que movimientos e inventario son arrays
                    const movimientosArr = Array.isArray(proyecto.movimientos) ? proyecto.movimientos : [];
                    const inventarioArr = Array.isArray(proyecto.inventario) ? proyecto.inventario : [];

                    // Filtrar e normalizar movimientos solicitados
                    const movimientos = movimientosArr
                      .map((mov, idx) => ({ idx, mov }))
                      .filter(({ idx }) => movimientosIdxs.includes(idx))
                      .map(({ mov }) => ({
                        tipo: mov.tipo || '',
                        productoIdx: typeof mov.productoIdx === 'number' ? mov.productoIdx : -1,
                        cantidad: mov.cantidad != null ? mov.cantidad : 0,
                        responsable: mov.responsable || '',
                        destino: mov.destino || '',
                        fecha: mov.fecha ? new Date(mov.fecha) : new Date()
                      }));

                    if (movimientos.length === 0) {
                        return res.status(404).json({ error: 'No se encontraron movimientos para los índices solicitados' });
                    }

                    // Crear PDF
                    const PDFDocument = require('pdfkit');
                    const pdfDoc = new PDFDocument({ margin: 40 });
                    let buffers = [];
                    pdfDoc.on('data', buffers.push.bind(buffers));
                    pdfDoc.on('end', () => {
                        const pdfData = Buffer.concat(buffers);
                        res.setHeader('Content-Type', 'application/pdf');
                        res.setHeader('Content-Disposition', 'attachment; filename="movimientos_naisata.pdf"');
                        res.send(pdfData);
                    });

                    // Encabezado y título
                    pdfDoc.rect(0, 0, pdfDoc.page.width, 80).fill('#2a4d8f');
                    pdfDoc.fillColor('#fff').fontSize(28).font('Helvetica-Bold').text('Naisata', 40, 25);
                    pdfDoc.fillColor('#2a4d8f').fontSize(18).font('Helvetica').text('Reporte de Movimientos de Inventario', 40, 100, { width: pdfDoc.page.width - 80 });
                    pdfDoc.fontSize(13).fillColor('#333').text(`Proyecto: ${proyecto.nombre || 'N/D'}`, 40, 130, { width: pdfDoc.page.width - 80 });
                    pdfDoc.moveDown(2);

                    // Tabla de movimientos
                    const tableTop = pdfDoc.y;
                    // Calcula anchos dinámicos según el ancho disponible (márgenes 40)
                    const availableWidth = pdfDoc.page.width - 80; // margen izquierdo + derecho
                    let colWidths = [
                        Math.round(availableWidth * 0.12), // Tipo
                        Math.round(availableWidth * 0.36), // Producto
                        Math.round(availableWidth * 0.07), // Cantidad
                        Math.round(availableWidth * 0.18), // Responsable
                        Math.round(availableWidth * 0.12), // Destino
                        Math.round(availableWidth * 0.15)  // Fecha
                    ];
                    // Ajuste final por redondeo
                    const totalCols = colWidths.reduce((s, v) => s + v, 0);
                    if (totalCols !== availableWidth) {
                        colWidths[colWidths.length - 1] += (availableWidth - totalCols);
                    }
                    const colX = [40];
                    for (let i = 0; i < colWidths.length; i++) {
                        colX.push(colX[i] + colWidths[i]);
                    }
                    pdfDoc.font('Helvetica-Bold').fontSize(12);
                    pdfDoc.text('Tipo', colX[0], tableTop, { width: colWidths[0] });
                    pdfDoc.text('Producto', colX[1], tableTop, { width: colWidths[1] });
                    pdfDoc.text('Cantidad', colX[2], tableTop, { width: colWidths[2] });
                    pdfDoc.text('Responsable', colX[3], tableTop, { width: colWidths[3] });
                    pdfDoc.text('Destino', colX[4], tableTop, { width: colWidths[4] });
                    pdfDoc.text('Fecha', colX[5], tableTop, { width: colWidths[5] });
                    pdfDoc.moveDown(1);
                    pdfDoc.font('Helvetica').fontSize(11);

                    movimientos.forEach((mov) => {
                        const prod = (mov.productoIdx >= 0 && inventarioArr[mov.productoIdx]) ? inventarioArr[mov.productoIdx] : null;
                        const prodNombre = prod && prod.nombre ? prod.nombre : 'N/D';
                        const y = pdfDoc.y;
                        const fechaStr = formatDateForPDF(mov.fecha);
                        pdfDoc.text(mov.tipo === 'salida' ? 'Salida' : mov.tipo === 'entrada' ? 'Devolución' : mov.tipo, colX[0], y, { width: colWidths[0] });
                        pdfDoc.text(prodNombre, colX[1], y, { width: colWidths[1] });
                        pdfDoc.text(String(mov.cantidad), colX[2], y, { width: colWidths[2] });
                        pdfDoc.text(mov.responsable, colX[3], y, { width: colWidths[3] });
                        pdfDoc.text(mov.destino, colX[4], y, { width: colWidths[4] });
                        pdfDoc.text(fechaStr, colX[5], y, { width: colWidths[5] });

                        // Calcular la altura máxima de la fila para salto de línea
                        let maxHeight = 0;
                        [
                            mov.tipo === 'salida' ? 'Salida' : mov.tipo === 'entrada' ? 'Devolución' : mov.tipo,
                            prodNombre,
                            String(mov.cantidad),
                            mov.responsable,
                            mov.destino,
                            fechaStr
                        ].forEach((txt, idx) => {
                            const h = pdfDoc.heightOfString(txt, { width: colWidths[idx] });
                            if (h > maxHeight) maxHeight = h;
                        });
                        pdfDoc.y += maxHeight + 4;
                    });

                    // Pie de página: línea para firma
                    // Evitar switchToPage(undefined). Obtener la página actual de forma segura y dibujar el pie.
                    const currentPage = pdfDoc.page;
                    const pageHeight = (currentPage && currentPage.height) ? currentPage.height : (pdfDoc.pageSize ? pdfDoc.pageSize[1] : 792);
                    const firmaY = pageHeight - 60;
                    pdfDoc.font('Helvetica').fontSize(13).text('Firma:', 40, firmaY);
                    pdfDoc.moveTo(100, firmaY + 15).lineTo(300, firmaY + 15).stroke();

                    pdfDoc.end();
                } catch (err) {
                    console.error('Error en /api/inventario/movimientos/pdf:', err);
                    res.status(500).json({ error: 'Error al generar PDF' });
                }
            });


        // Iniciar servidor después de que la conexión a MongoDB esté lista
        const PORT = process.env.PORT || 3001;
        const HOST = '0.0.0.0';
        server.listen(PORT, HOST, () => {
            console.log(`Servidor backend GridFS iniciado en puerto ${PORT}`);
        });
    })
    .catch(err => {
        console.error('Error conectando a MongoDB', err);
        process.exit(1);
    });

const storage = multer.memoryStorage();
const upload = multer({ storage });

const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Guardar curso y pasos en MongoDB y guardar imágenes/videos en GridFS
app.post('/api/curso', upload.fields([
    { name: 'imagenes' },
    { name: 'portada', maxCount: 1 }
]), async (req, res) => {
    try {
        const { titulo, descripcion, portadaNombre, categoria } = req.body; // <-- agrega categoria
        let pasos = [];
        let archivosMap = {};
        let portada = null;

        // Guardar portada en GridFS si existe
        if (req.files && req.files['portada'] && req.files['portada'][0]) {
            const portadaFile = req.files['portada'][0];
            const bufferStream = new stream.PassThrough();
            bufferStream.end(portadaFile.buffer);
            await new Promise((resolve, reject) => {
                const uploadStream = gfs.openUploadStream(portadaFile.originalname, {
                    contentType: portadaFile.mimetype
                });
                bufferStream.pipe(uploadStream)
                    .on('error', reject)
                    .on('finish', resolve);
            });
            portada = portadaFile.originalname;
        } else if (portadaNombre) {
            portada = portadaNombre;
        }

        // Guardar imágenes/videos de pasos en GridFS
        if (req.files && req.files['imagenes']) {
            for (const file of req.files['imagenes']) {
                const bufferStream = new stream.PassThrough();
                bufferStream.end(file.buffer);
                await new Promise((resolve, reject) => {
                    const uploadStream = gfs.openUploadStream(file.originalname, {
                        contentType: file.mimetype
                    });
                    bufferStream.pipe(uploadStream)
                        .on('error', reject)
                        .on('finish', resolve);
                });
                archivosMap[file.originalname] = file.originalname;
            }
        }

        if (req.body.pasos) {
            pasos = JSON.parse(req.body.pasos);
            pasos = pasos.map(p => {
                let archivoNombre = p.imagen;
                if (typeof archivoNombre === 'string' && archivoNombre.includes('/')) {
                    archivoNombre = archivoNombre.split('/').pop();
                }
                return {
                    ...p,
                    imagen: archivoNombre && archivosMap[archivoNombre] ? archivoNombre : null
                };
            });
        }
        // --- Guarda la categoría en el documento ---
        await cursosCol.insertOne({ titulo, descripcion, portada, categoria, pasos });
        io.emit('nuevoCurso', { mensaje: 'Nuevo curso agregado' });
        res.json({ mensaje: 'Curso recibido' });
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar el curso' });
    }
});

// Endpoint para servir imágenes o videos desde GridFS (con soporte de Range para videos)
app.options('/api/imagen/:nombre', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
    res.sendStatus(204);
});

app.get('/api/imagen/:nombre', async (req, res) => {
    try {
        // nombre viene decoded por express
        const requested = req.params.nombre;

        // helper para escapar regex
        const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Construir variantes: exacta, decoded, con guiones bajos
        const variants = [];
        variants.push(requested);
        try { variants.push(decodeURIComponent(requested)); } catch (e) { /* ignore */ }
        variants.push(requested.replace(/\s+/g, '_'));
        try { variants.push(decodeURIComponent(requested).replace(/\s+/g, '_')); } catch (e) { /* ignore */ }

        // Buscar coincidencias exactas primero
        let files = await db.collection('imagenes.files').find({ filename: { $in: variants } }).toArray();

        // Si no hay exactas, buscar por sufijo (p. ej. archivos con timestamp_prefix_originalname.png)
        if (!files || files.length === 0) {
            const basename = (requested.split('/').pop() || requested);
            const regex = new RegExp(escapeRegex(basename) + '$', 'i');
            files = await db.collection('imagenes.files').find({ filename: { $regex: regex } }).toArray();
        }

        if (!files || files.length === 0) {
            res.set('Access-Control-Allow-Origin', '*');
            res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
            return res.sendStatus(404);
        }

        const file = files[0];
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
        res.set('Accept-Ranges', 'bytes');
        res.set('Content-Type', file.contentType || 'application/octet-stream');

        // Soporte para streaming de video (Range requests)
        const range = req.headers.range;
        if (range && /^bytes=/.test(range)) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
            const chunkSize = (end - start) + 1;
            res.status(206);
            res.set('Content-Range', `bytes ${start}-${end}/${file.length}`);
            res.set('Content-Length', chunkSize);
            const downloadStream = gfs.openDownloadStream(file._id, { start, end: end + 1 });
            downloadStream.on('error', () => { res.sendStatus(404); });
            downloadStream.pipe(res);
        } else {
            res.set('Content-Length', file.length);
            const downloadStream = gfs.openDownloadStream(file._id);
            downloadStream.on('error', () => { res.sendStatus(404); });
            downloadStream.pipe(res);
        }
    } catch (err) {
        console.error('Error GET /api/imagen/:nombre:', err);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
        res.sendStatus(500);
    }
});

// Obtener cursos desde MongoDB
app.get('/api/cursos', async (req, res) => {
    try {
        // --- Permite filtrar por categoría desde query string ---
        const filtro = {};
        if (req.query.categoria) {
            filtro.categoria = req.query.categoria;
        }
        const cursos = await cursosCol.find(filtro).toArray();
        cursos.forEach(c => c.id = c._id.toString());
        res.json(cursos);
    } catch (err) {
        res.status(500).json({ error: 'Error al leer los cursos' });
    }
});

// Registrar usuario en MongoDB
app.post('/api/registrar', async (req, res) => {
    const { usuario, password } = req.body;
    if (!usuario || !password) return res.status(400).json({ error: 'Faltan datos' });
    try {
        const existe = await usuariosCol.findOne({ usuario });
        if (existe) return res.status(409).json({ error: 'Usuario ya existe' });
        await usuariosCol.insertOne({ usuario, password, progreso: {} });
        res.json({ mensaje: 'Usuario registrado correctamente' });
    } catch (err) {
        res.status(500).json({ error: 'Error al registrar usuario' });
    }
});

// Login usuario desde MongoDB
app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    if (!usuario || !password) return res.status(400).json({ error: 'Faltan datos' });
    try {
        const user = await usuariosCol.findOne({ usuario, password });
        if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });
        res.json({ mensaje: 'Login correcto' });
    } catch (err) {
        res.status(500).json({ error: 'Error al hacer login' });
    }
});

// Guardar progreso de usuario en MongoDB
app.post('/api/progreso', async (req, res) => {
    const { usuario, cursoId, paso } = req.body;
    if (!usuario || cursoId == null || paso == null) return res.status(400).json({ error: 'Faltan datos' });
    try {
        const user = await usuariosCol.findOne({ usuario });
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
        user.progreso = user.progreso || {};
        user.progreso[cursoId] = { paso };
        await usuariosCol.updateOne({ usuario }, { $set: { progreso: user.progreso } });
        res.json({ mensaje: 'Progreso guardado' });
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar progreso' });
    }
});

// Obtener progreso de usuario desde MongoDB
app.get('/api/progreso/:usuario', async (req, res) => {
    const usuario = req.params.usuario;
    try {
        const user = await usuariosCol.findOne({ usuario });
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json(user.progreso || {});
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener progreso' });
    }
});

// Eliminar curso por ID
app.delete('/api/curso/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const result = await cursosCol.deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 1) {
            io.emit('cursoEliminado', { id });
            res.json({ mensaje: 'Curso eliminado' });
        } else {
            res.status(404).json({ error: 'Curso no encontrado' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar el curso' });
    }
});

// Editar curso por ID (ahora también permite actualizar portada)
app.put('/api/curso/:id', upload.fields([
    { name: 'imagenes' },
    { name: 'portada', maxCount: 1 }
]), async (req, res) => {
    try {
        const id = req.params.id;
        const { titulo, descripcion, portadaNombre, categoria } = req.body; // <-- agrega categoria
        let pasos = [];
        let archivosMap = {};
        let portada = portadaNombre || null;

        // Guardar portada en GridFS si existe
        if (req.files && req.files['portada'] && req.files['portada'][0]) {
            const portadaFile = req.files['portada'][0];
            const bufferStream = new stream.PassThrough();
            bufferStream.end(portadaFile.buffer);
            await new Promise((resolve, reject) => {
                const uploadStream = gfs.openUploadStream(portadaFile.originalname, {
                    contentType: portadaFile.mimetype
                });
                bufferStream.pipe(uploadStream)
                    .on('error', reject)
                    .on('finish', resolve);
            });
            portada = portadaFile.originalname;
        }

        // Guardar imágenes/videos de pasos en GridFS
        if (req.files && req.files['imagenes']) {
            for (const file of req.files['imagenes']) {
                const bufferStream = new stream.PassThrough();
                bufferStream.end(file.buffer);
                await new Promise((resolve, reject) => {
                    const uploadStream = gfs.openUploadStream(file.originalname, {
                        contentType: file.mimetype
                    });
                    bufferStream.pipe(uploadStream)
                        .on('error', reject)
                        .on('finish', resolve);
                });
                archivosMap[file.originalname] = file.originalname;
            }
        }

        if (req.body.pasos) {
            pasos = JSON.parse(req.body.pasos);
            pasos = pasos.map(p => {
                let archivoNombre = p.imagen;
                if (typeof archivoNombre === 'string' && archivoNombre.includes('/')) {
                    archivoNombre = archivoNombre.split('/').pop();
                }
                return {
                    ...p,
                    imagen: archivoNombre && archivosMap[archivoNombre] ? archivoNombre : archivoNombre || null
                };
            });
        }
        // --- Actualiza también la categoría ---
        const result = await cursosCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: { titulo, descripcion, portada, categoria, pasos } }
        );
        if (result.matchedCount === 1) {
            io.emit('cursoEditado', { id, titulo, descripcion, categoria });
            res.json({ mensaje: 'Curso editado' });
        } else {
            res.status(404).json({ error: 'Curso no encontrado' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al editar el curso' });
    }
});

// --- API OpenAI Chatbot ---
const OPENAI_API_KEY = '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';

app.post('/api/chat', async (req, res) => {
    const { mensaje } = req.body;
    if (!mensaje) return res.status(400).json({ error: 'Mensaje requerido' });
    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: mensaje }],
                max_tokens: 100
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        const texto = response.data.choices[0].message.content;
        res.json({ respuesta: texto });
    } catch (err) {
        res.status(500).json({ error: 'Error al consultar OpenAI' });
    }
});

// Socket.IO conexión

// --- Chat de soporte en tiempo real (solo memoria, sin base de datos) ---
const asesores = {}; // Cambia a objeto general
const usuariosPorSocket = {};

io.on('connection', (socket) => {
    const addr = socket.handshake.address || (socket.request && socket.request.connection && socket.request.connection.remoteAddress) || 'unknown';
    const ua = socket.handshake.headers['user-agent'] || '';
    console.log(`[socket] connect id=${socket.id} addr=${addr} ua="${ua}" time=${new Date().toISOString()}`);
     // Registrar socket para diagnóstico y limpiar inactivos
    connectedSockets[socket.id] = { id: socket.id, lastSeen: Date.now(), addr, ua };
     // No forzar conexión a MongoDB al conectar sockets para evitar abrir conexiones por probes/falsos clientes
     // Si se necesita DB en algún evento, las rutas/handlers deberán llamar a ensureConnected() antes.
     // Asegura conexión cuando hay un cliente socket y evita cierre por inactividad
     (async () => { try { await ensureConnected(); } catch(e){ console.error('Error ensureConnected on socket connect', e); } })();
     if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

     // Actualizar lastSeen en cualquier evento recibido
    socket.onAny((event, ...args) => {
        if (connectedSockets[socket.id]) connectedSockets[socket.id].lastSeen = Date.now();
    });

    // El asesor se identifica
    socket.on('chat:soyAsesor', data => {
        if (data && data.usuario) {
            asesores[data.usuario] = socket.id;
            socket.emit('chat:asesorConectado');
            // Notifica a todos los usuarios esperando que el asesor está disponible
            Object.keys(usuariosPorSocket).forEach(userSocketId => {
                io.to(userSocketId).emit('chat:asesorConectado');
            });
            console.log('Asesor conectado:', data.usuario);
        }
    });

    // Usuario solicita hablar con asesor
    socket.on('chat:solicitarAsesor', data => {
        // Permite que el usuario indique el asesor, o usa el primero disponible
        let asesorUsuario = data && data.usuario ? data.usuario : Object.keys(asesores)[0];
        usuariosPorSocket[socket.id] = { asesor: asesorUsuario };
        // Notifica al asesor si está conectado, incluyendo el socketId del usuario
        const asesorSocketId = asesores[asesorUsuario];
        if (asesorSocketId) {
            io.to(asesorSocketId).emit('chat:usuarioSolicitaAsesor', { socketId: socket.id });
            // Notifica SOLO a este usuario que el asesor está disponible
            io.to(socket.id).emit('chat:asesorConectado');
        }
    });

    // Usuario envía mensaje para asesor
    socket.on('chat:mensajeUsuario', data => {
        const asesor = (data && data.para) || (usuariosPorSocket[socket.id] && usuariosPorSocket[socket.id].asesor);
        const asesorSocketId = asesores[asesor];
        if (asesorSocketId) {
            io.to(asesorSocketId).emit('chat:mensajeUsuario', { texto: data.texto, socketId: socket.id });
        }
    });

    // Asesor responde al usuario
    socket.on('chat:mensajeAsesor', data => {
        if (data && data.socketId && data.texto) {
            io.to(data.socketId).emit('chat:mensajeAsesor', { texto: data.texto });
        }
    });

    // Limpieza al desconectar
    socket.on('disconnect', () => {
        // Log de desconexión
        const info = connectedSockets[socket.id] || {};
        console.log(`[socket] disconnect id=${socket.id} addr=${info.addr || 'unknown'} ua="${info.ua || ''}" time=${new Date().toISOString()}`);
        // Elimina al asesor si se desconecta
        for (const usuario in asesores) {
            if (asesores[usuario] === socket.id) {
                asesores[usuario] = null;
            }
        }
        // Notifica al asesor que el usuario se desconectó
        if (usuariosPorSocket[socket.id]) {
            const asesorUsuario = usuariosPorSocket[socket.id].asesor;
            const asesorSocketId = asesores[asesorUsuario];
            if (asesorSocketId) {
                io.to(asesorSocketId).emit('chat:usuarioDesconectado', { socketId: socket.id });
            }
        }
        delete usuariosPorSocket[socket.id];
        // Quitar de la lista de sockets conectados
        if (connectedSockets[socket.id]) {
            delete connectedSockets[socket.id];
        }
        // Si ya no hay sockets, cerrar MongoDB inmediatamente
        if (Object.keys(connectedSockets).length === 0) {
            closeMongoNow().catch(e => console.error('closeMongoNow error:', e));
        } else {
            // Programar cierre por inactividad cuando los sockets se vayan
            scheduleIdleClose();
        }
    });
});

// Recuperar contraseña (ahora actualiza la contraseña directamente)
app.post('/api/recuperar-password', async (req, res) => {
    const { usuario, nuevaPassword } = req.body;
    if (!usuario || !nuevaPassword) return res.status(400).json({ error: 'Usuario y nueva contraseña requeridos' });
    try {
        const user = await usuariosCol.findOne({ usuario });
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
        await usuariosCol.updateOne({ usuario }, { $set: { password: nuevaPassword } });
        res.json({ mensaje: 'Contraseña actualizada correctamente.' });
    } catch (err) {
        res.status(500).json({ error: 'Error al actualizar la contraseña' });
    }
});

// Guardar equipos para un curso (sitio)
app.post('/api/curso/:id/equipos', async (req, res) => {
    try {
        const id = req.params.id;
        const { equipos } = req.body;
        if (!Array.isArray(equipos) || equipos.length === 0) {
            return res.status(400).json({ error: 'Equipos requeridos' });
        }
        // Agrega los equipos a la lista existente (no reemplaza)
        const result = await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $push: { equipos: { $each: equipos } } }
        );
        if (result.matchedCount === 1) {
            res.json({ mensaje: 'Equipos agregados' });
        } else {
            res.status(404).json({ error: 'Sitio no encontrado' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al agregar equipos' });
    }
});

// Editar equipos para un sitio (EDITAR: SET)
app.put('/api/sitio/:id/equipos', async (req, res) => {
    try {
        const id = req.params.id;
        const { equipos } = req.body;
        if (!Array.isArray(equipos)) {
            return res.status(400).json({ error: 'Equipos requeridos' });
        }
        // Reemplaza la lista de equipos por la nueva (edición)
        const result = await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: { equipos } }
        );
        if (result.matchedCount === 1) {
            res.json({ mensaje: 'Equipos actualizados' });
        } else {
            res.status(404).json({ error: 'Sitio no encontrado' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al editar equipos' });
    }
});

// Guardar sitio en MongoDB
app.post('/api/sitio', async (req, res) => {
    try {
        const { titulo, descripcion } = req.body;
        if (!titulo || !descripcion) return res.status(400).json({ error: 'Faltan datos' });
        const result = await sitiosCol.insertOne({ titulo, descripcion });
        io.emit('sitioAgregado', { id: result.insertedId, titulo, descripcion });
        res.json({ mensaje: 'Sitio guardado', id: result.insertedId });
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar sitio' });
    }
});

// Obtener sitios desde MongoDB
app.get('/api/sitios', async (req, res) => {
    try {
        const sitios = await sitiosCol.find({}).toArray();
        sitios.forEach(s => s.id = s._id.toString());
        res.json(sitios);
    } catch (err) {
        res.status(500).json({ error: 'Error al leer los sitios' });
    }
});

// Guardar equipos para un sitio
app.post('/api/sitio/:id/equipos', async (req, res) => {
    try {
        const id = req.params.id;
        const { equipos } = req.body;
        if (!Array.isArray(equipos) || equipos.length === 0) {
            return res.status(400).json({ error: 'Equipos requeridos' });
        }
        // Agrega los equipos a la lista existente (no reemplaza)
        const result = await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $push: { equipos: { $each: equipos } } }
        );
        if (result.matchedCount === 1) {
            res.json({ mensaje: 'Equipos agregados' });
        } else {
            res.status(404).json({ error: 'Sitio no encontrado' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al agregar equipos' });
    }
});

// Obtener equipos de un sitio (opcional)
app.get('/api/sitio/:id/equipos', async (req, res) => {
    try {
        const id = req.params.id;
        const sitio = await sitiosCol.findOne({ _id: new ObjectId(id) });
        if (!sitio) return res.status(404).json({ error: 'Sitio no encontrado' });
        res.json({ equipos: sitio.equipos || [] });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener equipos' });
    }
});

// Guardar ticket y evidencias fotográficas para un sitio
app.post('/api/sitio/:id/ticket', upload.any(), async (req, res) => {
    try {
        const id = req.params.id;
        // Agrega los campos del instalador
        const { folio, tipo, descripcion, estado, motivoNoTerminado, evidenciaEscrita, nombreRecibe, firma, nombreInstalador, firmaInstalador, responsable, empresaId } = req.body;
        if (!tipo || !descripcion || !estado) return res.status(400).json({ error: 'Faltan datos' });

        // Procesar archivos
        let evidencias = [];
        let evidenciasNoTerminado = [];
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const bufferStream = new stream.PassThrough();
                bufferStream.end(file.buffer);
                await new Promise((resolve, reject) => {
                    const uploadStream = gfs.openUploadStream(file.originalname, {
                        contentType: file.mimetype
                    });
                    bufferStream.pipe(uploadStream)
                        .on('error', reject)
                        .on('finish', resolve);
                });
                // Clasifica por campo
                if (file.fieldname === 'fotosNoTerminado' || file.fieldname === 'fotosNoTerminado[]') {
                    evidenciasNoTerminado.push({
                        nombre: file.originalname,
                        url: `/api/imagen/${file.originalname}`
                    });
                } else {
                    evidencias.push({
                        nombre: file.originalname,
                        url: `/api/imagen/${file.originalname}`
                    });
                }
            }
        }

        // Construir ticket
        const ticket = {
            folio,
            tipo,
            descripcion,
            estado,
            evidencias,
            fecha: new Date(),
            nombreRecibe: nombreRecibe || '',
            firma: firma || '',
            // NUEVO: instalador
            nombreInstalador: nombreInstalador || '',
            firmaInstalador: firmaInstalador || '',
            // NUEVO: responsable (puede venir desde admin)
            responsable: responsable || ''
        };

        // NUEVO: guardar empresa seleccionada si viene
        if (empresaId) {
            ticket.empresaId = String(empresaId);
        }

        // Si está en curso, agrega motivo y evidencias de no terminado
        if (estado === 'en_curso') {
            ticket.motivoNoTerminado = motivoNoTerminado || '';
            ticket.evidenciaEscrita = evidenciaEscrita || '';
            ticket.evidenciasNoTerminado = evidenciasNoTerminado;
        }

        // Guardar ticket en el sitio
        const result = await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $push: { tickets: ticket } }
        );
        if (result.matchedCount === 1) {
            io.emit('ticketAgregado', { sitioId: id, ticket });
            res.json({ mensaje: 'Ticket guardado', ticket });
        } else {
            res.status(404).json({ error: 'Sitio no encontrado' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar ticket' });
    }
});

// Obtener evidencias fotográficas previas de un sitio (devuelve todas las evidencias de todos los tickets)
app.get('/api/sitio/:id/evidencias', async (req, res) => {
    try {
        const id = req.params.id;
        const sitio = await sitiosCol.findOne({ _id: new ObjectId(id) });
        if (!sitio) return res.status(404).json({ error: 'Sitio no encontrado' });
        let evidencias = [];
        if (Array.isArray(sitio.tickets)) {
            sitio.tickets.forEach(ticket => {
                if (Array.isArray(ticket.evidencias)) {
                    evidencias = evidencias.concat(ticket.evidencias);
                }
            });
        }
        res.json({ evidencias });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener evidencias' });
    }
});

// Opcional: obtener todos los tickets de un sitio
app.get('/api/sitio/:id/tickets', async (req, res) => {
    try {
        const id = req.params.id;
        const sitio = await sitiosCol.findOne({ _id: new ObjectId(id) });
        if (!sitio) return res.status(404).json({ error: 'Sitio no encontrado' });
        res.json({ tickets: sitio.tickets || [] });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener tickets' });
    }
});

// Eliminar sitio por ID
app.delete('/api/sitio/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const result = await sitiosCol.deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 1) {
            io.emit('sitioEliminado', { id });
            res.json({ mensaje: 'Sitio eliminado' });
        } else {
            res.status(404).json({ error: 'Sitio no encontrado' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar el sitio' });
    }
});

// Actualizar estado de un ticket (reabrir o terminar)
app.put('/api/sitio/:id/ticket/:ticketIdx', async (req, res) => {
    try {
        const id = req.params.id;
        const ticketIdx = parseInt(req.params.ticketIdx, 10);
        const { estado, motivoNoTerminado, evidenciaEscrita } = req.body;
        if (!estado || isNaN(ticketIdx)) return res.status(400).json({ error: 'Faltan datos' });

        const sitio = await sitiosCol.findOne({ _id: new ObjectId(id) });
        if (!sitio || !Array.isArray(sitio.tickets) || !sitio.tickets[ticketIdx]) {
            return res.status(404).json({ error: 'Ticket o sitio no encontrado' });
        }

        // Actualiza el estado y motivo si corresponde
        const updateFields = {
            [`tickets.${ticketIdx}.estado`]: estado
        };
        if (estado === 'en_curso') {
            updateFields[`tickets.${ticketIdx}.motivoNoTerminado`] = motivoNoTerminado || '';
            updateFields[`tickets.${ticketIdx}.evidenciaEscrita`] = evidenciaEscrita || '';
        } else {
            updateFields[`tickets.${ticketIdx}.motivoNoTerminado`] = '';
            updateFields[`tickets.${ticketIdx}.evidenciaEscrita`] = '';
        }

        await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateFields }
        );
        res.json({ mensaje: 'Ticket actualizado' });
    } catch (err) {
        res.status(500).json({ error: 'Error al actualizar el ticket' });
    }
});

// Registrar nueva visita en un ticket
app.post('/api/sitio/:id/ticket/:ticketIdx/visita', async (req, res) => {
    try {
        const id = req.params.id;
        const ticketIdx = parseInt(req.params.ticketIdx, 10);
        const { comentario, evidenciaEscrita } = req.body;
        if (isNaN(ticketIdx)) return res.status(400).json({ error: 'Ticket inválido' });

        const sitio = await sitiosCol.findOne({ _id: new ObjectId(id) });
        if (!sitio || !Array.isArray(sitio.tickets) || !sitio.tickets[ticketIdx]) {
            return res.status(404).json({ error: 'Ticket o sitio no encontrado' });
        }

        const visita = {
            fecha: new Date(),
            comentario: comentario || '',
            evidenciaEscrita: evidenciaEscrita || ''
        };

        await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $push: { [`tickets.${ticketIdx}.visitas`]: visita } }
        );
        res.json({ mensaje: 'Visita registrada', visita });
    } catch (err) {
        res.status(500).json({ error: 'Error al registrar visita' });
    }
});

// Marcar ticket como terminado y guardar evidencia escrita/fotográfica en la visita final
app.post('/api/sitio/:id/ticket/:ticketIdx/terminar', upload.array('fotos'), async (req, res) => {
    try {
        const id = req.params.id;
        const ticketIdx = parseInt(req.params.ticketIdx, 10);
        const { evidenciaEscrita, estado } = req.body;
        if (isNaN(ticketIdx) || estado !== 'terminado') return res.status(400).json({ error: 'Datos inválidos' });

        const sitio = await sitiosCol.findOne({ _id: new ObjectId(id) });
        if (!sitio || !Array.isArray(sitio.tickets) || !sitio.tickets[ticketIdx]) {
            return res.status(404).json({ error: 'Ticket o sitio no encontrado' });
        }

        // Procesar imágenes
        let evidencias = [];
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const bufferStream = new stream.PassThrough();
                bufferStream.end(file.buffer);
                await new Promise((resolve, reject) => {
                    const uploadStream = gfs.openUploadStream(file.originalname, {
                        contentType: file.mimetype
                    });
                    bufferStream.pipe(uploadStream)
                        .on('error', reject)
                        .on('finish', resolve);
                });
                evidencias.push({
                    nombre: file.originalname,
                    url: `/api/imagen/${file.originalname}`
                });
            }
        }

        // Actualiza el ticket
        const updateFields = {
            [`tickets.${ticketIdx}.estado`]: 'terminado',
            [`tickets.${ticketIdx}.evidenciaEscrita`]: evidenciaEscrita || '',
        };
        if (evidencias.length > 0) {
            updateFields[`tickets.${ticketIdx}.evidenciasFinal`] = evidencias;
        }

        await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateFields }
        );
        res.json({ mensaje: 'Ticket marcado como terminado', evidencias });
    } catch (err) {
        res.status(500).json({ error: 'Error al terminar el ticket' });
    }
});

// Verificar sesión de usuario
app.post('/api/verificar-sesion', async (req, res) => {
    const { usuario } = req.body;
    if (!usuario) return res.status(400).json({ valida: false, error: 'Usuario requerido' });
    try {
        const user = await usuariosCol.findOne({ usuario });
        if (user) {
            res.json({ valida: true });
        } else {
            res.json({ valida: false });
        }
    } catch (err) {
        res.status(500).json({ valida: false, error: 'Error al verificar sesión' });
    }
});

// Subir planos/imágenes de un sitio
app.post('/api/sitio/:id/planos', upload.array('planos'), async (req, res) => {
    try {
        const id = req.params.id;
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No se enviaron archivos' });
        }
        let planos = [];
        for (const file of req.files) {
            const bufferStream = new stream.PassThrough();
            bufferStream.end(file.buffer);
            await new Promise((resolve, reject) => {
                const uploadStream = gfs.openUploadStream(file.originalname, {
                    contentType: file.mimetype
                });
                bufferStream.pipe(uploadStream)
                    .on('error', reject)
                    .on('finish', resolve);
            });
            planos.push({
                nombre: file.originalname,
                url: `/api/imagen/${file.originalname}`
            });
        }
        // Guarda los planos en el sitio
        await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $push: { planos: { $each: planos } } }
        );
        res.json({ mensaje: 'Planos subidos', planos });
    } catch (err) {
        res.status(500).json({ error: 'Error al subir planos' });
    }
});

// Obtener planos/imágenes de un sitio
app.get('/api/sitio/:id/planos', async (req, res) => {
    try {
        const id = req.params.id;
        const sitio = await sitiosCol.findOne({ _id: new ObjectId(id) });
        if (!sitio) return res.status(404).json({ error: 'Sitio no encontrado' });
        res.json({ planos: sitio.planos || [] });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener planos' });
    }
});

// Subir material del sitio (fotos, documentos, etc)
app.post('/api/sitio/:id/material', upload.array('material'), async (req, res) => {
    try {
        const id = req.params.id;
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No se enviaron archivos' });
        }
        let material = [];
        for (const file of req.files) {
            const bufferStream = new stream.PassThrough();
            bufferStream.end(file.buffer);
            await new Promise((resolve, reject) => {
                const uploadStream = gfs.openUploadStream(file.originalname, {
                    contentType: file.mimetype
                });
                bufferStream.pipe(uploadStream)
                    .on('error', reject)
                    .on('finish', resolve);
            });
            material.push({
                nombre: file.originalname,
                url: `/api/imagen/${file.originalname}`
            });
        }
        // Guarda el material en el sitio
        await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $push: { material: { $each: material } } }
        );
        res.json({ mensaje: 'Material subido', material });
    } catch (err) {
        res.status(500).json({ error: 'Error al subir material' });
    }
});

// Obtener material del sitio
app.get('/api/sitio/:id/material', async (req, res) => {
    try {
        const id = req.params.id;
        const sitio = await sitiosCol.findOne({ _id: new ObjectId(id) });
        if (!sitio) return res.status(404).json({ error: 'Sitio no encontrado' });
        res.json({ material: sitio.material || [] });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener material' });
    }
});

// Eliminar material específico de un sitio
app.delete('/api/sitio/:id/material/:nombre', async (req, res) => {
    try {
        const id = req.params.id;
        const nombre = req.params.nombre;
        const sitio = await sitiosCol.findOne({ _id: new ObjectId(id) });
        if (!sitio) return res.status(404).json({ error: 'Sitio no encontrado' });
        const material = Array.isArray(sitio.material) ? sitio.material : [];
        const nuevoMaterial = material.filter(m => m.nombre !== nombre);
        await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: { material: nuevoMaterial } }
        );
        res.json({ mensaje: 'Material eliminado' });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar material' });
    }
});

// Eliminar sitio solo si el código maestro es correcto
app.delete('/api/sitio/:id/eliminar-con-codigo', async (req, res) => {
    try {
        const id = req.params.id;
        const { codigoMaestro } = req.body;
        // Cambia este valor por tu código maestro real
        const CODIGO_MAESTRO = '131718';
        if (codigoMaestro !== CODIGO_MAESTRO) {
            return res.status(403).json({ error: 'Código maestro incorrecto' });
        }
        const result = await sitiosCol.deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 1) {
            io.emit('sitioEliminado', { id });
            res.json({ mensaje: 'Sitio eliminado' });
        } else {
            res.status(404).json({ error: 'Sitio no encontrado' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar el sitio' });
    }
});

// Marcar un sitio como "sitio de trabajo" (sin equipos)
app.post('/api/sitio/:id/marcar-trabajo', async (req, res) => {
    try {
        const id = req.params.id;
        const result = await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: { esSitioTrabajo: true } }
        );
        if (result.matchedCount === 1) {
            res.json({ mensaje: 'Sitio marcado como sitio de trabajo' });
        } else {
            res.status(404).json({ error: 'Sitio no encontrado' });
       
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al marcar sitio de trabajo' });
    }
});

// Subir evidencia de trabajo realizado en sitio de trabajo
app.post('/api/sitio/:id/trabajo', require('multer')().any(), async (req, res) => {
    try {
        const id = req.params.id;
        const { descripcion } = req.body;
        if (!descripcion) return res.status(400).json({ error: 'Descripción requerida' });

        // Procesar fotos
        let fotos = [];
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const bufferStream = new stream.PassThrough();
                bufferStream.end(file.buffer);
                await new Promise((resolve, reject) => {
                    const uploadStream = gfs.openUploadStream(file.originalname, {
                        contentType: file.mimetype
                    });
                    bufferStream.pipe(uploadStream)
                        .on('error', reject)
                        .on('finish', resolve);
                });
                fotos.push({
                    nombre: file.originalname,
                    url: `/api/imagen/${file.originalname}`
                });
            }
        }

        // Guarda la evidencia en el sitio
        const evidencia = {
            descripcion,
            fotos,
            fecha: new Date()
        };
        await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $push: { evidenciasTrabajo: evidencia } }
        );
        res.json({ mensaje: 'Evidencia de trabajo guardada', evidencia });
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar evidencia de trabajo' });
    }
});

// Consultar evidencias de trabajo de un sitio de trabajo
app.get('/api/sitio/:id/evidencias-trabajo', async (req, res) => {
    try {
        const id = req.params.id;
        const sitio = await sitiosCol.findOne({ _id: new ObjectId(id) });
        if (!sitio) return res.status(404).json({ error: 'Sitio no encontrado' });
        res.json({ evidenciasTrabajo: sitio.evidenciasTrabajo || [] });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener evidencias de trabajo' });
    }
});

// Endpoint para entregar un sitio (marcar como entregado)
app.post('/api/sitio/:id/entregar', async (req, res) => {
    try {
        const id = req.params.id;
        const sitio = await sitiosCol.findOne({ _id: new ObjectId(id) });
        if (!sitio) return res.status(404).json({ error: 'Sitio no encontrado' });
        // Elimina la verificación para permitir entregar varias veces
        // if (sitio.entregado) {
        //     return res.status(400).json({ error: 'El sitio ya fue entregado' });
        // }
        await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: { entregado: true, fechaEntrega: new Date() } }
        );
        res.json({ mensaje: 'Sitio entregado correctamente' });
    } catch (err) {
        res.status(500).json({ error: 'Error al entregar el sitio' });
    }
});

// Endpoint de salud para Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Editar un solo equipo de un sitio por índice
app.put('/api/sitio/:id/equipo/:idx', async (req, res) => {
    try {
        const id = req.params.id;
        const idx = parseInt(req.params.idx, 10);
        const { nombre, modelo, serie, ip, usuario, password } = req.body;
        if (isNaN(idx)) return res.status(400).json({ error: 'Índice inválido' });
        // Construye el objeto de actualización solo con los campos enviados
        const updateFields = {};
        if (nombre !== undefined) updateFields[`equipos.${idx}.nombre`] = nombre;
        if (modelo !== undefined) updateFields[`equipos.${idx}.modelo`] = modelo;
        if (serie !== undefined) updateFields[`equipos.${idx}.serie`] = serie;
        if (ip !== undefined) updateFields[`equipos.${idx}.ip`] = ip;
        if (usuario !== undefined) updateFields[`equipos.${idx}.usuario`] = usuario;
        if (password !== undefined) updateFields[`equipos.${idx}.password`] = password;

        const result = await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateFields }
        );
        if (result.matchedCount === 1) {
            res.json({ mensaje: 'Equipo actualizado' });
        } else {
            res.status(404).json({ error: 'Sitio no encontrado' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al editar el equipo' });
    }
});

// ENDPOINTS PARA TICKETS ADMINISTRATIVOS (guardar en BD y notificar por Socket.IO)

// Obtener todos los tickets administrativos
app.get('/api/admin/tickets', async (req, res) => {
    try {
        const tickets = await adminTicketsCol.find({}).sort({ fecha: -1 }).toArray();
        tickets.forEach(t => t.id = t._id.toString());
        res.json(tickets);
    } catch (err) {
        res.status(500).json({ error: 'Error al leer tickets administrativos' });
    }
});

// Crear ticket administrativo
app.post('/api/admin/ticket', async (req, res) => {
    try {
        const { folio, actividad, responsable } = req.body;
        if (!folio || !actividad || !responsable) return res.status(400).json({ error: 'Faltan datos' });
        const ticket = { folio, actividad, responsable, fecha: new Date() };
        const result = await adminTicketsCol.insertOne(ticket);
       
        ticket.id = result.insertedId.toString();
        io.emit('adminTicketAgregado', ticket);
        res.json({ mensaje: 'Ticket creado', ticket });
    } catch (err) {
        res.status(500).json({ error: 'Error al crear ticket administrativo' });
    }
});

// Eliminar ticket administrativo por id
app.delete('/api/admin/ticket/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const result = await adminTicketsCol.deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 1) {
            io.emit('adminTicketEliminado', { id });
            res.json({ mensaje: 'Ticket eliminado', id });
        } else {
            res.status(404).json({ error: 'Ticket no encontrado' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar ticket' });
    }
});

// Eliminar movimiento de inventario por índice
app.post('/api/inventario/movimiento/eliminar', async (req, res) => {
    try {
        let { usuario, proyectoIdx, movIdx } = req.body;
        if (!usuario) return res.status(400).json({ error: 'Faltan datos' });
        proyectoIdx = parseInt(proyectoIdx, 10);
        movIdx = parseInt(movIdx, 10);
        if (isNaN(proyectoIdx) || isNaN(movIdx)) return res.status(400).json({ error: 'Índices inválidos' });

        const doc = await inventariosCol.findOne({ usuario });
        if (!doc) return res.status(404).json({ error: 'Inventario de usuario no encontrado' });

        const proyecto = Array.isArray(doc.proyectos) ? doc.proyectos[proyectoIdx] : null;
        if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado' });

        if (!Array.isArray(proyecto.movimientos) || movIdx < 0 || movIdx >= proyecto.movimientos.length) {
            return res.status(404).json({ error: 'Movimiento no encontrado' });
        }

        // Usar $unset y luego $pull para limpiar nulls
        const unsetField = `proyectos.${proyectoIdx}.movimientos.${movIdx}`;
        await inventariosCol.updateOne(
            { usuario },
            { $unset: { [unsetField]: 1 } }
        );
        await inventariosCol.updateOne(
            { usuario },
            { $pull: { [`proyectos.${proyectoIdx}.movimientos`]: null } }
        );
        res.json({ mensaje: 'Movimiento eliminado' });
    } catch (err) {
        // Log detallado para ver error real en Render
        console.error(`[${new Date().toISOString()}] Error eliminando movimiento:`, err && err.stack ? err.stack : err);
        // Responder con detalle mínimo para debugging en Render
        res.status(500).json({ error: 'Error al eliminar movimiento', detail: err && err.message ? err.message : String(err) });
    }
});

// Endpoint para obtener todos los inventarios completos (proyectos, productos, movimientos, usuarios)
app.get('/api/inventarios/todo', async (req, res) => {
    try {
        const inventarios = await db.collection('inventarios').find({}).toArray();
        res.json({ inventarios });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener todos los inventarios' });
    }
});

// --- NUEVOS ENDPOINTS: Empresas (list, create, edit, delete) ---
app.get('/api/empresas', async (req, res) => {
    try {
        await ensureConnected();
        const docs = await empresasCol.find({}).toArray();
        // Construir base URL absoluta (respetando protocolo y host de la petición)
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const out = docs.map(d => {
            // si el documento tiene un logo en GridFS, construir imageUrl absoluto con version
            let imageUrl = undefined;
            if (d.logo) {
                const ver = d.logoVersion ? `?v=${encodeURIComponent(d.logoVersion)}` : '';
                imageUrl = `${baseUrl}/api/imagen/${encodeURIComponent(d.logo)}${ver}`;
            } else if (d.url && /^https?:\/\//i.test(String(d.url).trim())) {
                imageUrl = d.url;
            } else if (d.url && typeof d.url === 'string' && d.url.startsWith('/')) {
                // ruta relativa en el server -> convertir a absoluta
                imageUrl = `${baseUrl}${d.url}`;
            }
            return {
                id: d._id.toString(),
                nombre: d.nombre,
                logo: d.logo,
                logoVersion: d.logoVersion || null,
                url: d.url || null,
                imageUrl
            };
        });
        res.json(out);
    } catch (err) {
        console.error('Error GET /api/empresas:', err);
        res.status(500).json({ error: 'Error al listar empresas' });
    }
});

// Crear empresa (nombre + logo opcional)
app.post('/api/empresa', upload.single('logo'), async (req, res) => {
    try {
        await ensureConnected();
        const nombre = req.body.nombre || '';
        let logoFilename = null;
        let logoVersion = null;
        if (req.file) {
            const original = req.file.originalname || 'logo';
            const filename = `${Date.now()}_${original.replace(/\s+/g, '_')}`;
            const bufferStream = new stream.PassThrough();
            bufferStream.end(req.file.buffer);
            await new Promise((resolve, reject) => {
                const uploadStream = gfs.openUploadStream(filename, { contentType: req.file.mimetype });
                bufferStream.pipe(uploadStream).on('error', reject).on('finish', resolve);
            });
            logoFilename = filename;
            logoVersion = Date.now();
        }
        const doc = { nombre, logo: logoFilename, logoVersion };
        const result = await empresasCol.insertOne(doc);
        res.json({ mensaje: 'Empresa creada', id: result.insertedId.toString() });
    } catch (err) {
        console.error('Error POST /api/empresa:', err);
        res.status(500).json({ error: 'Error creando empresa' });
    }
});

// Editar empresa (nombre y/o logo)
app.put('/api/empresa/:id', upload.single('logo'), async (req, res) => {
    try {
        await ensureConnected();
        const id = req.params.id;
        const nombre = req.body.nombre;
        const update = {};
        if (typeof nombre === 'string') update.nombre = nombre;
        if (req.file) {
            // subir nuevo logo
            const original = req.file.originalname || 'logo';
            const filename = `${Date.now()}_${original.replace(/\s+/g, '_')}`;
            const bufferStream = new stream.PassThrough();
            bufferStream.end(req.file.buffer);
            await new Promise((resolve, reject) => {
                const uploadStream = gfs.openUploadStream(filename, { contentType: req.file.mimetype });
                bufferStream.pipe(uploadStream).on('error', reject).on('finish', resolve);
            });
            // obtener documento previo para eliminar logo antiguo si existe
            const prev = await empresasCol.findOne({ _id: new ObjectId(id) });
            if (prev && prev.logo) {
                try {
                    const files = await db.collection('imagenes.files').find({ filename: prev.logo }).toArray();
                    for (const f of files) {
                        try { await gfs.delete(f._id); } catch (e) { /* ignore */ }
                    }
                } catch (e) { /* ignore */ }
            }
            update.logo = filename;
            update.logoVersion = Date.now();
        }
        const result = await empresasCol.updateOne({ _id: new ObjectId(id) }, { $set: update });
        if (result.matchedCount === 1) {
            res.json({ mensaje: 'Empresa actualizada' });
        } else {
            res.status(404).json({ error: 'Empresa no encontrada' });
        }
    } catch (err) {
        console.error('Error PUT /api/empresa/:id:', err);
        res.status(500).json({ error: 'Error actualizando empresa' });
    }
});

// Eliminar empresa y archivo en GridFS si existe
app.delete('/api/empresa/:id', async (req, res) => {
    try {
        await ensureConnected();
        const id = req.params.id;
        const doc = await empresasCol.findOne({ _id: new ObjectId(id) });
        if (!doc) return res.status(404).json({ error: 'Empresa no encontrada' });
        const result = await empresasCol.deleteOne({ _id: new ObjectId(id) });
        if (doc.logo) {
            try {
                const files = await db.collection('imagenes.files').find({ filename: doc.logo }).toArray();
                for (const f of files) {
                    try { await gfs.delete(f._id); } catch (e) { /* ignore */ }
                }
            } catch (e) { /* ignore */ }
        }
        res.json({ mensaje: 'Empresa eliminada' });
    } catch (err) {
        console.error('Error DELETE /api/empresa/:id:', err);
        res.status(500).json({ error: 'Error eliminando empresa' });
    }
});
