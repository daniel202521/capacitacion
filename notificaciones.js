const cron = require('node-cron');
const fetch = require('node-fetch'); // Asegúrate de tener node-fetch instalado

// SINCH credentials
const SINCH_APP_KEY = 'fb9aef67-d609-44bc-bf0f-0bcf505808b9';
const SINCH_APP_SECRET = 'rNp/eGx0iE2kyZYDUA/GyQ==';
const SINCH_CLI = '+447418629761'; // El número mostrado como caller

function base64Encode(str) {
    return Buffer.from(str).toString('base64');
}

// Función para realizar llamada TTS con Sinch
async function realizarLlamada(numero, mensaje = 'Recuerda subir tu evidencia y crear tu ticket hoy. No lo olvides.') {
    try {
        const auth = base64Encode(`${SINCH_APP_KEY}:${SINCH_APP_SECRET}`);
        const body = {
            method: "ttsCallout",
            ttsCallout: {
                cli: SINCH_CLI,
                domain: "pstn",
                destination: { type: "number", endpoint: `+${numero}` },
                locale: "es-ES",
                prompts: `#tts[${mensaje}]`
            }
        };
        const requestOptions = {
            method: 'POST',
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Basic ${auth}`
            },
            body: JSON.stringify(body)
        };
        const response = await fetch("https://calling.api.sinch.com/calling/v1/callouts", requestOptions);
        const result = await response.json();
        console.log(`[Sinch] Llamada realizada a ${numero}:`, result);
    } catch (err) {
        console.error(`[Sinch] Error realizando llamada a ${numero}:`, err);
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
        console.log(`[CRON] Programando llamada para ${rec.numero} a las ${rec.hora} (${cronExp})`);
        cron.schedule(cronExp, async () => {
            console.log(`[CRON] Ejecutando llamada programada para ${rec.numero} a las ${rec.hora} (${cronExp})`);
            try {
                await realizarLlamada(rec.numero, rec.mensaje);
                console.log(`[CRON] Llamada realizada a ${rec.numero} (${rec.hora})`);
            } catch (err) {
                console.error(`[CRON] Error al realizar llamada a ${rec.numero}:`, err);
            }
        });
    });
}

// Exporta la función para que el backend la llame después de conectar a MongoDB
module.exports = {
    realizarLlamada,
    programarRecordatoriosPersonalizados
};
                console.error(`[CRON] Error al realizar llamada a ${rec.numero}:`, err);
 
