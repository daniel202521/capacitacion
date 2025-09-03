const cron = require('node-cron');
const twilio = require('twilio');

// Configura tus credenciales de Twilio
const accountSid = 'AC356512c99313e2f80c819947456a263b';
const authToken = 'bd3e79de7668a335ed21c7f4713315cf';
const twilioClient = twilio(accountSid, authToken);

// Número de WhatsApp de Twilio (debes tenerlo verificado)
const twilioWhatsappNumber = 'whatsapp:+15418718662'; // Tu número de Twilio para WhatsApp
const twilioCallNumber = '+15418718662'; // Tu número de Twilio para llamadas

// Función para obtener los números de la base de datos
async function obtenerNumerosUsuarios() {
    // Esta función será sobrescrita por el backend principal
    return [
        '521234567890', // Ejemplo de número internacional
        // ...más números
    ];
}

// Mensaje de recordatorio
const mensaje = 'Recuerda subir tu evidencia y crear tu ticket hoy. ¡No lo olvides!';

// Función para enviar WhatsApp
async function enviarWhatsapp(numero, texto) {
    try {
        await twilioClient.messages.create({
            from: twilioWhatsappNumber,
            to: `whatsapp:+${numero}`,
            body: texto
        });
        console.log(`WhatsApp enviado a ${numero}`);
    } catch (err) {
        console.error(`Error enviando WhatsApp a ${numero}:`, err.message);
    }
}

// Función para realizar llamada automática
async function realizarLlamada(numero) {
    try {
        await twilioClient.calls.create({
            from: twilioCallNumber,
            to: `+${numero}`,
            twiml: `<Response><Say>Recuerda subir tu evidencia y crear tu ticket hoy. No lo olvides.</Say></Response>`
        });
        console.log(`Llamada realizada a ${numero}`);
    } catch (err) {
        console.error(`Error realizando llamada a ${numero}:`, err.message);
    }
}

// Tarea programada: todos los días a las 6 am
cron.schedule('0 6 * * *', async () => {
    const numeros = await obtenerNumerosUsuarios();
    for (const numero of numeros) {
        await enviarWhatsapp(numero, mensaje);
        await realizarLlamada(numero);
    }
    console.log('Notificaciones enviadas a todos los usuarios.');
});

// --- NUEVO: función para programar recordatorios personalizados ---
async function programarRecordatoriosPersonalizados(db) {
    const recordatoriosCol = db.collection('recordatorios');
    const recordatorios = await recordatoriosCol.find({}).toArray();
    recordatorios.forEach(rec => {
        // Hora en formato HH:MM
        const [hh, mm] = rec.hora.split(':');
        const cronExp = `${parseInt(mm, 10)} ${parseInt(hh, 10)} * * *`;
        cron.schedule(cronExp, async () => {
            // Solo llamada, no WhatsApp
            await realizarLlamada(rec.numero);
            console.log(`Recordatorio personalizado (llamada) enviado a ${rec.numero} (${rec.hora})`);
        });
    });
}

// Exporta la función para que el backend la llame después de conectar a MongoDB
module.exports = {
    enviarWhatsapp,
    realizarLlamada,
    obtenerNumerosUsuarios,
    programarRecordatoriosPersonalizados // <-- exporta la función
};
