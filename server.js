const express = require('express');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const stream = require('stream');
const axios = require('axios'); // Agrega axios para llamadas HTTP

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

// --- MongoDB config ---
const MONGO_URL = 'mongodb+srv://daniel:daniel25@capacitacion.nxd7yl9.mongodb.net/?retryWrites=true&w=majority&appName=capacitacion&authSource=admin';
const DB_NAME = 'capacitacion';
let db, cursosCol, usuariosCol, gfs;

MongoClient.connect(MONGO_URL)
    .then(client => {
        db = client.db(DB_NAME);
        cursosCol = db.collection('cursos');
        usuariosCol = db.collection('usuarios');
        gfs = new GridFSBucket(db, { bucketName: 'imagenes' });
        console.log('Conectado a MongoDB y GridFS');
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
        const { titulo, descripcion, portadaNombre } = req.body;
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

        await cursosCol.insertOne({ titulo, descripcion, portada, pasos });
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
        const nombre = req.params.nombre;
        const files = await db.collection('imagenes.files').find({ filename: nombre }).toArray();
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
            const downloadStream = gfs.openDownloadStreamByName(nombre, { start, end: end + 1 });
            downloadStream.on('error', () => {
                res.sendStatus(404);
            });
            downloadStream.pipe(res);
        } else {
            res.set('Content-Length', file.length);
            const downloadStream = gfs.openDownloadStreamByName(nombre);
            downloadStream.on('error', () => {
                res.sendStatus(404);
            });
            downloadStream.pipe(res);
        }
    } catch (err) {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
        res.sendStatus(500);
    }
});

// Obtener cursos desde MongoDB
app.get('/api/cursos', async (req, res) => {
    try {
        const cursos = await cursosCol.find({}).toArray();
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
        const { titulo, descripcion, portadaNombre } = req.body;
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

        const result = await cursosCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: { titulo, descripcion, portada, pasos } }
        );
        if (result.matchedCount === 1) {
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

