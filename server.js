const express = require('express');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const fs = require('fs');
const axios = require('axios'); // Agrega axios para llamadas HTTP

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

// --- MongoDB config ---
// NUEVA CADENA DE CONEXIÓN PARA AZURE COSMOS DB
const MONGO_URL = 'mongodb://capacitacion:9xPmxNE3KXsvG5GtaWtemTrdzTNKFlFwb7POLtG1g0oCdz3J3Tn98xYg3M8K8yxGHGz5UH2jEVAoACDbPQD9tA==@capacitacion.mongo.cosmos.azure.com:10255/?ssl=true&retrywrites=false&maxIdleTimeMS=120000&appName=@capacitacion@';
const DB_NAME = 'capacitacion';
let db, cursosCol, usuariosCol, sitiosCol;
// Elimina gfs y GridFSBucket

MongoClient.connect(MONGO_URL)
    .then(client => {
        db = client.db(DB_NAME);
        cursosCol = db.collection('cursos');
        usuariosCol = db.collection('usuarios');
        sitiosCol = db.collection('sitios');
        console.log('Conectado a Cosmos DB');
    })
    .catch(err => {
        console.error('Error conectando a Cosmos DB', err);
        process.exit(1);
    });

// --- Cambia multer a guardar en disco ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOADS_DIR);
    },
    filename: function (req, file, cb) {
        // Usa nombre original, pero puedes agregar timestamp si quieres evitar duplicados
        cb(null, Date.now() + '_' + file.originalname);
    }
});
const upload = multer({ storage });

// Sirve archivos estáticos desde /uploads
app.use('/api/imagen', express.static(UPLOADS_DIR));

const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Guardar curso y pasos en Cosmos DB y guardar imágenes/videos en disco
app.post('/api/curso', upload.fields([
    { name: 'imagenes' },
    { name: 'portada', maxCount: 1 }
]), async (req, res) => {
    try {
        const { titulo, descripcion, portadaNombre, categoria } = req.body;
        let pasos = [];
        let archivosMap = {};
        let portada = null;

        // Guardar portada en disco si existe
        if (req.files && req.files['portada'] && req.files['portada'][0]) {
            portada = req.files['portada'][0].filename;
        } else if (portadaNombre) {
            portada = portadaNombre;
        }

        // Guardar imágenes/videos de pasos en disco
        if (req.files && req.files['imagenes']) {
            for (const file of req.files['imagenes']) {
                archivosMap[file.originalname] = file.filename;
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
                    imagen: archivoNombre && archivosMap[archivoNombre] ? archivosMap[archivoNombre] : null
                };
            });
        }
        await cursosCol.insertOne({ titulo, descripcion, portada, categoria, pasos });
        io.emit('nuevoCurso', { mensaje: 'Nuevo curso agregado' });
        res.json({ mensaje: 'Curso recibido' });
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar el curso' });
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
        res.json({ mensaje: 'Usuario registrado' });
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

        // Guardar portada en disco si existe
        if (req.files && req.files['portada'] && req.files['portada'][0]) {
            portada = req.files['portada'][0].filename;
        }

        // Guardar imágenes/videos de pasos en disco
        if (req.files && req.files['imagenes']) {
            for (const file of req.files['imagenes']) {
                archivosMap[file.originalname] = file.filename;
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
io.on('connection', (socket) => {
    console.log('Cliente conectado vía Socket.IO');
    // Opcional: puedes escuchar eventos del frontend aquí si quieres
    // socket.on('crearCurso', async (data) => { ... });
    // socket.on('eliminarCurso', async (data) => { ... });
    // socket.on('editarCurso', async (data) => { ... });
    // socket.on('crearSitio', async (data) => { ... });
    // socket.on('editarSitio', async (data) => { ... });
    // socket.on('eliminarSitio', async (data) => { ... });
});

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`Servidor backend GridFS iniciado en puerto ${PORT}`);
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
        const result = await cursosCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: { equipos } }
        );
        if (result.matchedCount === 1) {
            io.emit('equiposActualizados', { sitioId: id });
            res.json({ mensaje: 'Equipos guardados' });
        } else {
            res.status(404).json({ error: 'Curso no encontrado' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar equipos' });
    }
});

// Obtener equipos de un curso (opcional)
app.get('/api/curso/:id/equipos', async (req, res) => {
    try {
        const id = req.params.id;
        const curso = await cursosCol.findOne({ _id: new ObjectId(id) });
        if (!curso) return res.status(404).json({ error: 'Curso no encontrado' });
        res.json({ equipos: curso.equipos || [] });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener equipos' });
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
        const result = await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: { equipos } }
        );
        if (result.matchedCount === 1) {
            res.json({ mensaje: 'Equipos guardados' });
        } else {
            res.status(404).json({ error: 'Sitio no encontrado' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar equipos' });
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
        const { folio, tipo, descripcion, estado, motivoNoTerminado, evidenciaEscrita } = req.body;
        if (!tipo || !descripcion || !estado) return res.status(400).json({ error: 'Faltan datos' });

        // Procesar archivos
        let evidencias = [];
        let evidenciasNoTerminado = [];
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                // Clasifica por campo
                if (file.fieldname === 'fotosNoTerminado') {
                    evidenciasNoTerminado.push({
                        nombre: file.originalname,
                        url: `/api/imagen/${file.filename}`
                    });
                } else {
                    evidencias.push({
                        nombre: file.originalname,
                        url: `/api/imagen/${file.filename}`
                    });
                }
            }
        }

        // Construir ticket
        const ticket = {
            folio, // <-- agrega el folio aquí
            tipo,
            descripcion,
            estado,
            evidencias,
            fecha: new Date()
        };

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
                evidencias.push({
                    nombre: file.originalname,
                    url: `/api/imagen/${file.filename}`
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
            planos.push({
                nombre: file.originalname,
                url: `/api/imagen/${file.filename}`
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
            material.push({
                nombre: file.originalname,
                url: `/api/imagen/${file.filename}`
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
                fotos.push({
                    nombre: file.originalname,
                    url: `/api/imagen/${file.filename}`
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
        if (sitio.entregado) {
            return res.status(400).json({ error: 'El sitio ya fue entregado' });
        }
        await sitiosCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: { entregado: true, fechaEntrega: new Date() } }
        );
        res.json({ mensaje: 'Sitio entregado correctamente' });
    } catch (err) {
        res.status(500).json({ error: 'Error al entregar el sitio' });
    }
});
