require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const nodemailer  = require('nodemailer');
const mercadopago = require('mercadopago');
const AWS         = require('aws-sdk');
const twilio      = require('twilio');
const multer      = require('multer');
const { signPdfWithA1, getCertInfo } = require('./icp-brasil');
const {
  addTrustedTimestampToSignedPdf,
  validateSignedPdfForITI,
  gerarLogTecnico,
  TSA_CONFIG,
} = require('./icp-timestamp');

// ══════════════════════════════════════════════════════════════════════
//  CONFIGURAÇÃO
// ══════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://assinafacil.vercel.app';

// ── TWILIO SMS ───────────────────────────────────
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const TWILIO_NUMBER = process.env.TWILIO_PHONE;

// ── Z-API WHATSAPP ───────────────────────────────
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN    = process.env.ZAPI_TOKEN;
const ZAPI_BASE     = ZAPI_INSTANCE && ZAPI_TOKEN 
  ? 'https://api.z-api.io/instances/' + ZAPI_INSTANCE + '/token/' + ZAPI_TOKEN
  : null;

async function sendWhatsApp(phone, message) {
  if (!ZAPI_BASE) {
    console.log('[WhatsApp] Z-API não configurado - mensagem simulada para:', phone);
    return { simulated: true };
  }
  
  const https = require('https');
  const phoneClean = phone.replace(/\D/g,'');
  const phoneFormatted = phoneClean.startsWith('55') ? phoneClean : '55' + phoneClean;
  
  const body = JSON.stringify({ phone: phoneFormatted, message });
  
  return new Promise((resolve, reject) => {
    const url = new URL(ZAPI_BASE + '/send-text');
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Multer para uploads
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── AWS REKOGNITION ─────────────────────────────
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  AWS.config.update({
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region:          process.env.AWS_REGION || 'us-east-1',
  });
}
const rekognition = new AWS.Rekognition();
const s3          = new AWS.S3();
const S3_BUCKET   = process.env.S3_BUCKET || 'assinafacil-docs';

// ══════════════════════════════════════════════════════════════════════
//  EXPRESS APP
// ══════════════════════════════════════════════════════════════════════

const app = express();

// ── CORS CONFIGURADO PARA PRODUÇÃO ───────────────
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  FRONTEND_URL,
  'https://assinafacil.vercel.app',
  'https://assinafacil-production.vercel.app',
];

app.use(cors({
  origin: function(origin, callback) {
    // Permite requests sem origin (mobile apps, Postman, etc)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o.replace(/\/$/, '')))) {
      return callback(null, true);
    }
    console.warn('[CORS] Origem bloqueada:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '50mb' }));

// ── MERCADO PAGO ────────────────────────────────
let payment = null;
if (process.env.MP_ACCESS_TOKEN) {
  const client = new mercadopago.MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN,
  });
  payment = new mercadopago.Payment(client);
  console.log('  💳  Mercado Pago configurado');
}

// ── NODEMAILER (Gmail) ───────────────────────────
let transporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  
  // Teste de conexão ao iniciar
  transporter.verify((err) => {
    if (err) console.error('❌ Gmail erro:', err.message);
    else console.log('  📧  Gmail conectado:', process.env.GMAIL_USER);
  });
}

// ── PLANOS ──────────────────────────────────────
const PLANS = {
  Mensal:       { amount: 29.90, desc: 'AssinaFácil — Plano Mensal (ilimitado)' },
  Anual:        { amount: 99.90, desc: 'AssinaFácil — Plano Anual (ilimitado)'  },
  Essencial:    { amount: 29.90, desc: 'AssinaFácil — Plano Essencial'  },
  Profissional: { amount: 49.90, desc: 'AssinaFácil — Plano Profissional'  },
  Empresarial:  { amount: 69.90, desc: 'AssinaFácil — Plano Empresarial'  },
  Gratuito:     { amount: 0,     desc: 'AssinaFácil — Plano Gratuito'           },
};

// ══════════════════════════════════════════════════════════════════════
//  ROTAS - HEALTH CHECK
// ══════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'AssinaFácil API',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    services: {
      email: !!transporter,
      payment: !!payment,
      whatsapp: !!ZAPI_BASE,
      sms: !!twilioClient,
      aws: !!process.env.AWS_ACCESS_KEY_ID,
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
//  ROTAS - EMAIL
// ══════════════════════════════════════════════════════════════════════

// ── EMAIL: CONVITE PARA ASSINAR ─────────────────
app.post('/email/convite', async (req, res) => {
  if (!transporter) return res.status(503).json({ error: 'Serviço de email não configurado' });
  
  const { signerName, signerEmail, senderName, docName, signLink } = req.body;
  if (!signerEmail || !docName || !signLink)
    return res.status(400).json({ error: 'Dados incompletos' });

  const html = `
  <!DOCTYPE html>
  <html lang="pt-BR">
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <div style="background:linear-gradient(135deg,#0e1628,#1e2d4a);padding:32px;text-align:center">
        <div style="font-size:1.6rem;font-weight:900;color:#fff">Assina<span style="color:#c9a84c">Fácil</span></div>
        <div style="color:rgba(255,255,255,.6);font-size:.85rem;margin-top:.3rem">Plataforma de Assinatura Digital</div>
      </div>
      <div style="padding:36px 32px">
        <p style="font-size:1.05rem;font-weight:700;color:#1a1a2e;margin:0 0 8px">Olá, ${signerName || 'você'}!</p>
        <p style="color:#555;line-height:1.6;margin:0 0 24px">
          <strong>${senderName || 'Alguém'}</strong> enviou um documento para você assinar digitalmente:
        </p>
        <div style="background:#f8f7f4;border:1.5px solid #e8d5a3;border-radius:10px;padding:18px 20px;margin-bottom:28px;display:flex;align-items:center;gap:14px">
          <div style="font-size:2rem">📄</div>
          <div>
            <div style="font-weight:700;color:#1a1a2e;font-size:.95rem">${docName}</div>
            <div style="font-size:.78rem;color:#888;margin-top:3px">Aguardando sua assinatura</div>
          </div>
        </div>
        <div style="text-align:center;margin-bottom:28px">
          <a href="${signLink}" style="display:inline-block;background:linear-gradient(135deg,#c9a84c,#a87830);color:#0a0a12;font-weight:900;font-size:1rem;padding:14px 36px;border-radius:10px;text-decoration:none">
            Assinar Documento
          </a>
        </div>
        <p style="font-size:.8rem;color:#999;text-align:center;margin:0 0 4px">Ou copie e cole no navegador:</p>
        <p style="font-size:.75rem;color:#c9a84c;text-align:center;word-break:break-all;margin:0 0 24px">${signLink}</p>
        <div style="background:#f0f7ff;border-radius:8px;padding:14px 16px;font-size:.8rem;color:#555;line-height:1.6">
          <strong>Segurança:</strong> Esta assinatura tem validade jurídica nos termos da MP 2.200-2/2001.<br>
          <strong>Prazo:</strong> Por favor assine em até 7 dias.
        </div>
      </div>
      <div style="background:#f8f8f8;padding:20px 32px;text-align:center;border-top:1px solid #eee">
        <p style="font-size:.75rem;color:#aaa;margin:0">
          Enviado por <strong>AssinaFácil</strong> · ${process.env.GMAIL_USER || 'assinafacilweb@gmail.com'}<br>
          Se você não esperava este e-mail, pode ignorá-lo.
        </p>
      </div>
    </div>
  </body>
  </html>`;

  try {
    await transporter.sendMail({
      from: `"AssinaFácil" <${process.env.GMAIL_USER}>`,
      to: signerEmail,
      subject: `${senderName || 'Alguém'} enviou um documento para você assinar`,
      html,
    });
    console.log(`[Email] Convite enviado → ${signerEmail}`);
    res.json({ success: true });
  } catch(e) {
    console.error('Email convite erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── EMAIL: CONFIRMAÇÃO DE ASSINATURA ────────────
app.post('/email/confirmacao', async (req, res) => {
  if (!transporter) return res.status(503).json({ error: 'Serviço de email não configurado' });
  
  const { ownerEmail, ownerName, signerName, docName, signedAt, hash } = req.body;
  if (!ownerEmail) return res.status(400).json({ error: 'Dados incompletos' });

  const html = `
  <!DOCTYPE html>
  <html lang="pt-BR">
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <div style="background:linear-gradient(135deg,#0e1628,#1e2d4a);padding:32px;text-align:center">
        <div style="font-size:1.6rem;font-weight:900;color:#fff">Assina<span style="color:#c9a84c">Fácil</span></div>
      </div>
      <div style="padding:36px 32px">
        <div style="text-align:center;margin-bottom:24px">
          <div style="width:64px;height:64px;background:#f0fdf4;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:2rem">✅</div>
        </div>
        <p style="font-size:1.05rem;font-weight:700;color:#1a1a2e;text-align:center;margin:0 0 8px">Documento Assinado!</p>
        <p style="color:#555;line-height:1.6;text-align:center;margin:0 0 24px">
          <strong>${signerName || 'Um signatário'}</strong> acabou de assinar <strong>${docName}</strong>
        </p>
        <div style="background:#f8f7f4;border:1.5px solid #e8d5a3;border-radius:10px;padding:18px 20px;margin-bottom:24px">
          <div style="font-size:.8rem;color:#888;margin-bottom:4px">Documento</div>
          <div style="font-weight:700;color:#1a1a2e">${docName}</div>
          <div style="font-size:.8rem;color:#888;margin-top:10px;margin-bottom:4px">Assinado em</div>
          <div style="font-weight:600;color:#1a1a2e">${signedAt || new Date().toLocaleString('pt-BR')}</div>
          <div style="font-size:.8rem;color:#888;margin-top:10px;margin-bottom:4px">Hash SHA-256</div>
          <div style="font-family:monospace;font-size:.72rem;color:#c9a84c;word-break:break-all">${hash || '—'}</div>
        </div>
        <div style="background:#f0fdf4;border-radius:8px;padding:14px 16px;font-size:.8rem;color:#555">
          Esta assinatura possui validade jurídica nos termos da MP 2.200-2/2001.
        </div>
      </div>
      <div style="background:#f8f8f8;padding:20px 32px;text-align:center;border-top:1px solid #eee">
        <p style="font-size:.75rem;color:#aaa;margin:0">AssinaFácil · ${process.env.GMAIL_USER || 'assinafacilweb@gmail.com'}</p>
      </div>
    </div>
  </body>
  </html>`;

  try {
    await transporter.sendMail({
      from: `"AssinaFácil" <${process.env.GMAIL_USER}>`,
      to: ownerEmail,
      subject: `✅ ${signerName} assinou "${docName}"`,
      html,
    });
    console.log(`[Email] Confirmação enviada → ${ownerEmail}`);
    res.json({ success: true });
  } catch(e) {
    console.error('Email confirmação erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── EMAIL: LEMBRETE ─────────────────────────────
app.post('/email/lembrete', async (req, res) => {
  if (!transporter) return res.status(503).json({ error: 'Serviço de email não configurado' });
  
  const { signerEmail, signerName, docName, signLink } = req.body;
  if (!signerEmail) return res.status(400).json({ error: 'Dados incompletos' });

  try {
    await transporter.sendMail({
      from: `"AssinaFácil" <${process.env.GMAIL_USER}>`,
      to: signerEmail,
      subject: `Lembrete: "${docName}" aguarda sua assinatura`,
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px">
        <h2>Lembrete de Assinatura</h2>
        <p>Olá <strong>${signerName}</strong>,</p>
        <p>O documento <strong>${docName}</strong> ainda aguarda sua assinatura.</p>
        <a href="${signLink}" style="display:inline-block;background:#c9a84c;color:#0a0a12;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;margin:16px 0">Assinar agora</a>
        <p style="color:#999;font-size:.8rem">AssinaFácil · ${process.env.GMAIL_USER || 'assinafacilweb@gmail.com'}</p>
      </div>`,
    });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── EMAIL: OTP PARA SIGNATÁRIO ──────────────────
app.post('/email/otp', async (req, res) => {
  if (!transporter) return res.status(503).json({ error: 'Serviço de email não configurado' });
  
  const { email, code, name } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Dados incompletos' });

  const html = `
  <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#0e1628,#1e2d4a);padding:28px;text-align:center">
      <div style="font-size:1.5rem;font-weight:900;color:#fff">Assina<span style="color:#c9a84c">Fácil</span></div>
    </div>
    <div style="padding:32px;text-align:center">
      <div style="font-size:2.5rem;margin-bottom:1rem">🔐</div>
      <h2 style="color:#1a1a2e;margin:0 0 8px">Código de verificação</h2>
      <p style="color:#555;margin:0 0 24px">Olá ${name || 'você'}! Use o código abaixo para verificar sua identidade e assinar o documento.</p>
      <div style="background:#f8f7f4;border:2px solid #c9a84c;border-radius:12px;padding:20px;margin-bottom:24px">
        <div style="font-size:2.8rem;font-weight:900;letter-spacing:10px;color:#0e1628;font-family:monospace">${code}</div>
        <div style="font-size:.78rem;color:#888;margin-top:8px">Válido por 10 minutos</div>
      </div>
      <p style="font-size:.78rem;color:#aaa">Se você não solicitou este código, ignore este e-mail.</p>
    </div>
    <div style="background:#f8f8f8;padding:16px;text-align:center;border-top:1px solid #eee">
      <p style="font-size:.73rem;color:#aaa;margin:0">AssinaFácil · ${process.env.GMAIL_USER || 'assinafacilweb@gmail.com'}</p>
    </div>
  </div>`;

  try {
    await transporter.sendMail({
      from: `"AssinaFácil" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: `${code} — Seu código de verificação AssinaFácil`,
      html,
    });
    console.log(`[OTP] Código ${code} enviado → ${email}`);
    res.json({ success: true });
  } catch(e) {
    console.error('OTP erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  ROTAS - PAGAMENTO
// ══════════════════════════════════════════════════════════════════════

// ── PUBLIC KEY ──────────────────────────────────
app.get('/public-key', (req, res) => {
  res.json({ publicKey: process.env.MP_PUBLIC_KEY || '' });
});

// ── PAGAMENTO: CARTÃO ───────────────────────────
app.post('/pagar/cartao', async (req, res) => {
  if (!payment) return res.status(503).json({ error: 'Serviço de pagamento não configurado' });
  
  const { token, planName, installments, paymentMethodId, payerEmail, payerCpf } = req.body;
  if (!token || !planName || !payerEmail)
    return res.status(400).json({ error: 'Dados incompletos' });
  
  const plan = PLANS[planName];
  if (!plan || plan.amount === 0) return res.status(400).json({ error: 'Plano inválido' });
  
  try {
    const result = await payment.create({ body: {
      transaction_amount: plan.amount,
      token,
      description: plan.desc,
      installments: Number(installments) || 1,
      payment_method_id: paymentMethodId || 'visa',
      payer: { email: payerEmail, identification: { type:'CPF', number:(payerCpf||'').replace(/\D/g,'') } },
    }});
    if (result.status === 'approved') res.json({ success:true, status:'approved', id:result.id, amount:plan.amount });
    else res.json({ success:false, status:result.status, detail:result.status_detail });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PAGAMENTO: PIX ──────────────────────────────
app.post('/pagar/pix', async (req, res) => {
  if (!payment) return res.status(503).json({ error: 'Serviço de pagamento não configurado' });
  
  const { planName, payerEmail, payerCpf, payerName } = req.body;
  const plan = PLANS[planName];
  if (!plan || plan.amount === 0) return res.status(400).json({ error: 'Plano inválido' });
  const amount = parseFloat((plan.amount * 0.95).toFixed(2));
  try {
    const result = await payment.create({ body: {
      transaction_amount: amount,
      description: plan.desc + ' (PIX -5%)',
      payment_method_id: 'pix',
      date_of_expiration: new Date(Date.now() + 30*60*1000).toISOString(),
      payer: {
        email: payerEmail,
        first_name: (payerName||'Cliente').split(' ')[0],
        last_name:  (payerName||'').split(' ').slice(1).join(' ') || 'AssinaFacil',
        identification: { type:'CPF', number:(payerCpf||'00000000000').replace(/\D/g,'') }
      },
    }});
    const qr = result.point_of_interaction?.transaction_data;
    res.json({ success:true, paymentId:result.id, qrCode:qr?.qr_code, qrCodeBase64:qr?.qr_code_base64, amount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PAGAMENTO: BOLETO ───────────────────────────
app.post('/pagar/boleto', async (req, res) => {
  if (!payment) return res.status(503).json({ error: 'Serviço de pagamento não configurado' });
  
  const { planName, payerEmail, payerCpf, payerName } = req.body;
  const plan = PLANS[planName];
  if (!plan || plan.amount === 0) return res.status(400).json({ error: 'Plano inválido' });
  try {
    const result = await payment.create({ body: {
      transaction_amount: plan.amount,
      description: plan.desc,
      payment_method_id: 'bolbradesco',
      payer: {
        email: payerEmail,
        first_name: (payerName||'Cliente').split(' ')[0],
        last_name:  (payerName||'').split(' ').slice(1).join(' ') || 'AssinaFacil',
        identification: { type:'CPF', number:(payerCpf||'').replace(/\D/g,'') },
        address: { zip_code:'01310100', street_name:'Av. Paulista', street_number:'1000', neighborhood:'Bela Vista', city:'São Paulo', federal_unit:'SP' }
      },
    }});
    res.json({ success:true, paymentId:result.id, boletoUrl:result.transaction_details?.external_resource_url, barcode:result.barcode?.content, amount:plan.amount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── VERIFICAR PAGAMENTO ─────────────────────────
app.get('/pagamento/:id', async (req, res) => {
  if (!payment) return res.status(503).json({ error: 'Serviço de pagamento não configurado' });
  
  try {
    const r = await payment.get({ id: req.params.id });
    res.json({ status:r.status, detail:r.status_detail, amount:r.transaction_amount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
//  ROTAS - AUTENTICAÇÃO E VERIFICAÇÃO
// ══════════════════════════════════════════════════════════════════════

// ── REKOGNITION: VERIFICAR SELFIE (rosto real) ──
app.post('/auth/selfie', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Imagem não enviada' });
  
  if (!process.env.AWS_ACCESS_KEY_ID) {
    // Modo simulado se AWS não configurado
    return res.json({ success: true, confidence: 95, eyesOpen: true, faceCount: 1, simulated: true });
  }
  
  try {
    const detect = await rekognition.detectFaces({
      Image: { Bytes: req.file.buffer },
      Attributes: ['ALL'],
    }).promise();

    if (detect.FaceDetails.length === 0)
      return res.json({ success: false, error: 'Nenhum rosto detectado' });

    const face = detect.FaceDetails[0];
    const isReal = face.Confidence > 90;
    const eyesOpen = face.EyesOpen?.Value && face.EyesOpen.Confidence > 80;

    if (!isReal)
      return res.json({ success: false, error: 'Rosto não detectado com clareza' });

    res.json({
      success:    true,
      confidence: Math.round(face.Confidence),
      eyesOpen,
      faceCount:  detect.FaceDetails.length,
    });
  } catch(e) {
    console.error('Selfie rekognition:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── REKOGNITION: COMPARAR SELFIE COM DOCUMENTO ──
app.post('/auth/comparar', upload.fields([
  { name: 'selfie', maxCount: 1 },
  { name: 'documento', maxCount: 1 }
]), async (req, res) => {
  if (!req.files?.selfie || !req.files?.documento)
    return res.status(400).json({ error: 'Envie selfie e documento' });
    
  if (!process.env.AWS_ACCESS_KEY_ID) {
    return res.json({ success: true, similarity: 85, message: 'Identidade verificada (modo simulado)', simulated: true });
  }
  
  try {
    const result = await rekognition.compareFaces({
      SourceImage: { Bytes: req.files.selfie[0].buffer },
      TargetImage: { Bytes: req.files.documento[0].buffer },
      SimilarityThreshold: 70,
    }).promise();

    if (result.FaceMatches.length === 0)
      return res.json({ success: false, error: 'Rosto não corresponde ao documento', similarity: 0 });

    const similarity = Math.round(result.FaceMatches[0].Similarity);
    res.json({
      success:    similarity >= 80,
      similarity,
      message:    similarity >= 80
        ? 'Identidade verificada com ' + similarity + '% de correspondência'
        : 'Baixa correspondência (' + similarity + '%)',
    });
  } catch(e) {
    console.error('Comparar rekognition:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CPF SIMPLES — Validação por algoritmo ──────
app.post('/auth/cpf', async (req, res) => {
  const { cpf } = req.body;
  if (!cpf) return res.status(400).json({ error: 'CPF não informado' });

  const cpfClean = cpf.replace(/\D/g, '');
  if (cpfClean.length !== 11)
    return res.status(400).json({ error: 'CPF inválido' });

  // Validar dígitos verificadores
  function validCPF(c) {
    if (/^(\d)\1{10}$/.test(c)) return false;
    let s=0; for(let i=0;i<9;i++) s+=parseInt(c[i])*(10-i);
    let r=(s*10)%11; if(r>=10) r=0; if(r!==parseInt(c[9])) return false;
    s=0; for(let i=0;i<10;i++) s+=parseInt(c[i])*(11-i);
    r=(s*10)%11; if(r>=10) r=0; return r===parseInt(c[10]);
  }

  if (!validCPF(cpfClean))
    return res.json({ success: false, error: 'CPF inválido — dígitos verificadores incorretos' });

  const cpfFormatted = cpfClean.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

  res.json({
    success: true,
    cpf: cpfFormatted,
    valid: true,
    message: 'CPF válido (validação por algoritmo)',
  });
});

// ══════════════════════════════════════════════════════════════════════
//  ROTAS - WHATSAPP
// ══════════════════════════════════════════════════════════════════════

// ── WHATSAPP: ENVIAR OTP ─────────────────────────
app.post('/whatsapp/otp', async (req, res) => {
  const { phone, code, name } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Dados incompletos' });

  const msg = `*AssinaFácil*

Olá ${name || ''}! Seu código de verificação é:

*${code}*

Válido por 10 minutos.
Não compartilhe este código.`;

  try {
    const result = await sendWhatsApp(phone, msg);
    console.log('[WhatsApp OTP] Enviado →', phone, result);
    res.json({ success: true, result });
  } catch(e) {
    console.error('WhatsApp OTP erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── WHATSAPP: CONVITE PARA ASSINAR ───────────────
app.post('/whatsapp/convite', async (req, res) => {
  const { phone, signerName, senderName, docName, signLink } = req.body;
  if (!phone) return res.status(400).json({ error: 'Celular não informado' });

  const msg = `*AssinaFácil*

Olá *${signerName || 'você'}*!

*${senderName || 'Alguém'}* enviou um documento para você assinar:

📄 *${docName}*

Clique no link abaixo para assinar:
${signLink}

_Assinatura com validade jurídica — MP 2.200-2/2001_`;

  try {
    const result = await sendWhatsApp(phone, msg);
    console.log('[WhatsApp Convite] Enviado →', phone);
    res.json({ success: true, result });
  } catch(e) {
    console.error('WhatsApp convite erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── WHATSAPP: CONFIRMAÇÃO DE ASSINATURA ──────────
app.post('/whatsapp/confirmacao', async (req, res) => {
  const { phone, ownerName, signerName, docName, hash } = req.body;
  if (!phone) return res.status(400).json({ error: 'Celular não informado' });

  const msg = `*AssinaFácil* ✅

Olá *${ownerName || ''}*!

*${signerName}* acabou de assinar o documento:

📄 *${docName}*

🔐 Hash: \`${(hash||'').slice(0,16)}...\`
✅ Assinatura com validade jurídica

Acesse seu painel para baixar o documento assinado.`;

  try {
    const result = await sendWhatsApp(phone, msg);
    res.json({ success: true, result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  ROTAS - SMS
// ══════════════════════════════════════════════════════════════════════

// ── SMS: ENVIAR OTP ──────────────────────────────
app.post('/sms/otp', async (req, res) => {
  const { phone, code, name } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Dados incompletos' });

  // Format phone — add +55 if Brazilian
  let phoneFormatted = phone.replace(/\D/g, '');
  if (phoneFormatted.length === 11) phoneFormatted = '+55' + phoneFormatted;
  else if (phoneFormatted.length === 10) phoneFormatted = '+55' + phoneFormatted;
  else if (!phoneFormatted.startsWith('+')) phoneFormatted = '+' + phoneFormatted;

  if (!twilioClient) {
    console.log('[SMS] Twilio não configurado - simulando envio para:', phoneFormatted);
    return res.json({ success: true, to: phoneFormatted, simulated: true });
  }

  try {
    await twilioClient.messages.create({
      body: `AssinaFácil: Seu código de verificação é *${code}*. Válido por 10 minutos. Não compartilhe.`,
      from: TWILIO_NUMBER,
      to: phoneFormatted,
    });
    console.log('[SMS] Código ' + code + ' enviado → ' + phoneFormatted);
    res.json({ success: true, to: phoneFormatted });
  } catch(e) {
    console.error('SMS erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  ROTAS - ICP-BRASIL (Assinatura Digital)
// ══════════════════════════════════════════════════════════════════════

// ── GET cert info ──
app.post('/icp/cert-info', async (req, res) => {
  const { pfxBase64, password } = req.body;
  if (!pfxBase64 || !password)
    return res.status(400).json({ error: 'pfxBase64 e password obrigatórios' });

  try {
    const pfxBuffer = Buffer.from(pfxBase64, 'base64');
    const certInfo  = getCertInfo(pfxBuffer, password);
    pfxBuffer.fill(0);
    res.json({ success: true, certInfo });
  } catch (e) {
    console.error('[ICP cert-info]', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ── ASSINAR PDF com A1 ──
app.post('/icp/assinar', async (req, res) => {
  const { pdfBase64, pfxBase64, password, docName } = req.body;

  if (!pdfBase64 || !pfxBase64 || !password)
    return res.status(400).json({ error: 'pdfBase64, pfxBase64 e password obrigatórios' });

  try {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const pfxBuffer = Buffer.from(pfxBase64, 'base64');

    console.log(`[ICP] Assinando: ${docName || 'documento.pdf'} (${Math.round(pdfBuffer.length/1024)}KB)`);

    const result = await signPdfWithA1(pdfBuffer, pfxBuffer, password);
    pfxBuffer.fill(0);

    const signedBase64 = result.pdfBuffer.toString('base64');

    console.log(`[ICP] ✅ Assinado com sucesso. Hash: ${result.hash.slice(0,16)}...`);

    res.json({
      success:          true,
      signedPdfBase64:  signedBase64,
      hash:             result.hash,
      certInfo:         result.certInfo,
      signedAt:         result.signedAt,
      size:             result.pdfBuffer.length,
    });
  } catch (e) {
    console.error('[ICP assinar]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── ASSINAR + TIMESTAMP em uma única chamada ─────────
app.post('/assinar/icp/completo', upload.fields([
  { name: 'pdf', maxCount: 1 },
  { name: 'pfx', maxCount: 1 },
]), async (req, res) => {
  if (!req.files?.pdf || !req.files?.pfx)
    return res.status(400).json({ error: 'Envie o PDF e o certificado .pfx' });

  const { password, addTimestamp = 'true' } = req.body;
  if (!password) return res.status(400).json({ error: 'Senha obrigatória' });

  const pdfBuffer = req.files.pdf[0].buffer;
  const pfxBuffer = req.files.pfx[0].buffer;

  console.log('[ICP Completo] Iniciando fluxo completo...');

  try {
    const info = getCertInfo(pfxBuffer, password);
    if (!info) throw new Error('Certificado inválido ou senha incorreta');
    if (info.expirado) throw new Error('Certificado expirado em ' + info.validade);

    console.log('[ICP Completo] Etapa 1/3: Assinando PDF...');
    let signedPdf = await signPdfWithA1(pdfBuffer, pfxBuffer, password);

    let tsInfo = null;
    if (addTimestamp === 'true' || addTimestamp === true) {
      console.log('[ICP Completo] Etapa 2/3: Adicionando carimbo do tempo...');
      try {
        const tsResult = await addTrustedTimestampToSignedPdf(signedPdf.pdfBuffer);
        signedPdf.pdfBuffer = tsResult.pdf;
        tsInfo = tsResult.tsInfo;
        console.log('[ICP Completo] ✅ Timestamp adicionado:', tsInfo.genTime);
      } catch(e) {
        console.warn('[ICP Completo] ⚠️ Timestamp falhou (continuando sem):', e.message);
      }
    }

    console.log('[ICP Completo] Etapa 3/3: Validando conformidade ITI...');
    const validationReport = validateSignedPdfForITI(signedPdf.pdfBuffer);

    res.set({
      'Content-Type':         'application/pdf',
      'Content-Disposition':  'attachment; filename="documento-assinado-icp-brasil.pdf"',
      'Content-Length':       signedPdf.pdfBuffer.length,
      'X-Signer-Name':        info.nome || '',
      'X-Signer-CPF':         info.cpf  || '',
      'X-Cert-Valid-Until':   info.validade || '',
      'X-Timestamp-Present':  tsInfo ? 'true' : 'false',
      'X-Timestamp-Time':     tsInfo?.genTime || '',
      'X-Validation-Passed':  String(validationReport.passed),
      'X-Validation-Risk':    validationReport.riscoRejeicaoITI,
    });
    res.send(signedPdf.pdfBuffer);

  } catch(e) {
    console.error('[ICP Completo] ❌', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── VALIDAR CONFORMIDADE ITI ─────────────────────────
app.post('/assinar/icp/validar', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDF não enviado' });

  console.log('[Validar ITI] Analisando PDF:', req.file.size, 'bytes');

  try {
    const report = validateSignedPdfForITI(req.file.buffer);
    const logText = gerarLogTecnico(report);

    console.log('[Validar ITI] Resultado:', report.passed ? '✅ APROVADO' : '❌ REPROVADO');
    console.log('[Validar ITI] Risco:', report.riscoRejeicaoITI);

    res.json({
      success:     true,
      passed:      report.passed,
      risco:       report.riscoRejeicaoITI,
      relatorio:   report,
      logTecnico:  logText,
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  ROTAS - WEBHOOK
// ══════════════════════════════════════════════════════════════════════

app.post('/webhook', async (req, res) => {
  const { type, data } = req.body;
  if (type === 'payment' && data?.id && payment) {
    try {
      const r = await payment.get({ id: data.id });
      console.log(`[Webhook] ${r.id} → ${r.status} R$${r.transaction_amount}`);
    } catch(e) { console.error('Webhook:', e.message); }
  }
  res.sendStatus(200);
});

// ══════════════════════════════════════════════════════════════════════
//  INICIAR SERVIDOR
// ══════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log('');
  console.log('  ═══════════════════════════════════════════════════');
  console.log('  ✅  Servidor AssinaFácil iniciado!');
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log('  ═══════════════════════════════════════════════════');
  console.log('');
  console.log('  Serviços ativos:');
  console.log('    📧 Email:', transporter ? 'Configurado' : 'Não configurado');
  console.log('    💳 Pagamento:', payment ? 'Configurado' : 'Não configurado');
  console.log('    💬 WhatsApp:', ZAPI_BASE ? 'Configurado' : 'Não configurado');
  console.log('    📱 SMS:', twilioClient ? 'Configurado' : 'Não configurado');
  console.log('    ☁️  AWS:', process.env.AWS_ACCESS_KEY_ID ? 'Configurado' : 'Não configurado');
  console.log('');
});
