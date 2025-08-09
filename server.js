const express = require('express');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const stream = require('stream');

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

// Guardar curso y pasos en MongoDB y guardar imágenes en GridFS
app.post('/api/curso', upload.array('imagenes'), async (req, res) => {
    try {
        const { titulo, descripcion } = req.body;
        let pasos = [];
        let imagenesMap = {};
        if (req.files && req.files.length > 0) {
            // Guardar cada imagen en GridFS
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
                imagenesMap[file.originalname] = file.originalname;
            }
        }
        if (req.body.pasos) {
            pasos = JSON.parse(req.body.pasos);
            pasos = pasos.map(p => ({
                ...p,
                imagen: p.imagen && imagenesMap[p.imagen] ? imagenesMap[p.imagen] : null
            }));
        }
        await cursosCol.insertOne({ titulo, descripcion, pasos });
        io.emit('nuevoCurso', { mensaje: 'Nuevo curso agregado' });
        res.json({ mensaje: 'Curso recibido' });
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar el curso' });
    }
});

// Endpoint para servir imágenes desde GridFS
app.get('/api/imagen/:nombre', async (req, res) => {
    try {
        const nombre = req.params.nombre;
        // Buscar el archivo en GridFS para obtener el contentType
        const files = await db.collection('imagenes.files').find({ filename: nombre }).toArray();
        if (!files || files.length === 0) {
            return res.status(404).json({ error: 'Imagen no encontrada' });
        }
        const file = files[0];
        // Setear CORS headers manualmente para imágenes
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        // Setear el Content-Type real
        res.set('Content-Type', file.contentType || 'application/octet-stream');
        const downloadStream = gfs.openDownloadStreamByName(nombre);
        downloadStream.on('error', () => res.status(404).json({ error: 'Imagen no encontrada' }));
        downloadStream.pipe(res);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener la imagen' });
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

// Editar curso por ID (no actualiza imágenes en este ejemplo)
app.put('/api/curso/:id', upload.array('imagenes'), async (req, res) => {
    try {
        const id = req.params.id;
        const { titulo, descripcion } = req.body;
        let pasos = [];
        if (req.body.pasos) {
            pasos = JSON.parse(req.body.pasos);
        }
        const result = await cursosCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: { titulo, descripcion, pasos } }
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

// Socket.IO conexión
io.on('connection', (socket) => {
    console.log('Cliente conectado vía Socket.IO');
});

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`Servidor backend GridFS iniciado en puerto ${PORT}`);
});
