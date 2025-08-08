const express = require('express');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

// Carpeta para imágenes y cursos
const uploadsDir = path.join(__dirname, '../frontend/uploads');
const cursosJsonPath = path.join(__dirname, '../frontend/cursos.json');
const usuariosJsonPath = path.join(__dirname, '../frontend/usuarios.json');

// Crear carpetas y archivos si no existen
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(cursosJsonPath)) fs.writeFileSync(cursosJsonPath, '[]', 'utf8');
if (!fs.existsSync(usuariosJsonPath)) fs.writeFileSync(usuariosJsonPath, '{}', 'utf8');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage });

const corsOptions = {
    origin: '*', // Permitir cualquier origen (útil para apps móviles)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.use(express.json()); // Asegura que los POST con JSON funcionen
app.use(express.urlencoded({ extended: true })); // Por si acaso algún frontend envía x-www-form-urlencoded

// Guardar curso y pasos en cursos.json y guardar imágenes
app.post('/api/curso', upload.array('imagenes'), (req, res) => {
    try {
        const { titulo, descripcion } = req.body;
        let pasos = [];
        if (req.body.pasos) {
            pasos = JSON.parse(req.body.pasos);
            // Actualiza la ruta de imagen para servir desde /uploads/
            pasos = pasos.map(p => ({
                ...p,
                imagen: p.imagen ? `/uploads/${p.imagen}` : null
            }));
        }

        // Leer cursos existentes
        let cursos = [];
        if (fs.existsSync(cursosJsonPath)) {
            const data = fs.readFileSync(cursosJsonPath, 'utf8');
            if (data) cursos = JSON.parse(data);
        }

        // Agregar nuevo curso
        cursos.push({ titulo, descripcion, pasos });

        // Guardar cursos en el archivo
        fs.writeFileSync(cursosJsonPath, JSON.stringify(cursos, null, 2));

        io.emit('nuevoCurso', { mensaje: 'Nuevo curso agregado' });
        res.json({ mensaje: 'Curso recibido' });
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar el curso' });
    }
});

// Endpoint para obtener los cursos guardados
app.get('/api/cursos', (req, res) => {
    try {
        if (fs.existsSync(cursosJsonPath)) {
            const data = fs.readFileSync(cursosJsonPath, 'utf8');
            res.json(JSON.parse(data));
        } else {
            res.json([]);
        }
    } catch (err) {
        res.status(500).json({ error: 'Error al leer los cursos' });
    }
});

// --- Endpoints de usuarios y progreso ---

// Registrar usuario
app.post('/api/registrar', (req, res) => {
    const { usuario, password } = req.body;
    if (!usuario || !password) return res.status(400).json({ error: 'Faltan datos' });
    let usuarios = {};
    try {
        if (fs.existsSync(usuariosJsonPath)) {
            const raw = fs.readFileSync(usuariosJsonPath, 'utf8');
            usuarios = raw ? JSON.parse(raw) : {};
        }
        if (usuarios[usuario]) return res.status(409).json({ error: 'Usuario ya existe' });
        usuarios[usuario] = { password, progreso: {} };
        fs.writeFileSync(usuariosJsonPath, JSON.stringify(usuarios, null, 2), 'utf8');
        res.json({ mensaje: 'Usuario registrado' });
    } catch (err) {
        res.status(500).json({ error: 'Error al registrar usuario' });
    }
});

// Login usuario
app.post('/api/login', (req, res) => {
    const { usuario, password } = req.body;
    if (!usuario || !password) return res.status(400).json({ error: 'Faltan datos' });
    let usuarios = {};
    try {
        if (fs.existsSync(usuariosJsonPath)) {
            const raw = fs.readFileSync(usuariosJsonPath, 'utf8');
            usuarios = raw ? JSON.parse(raw) : {};
        }
        if (!usuarios[usuario] || usuarios[usuario].password !== password) {
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }
        res.json({ mensaje: 'Login correcto' });
    } catch (err) {
        res.status(500).json({ error: 'Error al hacer login' });
    }
});

// Guardar progreso de usuario
app.post('/api/progreso', (req, res) => {
    const { usuario, cursoId, paso } = req.body;
    if (!usuario || cursoId == null || paso == null) return res.status(400).json({ error: 'Faltan datos' });
    let usuarios = {};
    if (fs.existsSync(usuariosJsonPath)) {
        usuarios = JSON.parse(fs.readFileSync(usuariosJsonPath, 'utf8'));
    }
    if (!usuarios[usuario]) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!usuarios[usuario].progreso) usuarios[usuario].progreso = {};
    usuarios[usuario].progreso[cursoId] = { paso };
    fs.writeFileSync(usuariosJsonPath, JSON.stringify(usuarios, null, 2));
    res.json({ mensaje: 'Progreso guardado' });
});

// Obtener progreso de usuario
app.get('/api/progreso/:usuario', (req, res) => {
    const usuario = req.params.usuario;
    let usuarios = {};
    if (fs.existsSync(usuariosJsonPath)) {
        usuarios = JSON.parse(fs.readFileSync(usuariosJsonPath, 'utf8'));
    }
    if (!usuarios[usuario]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(usuarios[usuario].progreso || {});
});

// Servir imágenes
app.use('/uploads', express.static(uploadsDir));

// Servir archivos estáticos del frontend de usuarios en /app (debe ir ANTES del frontend de administración)
app.use('/app', express.static(path.join(__dirname, '../frontend_usuario')));

// Servir archivos estáticos del frontend de administración
app.use(express.static(path.join(__dirname, '../frontend')));

// Socket.IO conexión
io.on('connection', (socket) => {
    console.log('Cliente conectado vía Socket.IO');
    // Puedes agregar más eventos aquí si lo necesitas
});

// --- Configuración de puerto y host para Render y móviles ---
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Escucha en todas las interfaces (necesario para Render y móviles)

server.listen(PORT, HOST, () => {
    console.log(`Servidor backend iniciado en puerto ${PORT}`);
});
