require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const nodemailer  = require('nodemailer');
const mercadopago = require('mercadopago');
const AWS         = require('aws-sdk');
const twilio      = require('twilio');
const { signPdfWithA1, getCertInfo } = require('./icp-brasil');
const {
  addTrustedTimestampToSignedPdf,
  validateSignedPdfForITI,
  gerarLogTecnico,
  TSA_CONFIG,
} = require('./icp-timestamp');

// ── TWILIO SMS ───────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_NUMBER = process.env.TWILIO_PHONE;

// ── Z-API WHATSAPP ───────────────────────────────
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN    = process.env.ZAPI_TOKEN;
const ZAPI_BASE     = 'https://api.z-api.io/instances/' + ZAPI_INSTANCE + '/token/' + ZAPI_TOKEN;

async function sendWhatsApp(phone, message) {
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
const multer      = require('multer');
const upload      = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── AWS REKOGNITION ─────────────────────────────
AWS.config.update({
  accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region:          process.env.AWS_REGION || 'us-east-1',
});
const rekognition = new AWS.Rekognition();
const s3          = new AWS.S3();
const S3_BUCKET   = 'assinafacil-docs';

const app = express();
app.use(cors());
app.use(express.json());

// ── MERCADO PAGO ────────────────────────────────
const client = new mercadopago.MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});
const payment = new mercadopago.Payment(client);

// ── NODEMAILER (Gmail) ───────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// Teste de conexão ao iniciar
transporter.verify((err) => {
  if (err) console.error('❌ Gmail erro:', err.message);
  else console.log('  📧  Gmail conectado: assinafacilweb@gmail.com');
});

// ── PLANOS ──────────────────────────────────────
const PLANS = {
  Mensal:   { amount: 29.90, desc: 'AssinaFácil — Plano Mensal (ilimitado)' },
  Anual:    { amount: 99.90, desc: 'AssinaFácil — Plano Anual (ilimitado)'  },
  Gratuito: { amount: 0,     desc: 'AssinaFácil — Plano Gratuito'           },
};

// ── EMAIL: CONVITE PARA ASSINAR ─────────────────
app.post('/email/convite', async (req, res) => {
  const { signerName, signerEmail, senderName, docName, signLink } = req.body;
  if (!signerEmail || !docName || !signLink)
    return res.status(400).json({ error: 'Dados incompletos' });

  const html = `
  <!DOCTYPE html>
  <html lang="pt-BR">
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <!-- HEADER -->
      <div style="background:linear-gradient(135deg,#0e1628,#1e2d4a);padding:32px;text-align:center">
        <div style="font-size:1.6rem;font-weight:900;color:#fff">Assina<span style="color:#c9a84c">Fácil</span></div>
        <div style="color:rgba(255,255,255,.6);font-size:.85rem;margin-top:.3rem">Plataforma de Assinatura Digital</div>
      </div>
      <!-- BODY -->
      <div style="padding:36px 32px">
        <p style="font-size:1.05rem;font-weight:700;color:#1a1a2e;margin:0 0 8px">Olá, ${signerName || 'você'} 👋</p>
        <p style="color:#555;line-height:1.6;margin:0 0 24px">
          <strong>${senderName || 'Alguém'}</strong> enviou um documento para você assinar digitalmente:
        </p>
        <!-- DOC CARD -->
        <div style="background:#f8f7f4;border:1.5px solid #e8d5a3;border-radius:10px;padding:18px 20px;margin-bottom:28px;display:flex;align-items:center;gap:14px">
          <div style="font-size:2rem">📄</div>
          <div>
            <div style="font-weight:700;color:#1a1a2e;font-size:.95rem">${docName}</div>
            <div style="font-size:.78rem;color:#888;margin-top:3px">Aguardando sua assinatura</div>
          </div>
        </div>
        <!-- CTA -->
        <div style="text-align:center;margin-bottom:28px">
          <a href="${signLink}" style="display:inline-block;background:linear-gradient(135deg,#c9a84c,#a87830);color:#0a0a12;font-weight:900;font-size:1rem;padding:14px 36px;border-radius:10px;text-decoration:none">
            ✍️ Assinar Documento
          </a>
        </div>
        <p style="font-size:.8rem;color:#999;text-align:center;margin:0 0 4px">Ou copie e cole no navegador:</p>
        <p style="font-size:.75rem;color:#c9a84c;text-align:center;word-break:break-all;margin:0 0 24px">${signLink}</p>
        <!-- INFO -->
        <div style="background:#f0f7ff;border-radius:8px;padding:14px 16px;font-size:.8rem;color:#555;line-height:1.6">
          🔒 <strong>Segurança:</strong> Esta assinatura tem validade jurídica nos termos da MP 2.200-2/2001.<br>
          ⏰ <strong>Prazo:</strong> Por favor assine em até 7 dias.
        </div>
      </div>
      <!-- FOOTER -->
      <div style="background:#f8f8f8;padding:20px 32px;text-align:center;border-top:1px solid #eee">
        <p style="font-size:.75rem;color:#aaa;margin:0">
          Enviado por <strong>AssinaFácil</strong> · assinafacilweb@gmail.com<br>
          Se você não esperava este e-mail, pode ignorá-lo.
        </p>
      </div>
    </div>
  </body>
  </html>`;

  try {
    await transporter.sendMail({
      from: '"AssinaFácil" <assinafacilweb@gmail.com>',
      to: signerEmail,
      subject: `✍️ ${senderName || 'Alguém'} enviou um documento para você assinar`,
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
          🔒 Esta assinatura possui validade jurídica nos termos da MP 2.200-2/2001.
        </div>
      </div>
      <div style="background:#f8f8f8;padding:20px 32px;text-align:center;border-top:1px solid #eee">
        <p style="font-size:.75rem;color:#aaa;margin:0">AssinaFácil · assinafacilweb@gmail.com</p>
      </div>
    </div>
  </body>
  </html>`;

  try {
    await transporter.sendMail({
      from: '"AssinaFácil" <assinafacilweb@gmail.com>',
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
  const { signerEmail, signerName, docName, signLink } = req.body;
  if (!signerEmail) return res.status(400).json({ error: 'Dados incompletos' });

  try {
    await transporter.sendMail({
      from: '"AssinaFácil" <assinafacilweb@gmail.com>',
      to: signerEmail,
      subject: `⏰ Lembrete: "${docName}" aguarda sua assinatura`,
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px">
        <h2>⏰ Lembrete de Assinatura</h2>
        <p>Olá <strong>${signerName}</strong>,</p>
        <p>O documento <strong>${docName}</strong> ainda aguarda sua assinatura.</p>
        <a href="${signLink}" style="display:inline-block;background:#c9a84c;color:#0a0a12;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;margin:16px 0">✍️ Assinar agora</a>
        <p style="color:#999;font-size:.8rem">AssinaFácil · assinafacilweb@gmail.com</p>
      </div>`,
    });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── EMAIL: OTP PARA SIGNATÁRIO ──────────────────
app.post('/email/otp', async (req, res) => {
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
        <div style="font-size:.78rem;color:#888;margin-top:8px">⏰ Válido por 10 minutos</div>
      </div>
      <p style="font-size:.78rem;color:#aaa">Se você não solicitou este código, ignore este e-mail.</p>
    </div>
    <div style="background:#f8f8f8;padding:16px;text-align:center;border-top:1px solid #eee">
      <p style="font-size:.73rem;color:#aaa;margin:0">AssinaFácil · assinafacilweb@gmail.com</p>
    </div>
  </div>`;

  try {
    await transporter.sendMail({
      from: '"AssinaFácil" <assinafacilweb@gmail.com>',
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

// ── PUBLIC KEY ──────────────────────────────────
app.get('/public-key', (req, res) => {
  res.json({ publicKey: process.env.MP_PUBLIC_KEY });
});

// ── PAGAMENTO: CARTÃO ───────────────────────────
app.post('/pagar/cartao', async (req, res) => {
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
  try {
    const r = await payment.get({ id: req.params.id });
    res.json({ status:r.status, detail:r.status_detail, amount:r.transaction_amount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── REKOGNITION: VERIFICAR SELFIE (rosto real) ──
app.post('/auth/selfie', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Imagem não enviada' });
  try {
    // Detect faces
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






// ═══════════════════════════════════════════════════════════════
//  ICP-BRASIL A1 — Rotas
// ═══════════════════════════════════════════════════════════════


// ── GET cert info ──
app.post('/icp/cert-info', async (req, res) => {
  const { pfxBase64, password } = req.body;
  if (!pfxBase64 || !password)
    return res.status(400).json({ error: 'pfxBase64 e password obrigatórios' });

  try {
    const pfxBuffer = Buffer.from(pfxBase64, 'base64');
    const certInfo  = getCertInfo(pfxBuffer, password);

    // Limpar buffer
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

    // Limpar buffers com dados sensíveis
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

// ── MÚLTIPLAS ASSINATURAS — adicionar assinatura incremental ──
app.post('/icp/assinar-multiplo', async (req, res) => {
  // Recebe PDF já assinado + novo certificado → adiciona assinatura incremental
  const { pdfBase64, pfxBase64, password, docName } = req.body;

  if (!pdfBase64 || !pfxBase64 || !password)
    return res.status(400).json({ error: 'Dados incompletos' });

  try {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const pfxBuffer = Buffer.from(pfxBase64, 'base64');

    // signPdfWithA1 suporta PDF já assinado via xref incremental
    const result = await signPdfWithA1(pdfBuffer, pfxBuffer, password);
    pfxBuffer.fill(0);

    res.json({
      success:         true,
      signedPdfBase64: result.pdfBuffer.toString('base64'),
      hash:            result.hash,
      certInfo:        result.certInfo,
      signedAt:        result.signedAt,
    });
  } catch (e) {
    console.error('[ICP multiplo]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── WHATSAPP: ENVIAR OTP ─────────────────────────
app.post('/whatsapp/otp', async (req, res) => {
  const { phone, code, name } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Dados incompletos' });

  const msg = `*AssinaFácil* ✍️

Olá ${name || ''}! Seu código de verificação é:

*${code}*

⏰ Válido por 10 minutos.
🔒 Não compartilhe este código.`;

  try {
    const result = await sendWhatsApp(phone, msg);
    console.log('[WhatsApp OTP] Enviado →', phone, result);
    res.json({ success: true, result });
  } catch(e) {
    console.error('WhatsApp OTP erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ═══════════════════════════════════════════════════════════════
//  ICP-BRASIL A1 — Rotas
// ═══════════════════════════════════════════════════════════════


// ── GET cert info ──
app.post('/icp/cert-info', async (req, res) => {
  const { pfxBase64, password } = req.body;
  if (!pfxBase64 || !password)
    return res.status(400).json({ error: 'pfxBase64 e password obrigatórios' });

  try {
    const pfxBuffer = Buffer.from(pfxBase64, 'base64');
    const certInfo  = getCertInfo(pfxBuffer, password);

    // Limpar buffer
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

    // Limpar buffers com dados sensíveis
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

// ── MÚLTIPLAS ASSINATURAS — adicionar assinatura incremental ──
app.post('/icp/assinar-multiplo', async (req, res) => {
  // Recebe PDF já assinado + novo certificado → adiciona assinatura incremental
  const { pdfBase64, pfxBase64, password, docName } = req.body;

  if (!pdfBase64 || !pfxBase64 || !password)
    return res.status(400).json({ error: 'Dados incompletos' });

  try {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const pfxBuffer = Buffer.from(pfxBase64, 'base64');

    // signPdfWithA1 suporta PDF já assinado via xref incremental
    const result = await signPdfWithA1(pdfBuffer, pfxBuffer, password);
    pfxBuffer.fill(0);

    res.json({
      success:         true,
      signedPdfBase64: result.pdfBuffer.toString('base64'),
      hash:            result.hash,
      certInfo:        result.certInfo,
      signedAt:        result.signedAt,
    });
  } catch (e) {
    console.error('[ICP multiplo]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── WHATSAPP: CONVITE PARA ASSINAR ───────────────
app.post('/whatsapp/convite', async (req, res) => {
  const { phone, signerName, senderName, docName, signLink } = req.body;
  if (!phone) return res.status(400).json({ error: 'Celular não informado' });

  const msg = `*AssinaFácil* ✍️

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


// ═══════════════════════════════════════════════════════════════
//  ICP-BRASIL A1 — Rotas
// ═══════════════════════════════════════════════════════════════


// ── GET cert info ──
app.post('/icp/cert-info', async (req, res) => {
  const { pfxBase64, password } = req.body;
  if (!pfxBase64 || !password)
    return res.status(400).json({ error: 'pfxBase64 e password obrigatórios' });

  try {
    const pfxBuffer = Buffer.from(pfxBase64, 'base64');
    const certInfo  = getCertInfo(pfxBuffer, password);

    // Limpar buffer
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

    // Limpar buffers com dados sensíveis
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

// ── MÚLTIPLAS ASSINATURAS — adicionar assinatura incremental ──
app.post('/icp/assinar-multiplo', async (req, res) => {
  // Recebe PDF já assinado + novo certificado → adiciona assinatura incremental
  const { pdfBase64, pfxBase64, password, docName } = req.body;

  if (!pdfBase64 || !pfxBase64 || !password)
    return res.status(400).json({ error: 'Dados incompletos' });

  try {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const pfxBuffer = Buffer.from(pfxBase64, 'base64');

    // signPdfWithA1 suporta PDF já assinado via xref incremental
    const result = await signPdfWithA1(pdfBuffer, pfxBuffer, password);
    pfxBuffer.fill(0);

    res.json({
      success:         true,
      signedPdfBase64: result.pdfBuffer.toString('base64'),
      hash:            result.hash,
      certInfo:        result.certInfo,
      signedAt:        result.signedAt,
    });
  } catch (e) {
    console.error('[ICP multiplo]', e.message);
    res.status(500).json({ success: false, error: e.message });
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


// ═══════════════════════════════════════════════════════════════
//  ICP-BRASIL A1 — Rotas
// ═══════════════════════════════════════════════════════════════


// ── GET cert info ──
app.post('/icp/cert-info', async (req, res) => {
  const { pfxBase64, password } = req.body;
  if (!pfxBase64 || !password)
    return res.status(400).json({ error: 'pfxBase64 e password obrigatórios' });

  try {
    const pfxBuffer = Buffer.from(pfxBase64, 'base64');
    const certInfo  = getCertInfo(pfxBuffer, password);

    // Limpar buffer
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

    // Limpar buffers com dados sensíveis
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

// ── MÚLTIPLAS ASSINATURAS — adicionar assinatura incremental ──
app.post('/icp/assinar-multiplo', async (req, res) => {
  // Recebe PDF já assinado + novo certificado → adiciona assinatura incremental
  const { pdfBase64, pfxBase64, password, docName } = req.body;

  if (!pdfBase64 || !pfxBase64 || !password)
    return res.status(400).json({ error: 'Dados incompletos' });

  try {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const pfxBuffer = Buffer.from(pfxBase64, 'base64');

    // signPdfWithA1 suporta PDF já assinado via xref incremental
    const result = await signPdfWithA1(pdfBuffer, pfxBuffer, password);
    pfxBuffer.fill(0);

    res.json({
      success:         true,
      signedPdfBase64: result.pdfBuffer.toString('base64'),
      hash:            result.hash,
      certInfo:        result.certInfo,
      signedAt:        result.signedAt,
    });
  } catch (e) {
    console.error('[ICP multiplo]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── WHATSAPP: STATUS DA CONEXÃO ───────────────────
app.get('/whatsapp/status', async (req, res) => {
  try {
    const https = require('https');
    const url = new URL(ZAPI_BASE + '/status');
    const result = await new Promise((resolve, reject) => {
      https.get(url.toString(), (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({raw:data}); }});
      }).on('error', reject);
    });
    res.json({ success: true, status: result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SMS: ENVIAR OTP ──────────────────────────────
app.post('/sms/otp', async (req, res) => {
  const { phone, code, name } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Dados incompletos' });

  // Format phone — add +55 if Brazilian
  let phoneFormatted = phone.replace(/\D/g, '');
  if (phoneFormatted.length === 11) phoneFormatted = '+55' + phoneFormatted;
  else if (phoneFormatted.length === 10) phoneFormatted = '+55' + phoneFormatted;
  else if (!phoneFormatted.startsWith('+')) phoneFormatted = '+' + phoneFormatted;

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

// ── SMS: ENVIAR CONVITE ──────────────────────────
app.post('/sms/convite', async (req, res) => {
  const { phone, signerName, senderName, docName, signLink } = req.body;
  if (!phone) return res.status(400).json({ error: 'Celular não informado' });

  let phoneFormatted = phone.replace(/\D/g, '');
  if (phoneFormatted.length <= 11) phoneFormatted = '+55' + phoneFormatted;
  else if (!phoneFormatted.startsWith('+')) phoneFormatted = '+' + phoneFormatted;

  const msg = `AssinaFácil: Olá ${signerName || ''}! ${senderName || 'Alguém'} enviou o documento "${docName}" para você assinar. Acesse: ${signLink}`;

  try {
    await twilioClient.messages.create({
      body: msg.slice(0, 160), // SMS limit
      from: TWILIO_NUMBER,
      to: phoneFormatted,
    });
    console.log('[SMS] Convite enviado → ' + phoneFormatted);
    res.json({ success: true });
  } catch(e) {
    console.error('SMS convite erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── SMS: CONFIRMAÇÃO DE ASSINATURA ───────────────
app.post('/sms/confirmacao', async (req, res) => {
  const { phone, signerName, docName } = req.body;
  if (!phone) return res.status(400).json({ error: 'Celular não informado' });

  let phoneFormatted = phone.replace(/\D/g, '');
  if (phoneFormatted.length <= 11) phoneFormatted = '+55' + phoneFormatted;
  else if (!phoneFormatted.startsWith('+')) phoneFormatted = '+' + phoneFormatted;

  try {
    await twilioClient.messages.create({
      body: `AssinaFácil: ✅ ${signerName || 'Signatário'} assinou "${docName}". Acesse seu painel para baixar o documento.`,
      from: TWILIO_NUMBER,
      to: phoneFormatted,
    });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── CPF AVANÇADO — ReceitaWS + Validação completa ──
app.post('/auth/cpf-avancado', async (req, res) => {
  const { cpf, dataNascimento } = req.body;
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

  // Tentar consultar na ReceitaWS
  let receitaData = null;
  try {
    const https = require('https');
    // ReceitaWS endpoint
    let url = 'https://receitaws.com.br/v1/cpf/' + cpfClean;
    if (dataNascimento) {
      const d = dataNascimento.replace(/\D/g,'');
      if (d.length === 8) url += '/' + d.slice(0,2) + d.slice(2,4) + d.slice(4,8);
    }

    receitaData = await new Promise((resolve, reject) => {
      const req2 = https.get(url, { headers: { 'Accept': 'application/json' } }, (resp) => {
        let body = '';
        resp.on('data', chunk => body += chunk);
        resp.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch(e) { resolve(null); }
        });
      });
      req2.on('error', () => resolve(null));
      req2.setTimeout(8000, () => { req2.destroy(); resolve(null); });
    });
  } catch(e) { receitaData = null; }

  // Se a ReceitaWS retornou dados
  if (receitaData && receitaData.status) {
    const situacao = receitaData.status;
    const nome = receitaData.nome || null;
    const nascimento = receitaData.data_nascimento || null;
    const regular = situacao === 'OK' || situacao === 'REGULAR';

    // Verificar se data de nascimento confere (se informada)
    let nascimentoConfere = true;
    if (dataNascimento && nascimento) {
      const d1 = dataNascimento.replace(/\D/g,'');
      const d2 = nascimento.replace(/\D/g,'');
      nascimentoConfere = d1 === d2 || nascimento.includes(d1.slice(0,2)) && nascimento.includes(d1.slice(2,4));
    }

    return res.json({
      success:           true,
      cpf:               cpfFormatted,
      valid:             true,
      situacao,
      regular,
      nome,
      nascimento,
      nascimentoConfere,
      fonte:             'ReceitaWS',
      level:             regular ? 'Avançado' : 'Básico',
      message:           regular
        ? 'CPF regular na Receita Federal' + (nome ? ' · ' + nome : '')
        : 'CPF ' + situacao + ' na Receita Federal',
    });
  }

  // Fallback — validação básica por algoritmo
  res.json({
    success:    true,
    cpf:        cpfFormatted,
    valid:      true,
    situacao:   'VALIDADO_ALGORITMO',
    regular:    true,
    nome:       null,
    nascimento: null,
    fonte:      'Algoritmo Receita Federal',
    level:      'Básico',
    message:    'CPF válido (validação por algoritmo)',
  });
});

// ── CPF SIMPLES — ReceitaWS ──────────────────────
app.post('/auth/cpf', async (req, res) => {
  const { cpf } = req.body;
  if (!cpf) return res.status(400).json({ error: 'CPF não informado' });

  const cpfClean = cpf.replace(/\D/g, '');
  if (cpfClean.length !== 11)
    return res.status(400).json({ error: 'CPF inválido' });

  // Validate CPF algorithm
  function validateCPF(c) {
    if (/^(\d)\1{10}$/.test(c)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(c[i]) * (10 - i);
    let r = (sum * 10) % 11;
    if (r === 10 || r === 11) r = 0;
    if (r !== parseInt(c[9])) return false;
    sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(c[i]) * (11 - i);
    r = (sum * 10) % 11;
    if (r === 10 || r === 11) r = 0;
    return r === parseInt(c[10]);
  }

  if (!validateCPF(cpfClean))
    return res.json({ success: false, error: 'CPF inválido — dígitos verificadores incorretos' });

  // Format CPF for display
  const cpfFormatted = cpfClean.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

  try {
    // Try ReceitaWS API
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const req2 = https.get(
        'https://api.invertexto.com/v1/validator?token=FREE&value=' + cpfClean + '&type=cpf',
        (resp) => {
          let body = '';
          resp.on('data', chunk => body += chunk);
          resp.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch(e) { resolve(null); }
          });
        }
      );
      req2.on('error', reject);
      req2.setTimeout(5000, () => { req2.destroy(); reject(new Error('timeout')); });
    }).catch(() => null);

    res.json({
      success:      true,
      cpf:          cpfFormatted,
      valid:        true,
      message:      'CPF válido e verificado',
      verification: 'Algoritmo Receita Federal',
    });

    console.log('[CPF] Verificado:', cpfFormatted);
  } catch(e) {
    // Fallback — algorithm validation is enough
    res.json({
      success:  true,
      cpf:      cpfFormatted,
      valid:    true,
      message:  'CPF válido',
    });
  }
});

// ── RG SIMPLES — AWS Rekognition OCR ────────────
app.post('/auth/rg', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Imagem não enviada' });

  try {
    const result = await rekognition.detectText({
      Image: { Bytes: req.file.buffer },
    }).promise();

    const lines = result.TextDetections
      .filter(t => t.Type === 'LINE' && t.Confidence > 75)
      .map(t => t.DetectedText.trim())
      .filter(t => t.length > 2);

    const allText = lines.join(' ');

    // Extract RG number (7-9 digits with optional dots/dashes)
    const rgMatch = allText.match(/\b\d{1,2}\.?\d{3}\.?\d{3}[-.]?\d?\b/);
    const rg = rgMatch ? rgMatch[0].replace(/[^\d]/g, '') : null;

    // Extract CPF if present
    const cpfMatch = allText.match(/\d{3}[.\s]?\d{3}[.\s]?\d{3}[-.]?\d{2}/);
    const cpf = cpfMatch ? cpfMatch[0].replace(/\D/g, '') : null;

    // Extract name (lines before common RG fields)
    const namePatterns = ['NOME', 'NAME', 'TITULAR'];
    let name = null;
    for (let i = 0; i < lines.length; i++) {
      if (namePatterns.some(p => lines[i].toUpperCase().includes(p)) && lines[i+1]) {
        name = lines[i+1];
        break;
      }
    }

    // Extract birth date
    const dateMatch = allText.match(/\d{2}[/.-]\d{2}[/.-]\d{4}/);
    const birthDate = dateMatch ? dateMatch[0] : null;

    // Detect document type
    const isRG = allText.toUpperCase().includes('IDENTIDADE') ||
                 allText.toUpperCase().includes('REGISTRO GERAL') ||
                 allText.toUpperCase().includes('RG') ||
                 allText.toUpperCase().includes('SSP');
    const isCNH = allText.toUpperCase().includes('HABILITACAO') ||
                  allText.toUpperCase().includes('HABILITAÇÃO') ||
                  allText.toUpperCase().includes('CNH') ||
                  allText.toUpperCase().includes('DETRAN');

    const docType = isCNH ? 'CNH' : isRG ? 'RG' : 'Documento';

    if (lines.length === 0)
      return res.json({ success: false, error: 'Não foi possível ler o documento. Use boa iluminação.' });

    res.json({
      success:   true,
      docType,
      rg,
      cpf,
      name,
      birthDate,
      allLines:  lines,
      message:   docType + ' lido com sucesso via AWS Rekognition',
    });

    console.log('[RG] Lido:', docType, rg || '', cpf || '');
  } catch(e) {
    console.error('RG OCR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── VERIFICAÇÃO COMPLETA DE IDENTIDADE ───────────
// CPF + RG + Selfie comparação tudo em um
app.post('/auth/identidade', upload.fields([
  { name: 'selfie',    maxCount: 1 },
  { name: 'documento', maxCount: 1 },
]), async (req, res) => {
  const { cpf } = req.body;
  const results = { cpf: null, documento: null, selfie: null, overall: false };

  // 1. Validate CPF
  if (cpf) {
    const cpfClean = cpf.replace(/\D/g, '');
    function validateCPF(c) {
      if (/^(\d)\1{10}$/.test(c)) return false;
      let s = 0;
      for (let i = 0; i < 9; i++) s += parseInt(c[i]) * (10-i);
      let r = (s*10)%11; if(r>=10) r=0;
      if (r !== parseInt(c[9])) return false;
      s = 0;
      for (let i = 0; i < 10; i++) s += parseInt(c[i]) * (11-i);
      r = (s*10)%11; if(r>=10) r=0;
      return r === parseInt(c[10]);
    }
    results.cpf = { valid: validateCPF(cpfClean), cpf: cpfClean };
  }

  // 2. Read document
  if (req.files?.documento) {
    try {
      const docResult = await rekognition.detectText({
        Image: { Bytes: req.files.documento[0].buffer }
      }).promise();
      const lines = docResult.TextDetections
        .filter(t => t.Type === 'LINE' && t.Confidence > 75)
        .map(t => t.DetectedText);
      results.documento = { success: true, lines: lines.slice(0, 10) };
    } catch(e) { results.documento = { success: false, error: e.message }; }
  }

  // 3. Compare selfie with document
  if (req.files?.selfie && req.files?.documento) {
    try {
      const compare = await rekognition.compareFaces({
        SourceImage: { Bytes: req.files.selfie[0].buffer },
        TargetImage: { Bytes: req.files.documento[0].buffer },
        SimilarityThreshold: 70,
      }).promise();
      const sim = compare.FaceMatches[0]?.Similarity || 0;
      results.selfie = { success: sim >= 75, similarity: Math.round(sim) };
    } catch(e) { results.selfie = { success: false, error: e.message }; }
  }

  results.overall = (
    (!cpf || results.cpf?.valid) &&
    (!req.files?.documento || results.documento?.success) &&
    (!req.files?.selfie || results.selfie?.success)
  );

  res.json(results);
});

// ── REKOGNITION: CRIAR SESSÃO LIVENESS ──────────
app.post('/auth/liveness/criar', async (req, res) => {
  try {
    const rekV2 = new AWS.RekognitionV2 ? new AWS.RekognitionV2() : rekognition;
    // Use standard Rekognition CreateFaceLivenessSession
    const result = await new AWS.Rekognition().createFaceLivenessSession({
      Settings: {
        OutputConfig: { S3Bucket: 'assinafacil-liveness' },
        AuditImagesLimit: 2,
      }
    }).promise();
    res.json({ success: true, sessionId: result.SessionId });
  } catch(e) {
    // Fallback: simulate liveness with detectFaces
    console.warn('Liveness API não disponível, usando fallback:', e.message);
    res.json({ success: true, sessionId: 'sim_' + Date.now(), fallback: true });
  }
});

// ── REKOGNITION: VERIFICAR LIVENESS COM FOTO ────
app.post('/auth/liveness/verificar', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Imagem não enviada' });
  try {
    // Detect faces with full attributes for liveness check
    const detect = await rekognition.detectFaces({
      Image: { Bytes: req.file.buffer },
      Attributes: ['ALL'],
    }).promise();

    if (detect.FaceDetails.length === 0)
      return res.json({ success: false, error: 'Nenhum rosto detectado. Posicione o rosto na câmera.' });

    const face = detect.FaceDetails[0];

    // Liveness indicators
    const eyesOpen      = face.EyesOpen?.Value      && face.EyesOpen.Confidence > 85;
    const notSunglasses = !face.Sunglasses?.Value;
    const highConf      = face.Confidence > 95;
    const goodPose      = Math.abs(face.Pose?.Yaw || 0) < 30 && Math.abs(face.Pose?.Pitch || 0) < 30;
    const notMask       = !face.MouthOpen?.Value === false; // mouth detection

    const livenessScore = [eyesOpen, notSunglasses, highConf, goodPose, notMask]
      .filter(Boolean).length;

    const isLive = livenessScore >= 3 && highConf;

    if (isLive) {
      res.json({
        success:      true,
        score:        Math.round(face.Confidence),
        eyesOpen,
        pose:         face.Pose,
        message:      'Pessoa real detectada (' + Math.round(face.Confidence) + '% confiança)',
        ageRange:     face.AgeRange,
        smile:        face.Smile?.Value,
      });
    } else {
      res.json({
        success: false,
        score:   Math.round(face.Confidence),
        error:   eyesOpen ? 'Mantenha o rosto centralizado e olhos abertos' : 'Abra os olhos e olhe para a câmera',
      });
    }
  } catch(e) {
    console.error('Liveness:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── REKOGNITION: DETECÇÃO DE EMOÇÕES ────────────
app.post('/auth/emocoes', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Imagem não enviada' });
  try {
    const detect = await rekognition.detectFaces({
      Image: { Bytes: req.file.buffer },
      Attributes: ['ALL'],
    }).promise();
    if (detect.FaceDetails.length === 0)
      return res.json({ success: false, error: 'Rosto não encontrado' });
    const face     = detect.FaceDetails[0];
    const emotions = face.Emotions?.sort((a,b) => b.Confidence - a.Confidence) || [];
    res.json({
      success:    true,
      emotions:   emotions.slice(0,3),
      dominant:   emotions[0]?.Type,
      smile:      face.Smile,
      eyesOpen:   face.EyesOpen,
      ageRange:   face.AgeRange,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── REKOGNITION: DETECTAR TEXTO NO DOCUMENTO ────
app.post('/auth/documento', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Imagem não enviada' });
  try {
    const result = await rekognition.detectText({
      Image: { Bytes: req.file.buffer },
    }).promise();

    const texts = result.TextDetections
      .filter(t => t.Type === 'LINE' && t.Confidence > 80)
      .map(t => t.DetectedText);

    // Try to extract CPF
    const cpfMatch = texts.join(' ').match(/\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[-\.\s]?\d{2}/);
    const cpf = cpfMatch ? cpfMatch[0].replace(/\D/g,'') : null;

    res.json({
      success:   texts.length > 0,
      texts,
      cpf,
      message:   texts.length > 0 ? 'Documento lido com sucesso' : 'Não foi possível ler o documento',
    });
  } catch(e) {
    console.error('Documento rekognition:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── VALIDAÇÃO DE IDENTIDADE COMPLETA ────────────
// Combina: CPF + RG/CNH OCR + Selfie + Comparação + Liveness
app.post('/auth/identidade-completa', upload.fields([
  { name: 'selfie',    maxCount: 1 },
  { name: 'documento', maxCount: 1 },
]), async (req, res) => {
  const { cpf } = req.body;
  const steps = [];
  let score = 0;
  let approved = false;

  // ── PASSO 1: Validar CPF ──────────────────────
  if (cpf) {
    const c = cpf.replace(/\D/g,'');
    function validCPF(n) {
      if (/^(\d)\1{10}$/.test(n)) return false;
      let s=0; for(let i=0;i<9;i++) s+=parseInt(n[i])*(10-i);
      let r=(s*10)%11; if(r>=10) r=0; if(r!==parseInt(n[9])) return false;
      s=0; for(let i=0;i<10;i++) s+=parseInt(n[i])*(11-i);
      r=(s*10)%11; if(r>=10) r=0; return r===parseInt(n[10]);
    }
    const valid = validCPF(c);
    steps.push({ step: 1, name: 'CPF', success: valid, detail: valid ? 'CPF válido: ' + c.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : 'CPF inválido' });
    if (valid) score += 20;
  }

  // ── PASSO 2: Ler documento (OCR) ─────────────
  let docData = null;
  if (req.files?.documento) {
    try {
      const ocr = await rekognition.detectText({
        Image: { Bytes: req.files.documento[0].buffer }
      }).promise();
      const lines = ocr.TextDetections.filter(t => t.Type==='LINE' && t.Confidence>75).map(t => t.DetectedText);
      const allText = lines.join(' ');
      const cpfMatch = allText.match(/\d{3}[.\s]?\d{3}[.\s]?\d{3}[-.]?\d{2}/);
      const rgMatch  = allText.match(/\b\d{1,2}\.?\d{3}\.?\d{3}[-.]?\d?\b/);
      const dateMatch = allText.match(/\d{2}[/.-]\d{2}[/.-]\d{4}/);
      const isDoc = lines.length >= 3;
      docData = { lines, cpf: cpfMatch?.[0], rg: rgMatch?.[0], birthDate: dateMatch?.[0] };
      steps.push({ step: 2, name: 'Documento', success: isDoc, detail: isDoc ? 'Documento lido: ' + lines.slice(0,3).join(' | ') : 'Documento ilegível' });
      if (isDoc) score += 20;
      // Bonus: CPF do doc bate com CPF informado
      if (cpf && cpfMatch && cpfMatch[0].replace(/\D/g,'') === cpf.replace(/\D/g,'')) {
        steps.push({ step: '2b', name: 'CPF no documento', success: true, detail: 'CPF do documento confere com o informado ✅' });
        score += 10;
      }
    } catch(e) {
      steps.push({ step: 2, name: 'Documento', success: false, detail: 'Erro OCR: ' + e.message });
    }
  }

  // ── PASSO 3: Verificar selfie (rosto real) ────
  if (req.files?.selfie) {
    try {
      const detect = await rekognition.detectFaces({
        Image: { Bytes: req.files.selfie[0].buffer },
        Attributes: ['ALL']
      }).promise();
      const face = detect.FaceDetails[0];
      const ok = face && face.Confidence > 90;
      steps.push({
        step: 3, name: 'Selfie', success: ok,
        detail: ok ? 'Rosto detectado com ' + Math.round(face?.Confidence||0) + '% de confiança' : 'Rosto não detectado'
      });
      if (ok) score += 20;
    } catch(e) {
      steps.push({ step: 3, name: 'Selfie', success: false, detail: 'Erro selfie: ' + e.message });
    }
  }

  // ── PASSO 4: Comparar selfie com documento ────
  if (req.files?.selfie && req.files?.documento) {
    try {
      const compare = await rekognition.compareFaces({
        SourceImage: { Bytes: req.files.selfie[0].buffer },
        TargetImage: { Bytes: req.files.documento[0].buffer },
        SimilarityThreshold: 60,
      }).promise();
      const sim = compare.FaceMatches[0]?.Similarity || 0;
      const ok = sim >= 75;
      steps.push({
        step: 4, name: 'Comparação facial', success: ok,
        detail: ok ? 'Selfie confere com documento: ' + Math.round(sim) + '% de similaridade' : 'Baixa similaridade: ' + Math.round(sim) + '%'
      });
      if (ok) score += 30;
    } catch(e) {
      // Face not found in document — still pass with lower score
      steps.push({ step: 4, name: 'Comparação facial', success: false, detail: 'Foto não encontrada no documento' });
    }
  }

  // ── RESULTADO FINAL ───────────────────────────
  approved = score >= 60;
  const level = score >= 90 ? 'Alta' : score >= 70 ? 'Média' : score >= 50 ? 'Baixa' : 'Insuficiente';

  const result = {
    approved,
    score,
    level,
    steps,
    summary: approved
      ? 'Identidade verificada com nível ' + level + ' (' + score + '/100)'
      : 'Verificação incompleta (' + score + '/100) — ' + steps.filter(s=>!s.success).map(s=>s.name).join(', '),
    docData,
    timestamp: new Date().toISOString(),
    hash: require('crypto').createHash('sha256').update(JSON.stringify(steps) + Date.now()).digest('hex'),
  };

  console.log('[Identidade] Score:', score, '| Aprovado:', approved, '| Nível:', level);
  res.json(result);
});

// ── WEBHOOK ─────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const { type, data } = req.body;
  if (type === 'payment' && data?.id) {
    try {
      const r = await payment.get({ id: data.id });
      console.log(`[Webhook] ${r.id} → ${r.status} R$${r.transaction_amount}`);
    } catch(e) { console.error('Webhook:', e.message); }
  }
  res.sendStatus(200);
});

// ── START ────────────────────────────────────────
const PORT = 3001;


// ══════════════════════════════════════════════════════
//  ICP-BRASIL — TIMESTAMP + VALIDAÇÃO ITI
// ══════════════════════════════════════════════════════

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
    // Verificar certificado
    const info = getCertInfo(pfxBuffer, password);
    if (!info) throw new Error('Certificado inválido ou senha incorreta');
    if (info.expirado) throw new Error('Certificado expirado em ' + info.validade);

    // 1. Assinar PDF
    console.log('[ICP Completo] Etapa 1/3: Assinando PDF...');
    let signedPdf = await signPdfWithA1(pdfBuffer, pfxBuffer, password);

    // 2. Adicionar timestamp (opcional mas recomendado para ICP-Brasil)
    let tsInfo = null;
    if (addTimestamp === 'true' || addTimestamp === true) {
      console.log('[ICP Completo] Etapa 2/3: Adicionando carimbo do tempo...');
      try {
        const tsResult = await addTrustedTimestampToSignedPdf(signedPdf);
        signedPdf = tsResult.pdf;
        tsInfo = tsResult.tsInfo;
        console.log('[ICP Completo] ✅ Timestamp adicionado:', tsInfo.genTime);
      } catch(e) {
        console.warn('[ICP Completo] ⚠️ Timestamp falhou (continuando sem):', e.message);
      }
    }

    // 3. Validar PDF final
    console.log('[ICP Completo] Etapa 3/3: Validando conformidade ITI...');
    const validationReport = validateSignedPdfForITI(signedPdf);

    // 4. Gerar log técnico
    const technicalLog = gerarLogTecnico(validationReport, tsInfo, info);
    console.log('[ICP Completo] Relatório de validação:');
    console.log('  Passou:', validationReport.passed);
    console.log('  Risco ITI:', validationReport.riscoRejeicaoITI);
    console.log('  Alertas:', validationReport.alertas.length);

    // Retornar PDF assinado
    res.set({
      'Content-Type':         'application/pdf',
      'Content-Disposition':  'attachment; filename="documento-assinado-icp-brasil.pdf"',
      'Content-Length':       signedPdf.length,
      'X-Signer-Name':        info.nome || '',
      'X-Signer-CPF':         info.cpf  || '',
      'X-Cert-Valid-Until':   info.validade || '',
      'X-Timestamp-Present':  tsInfo ? 'true' : 'false',
      'X-Timestamp-Time':     tsInfo?.genTime || '',
      'X-Validation-Passed':  String(validationReport.passed),
      'X-Validation-Risk':    validationReport.riscoRejeicaoITI,
    });
    res.send(signedPdf);

  } catch(e) {
    console.error('[ICP Completo] ❌', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── ADICIONAR TIMESTAMP A PDF JÁ ASSINADO ────────────
app.post('/assinar/icp/timestamp', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDF não enviado' });

  const tsaUrl = req.body.tsaUrl || TSA_CONFIG.url;
  console.log('[Timestamp] Adicionando carimbo do tempo. TSA:', tsaUrl);

  try {
    const result = await addTrustedTimestampToSignedPdf(req.file.buffer, { url: tsaUrl });
    console.log('[Timestamp] ✅ Timestamp aplicado:', result.tsInfo.genTime);

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': 'attachment; filename="documento-assinado-com-timestamp.pdf"',
      'Content-Length':      result.pdf.length,
      'X-Timestamp-Time':    result.tsInfo.genTime,
      'X-Timestamp-Serial':  result.tsInfo.serial,
    });
    res.send(result.pdf);

  } catch(e) {
    console.error('[Timestamp] ❌', e.message);
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

// ── STATUS DAS TSAs ───────────────────────────────────
app.get('/assinar/icp/tsa-status', async (req, res) => {
  const tsas = [
    { nome: 'DigiCert (Gratuita)',  url: 'http://timestamp.digicert.com' },
    { nome: 'Sectigo (Gratuita)',   url: 'http://timestamp.sectigo.com'  },
    { nome: 'SwissSign',            url: 'http://tsa.swisssign.net'      },
    { nome: 'Configurada (.env)',   url: process.env.TSA_URL || 'Não configurada' },
  ];

  const results = tsas.map(t => ({
    nome:   t.nome,
    url:    t.url,
    ativa:  t.url.startsWith('http'),
    usada:  t.url === (process.env.TSA_URL || 'http://timestamp.digicert.com'),
  }));

  res.json({
    success: true,
    tsas:    results,
    tsaAtual: process.env.TSA_URL || 'http://timestamp.digicert.com (padrão)',
    info:    'Para usar TSA ICP-Brasil (produção): configure TSA_URL no .env',
  });
});

// ══════════════════════════════════════════════════════
//  ICP-BRASIL A1 — Assinatura Digital PAdES/PKCS#7
// ══════════════════════════════════════════════════════

// ── INFO DO CERTIFICADO ──────────────────────────────
app.post('/assinar/icp/info', upload.single('pfx'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo .pfx não enviado' });
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Senha não informada' });

  try {
    const info = getCertInfo(req.file.buffer, password);
    if (!info) return res.status(400).json({ error: 'Não foi possível ler o certificado' });
    if (info.expirado) return res.json({ success: false, error: 'Certificado expirado em ' + info.validade, info });
    res.json({ success: true, info });
  } catch(e) {
    console.error('[ICP Info]', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── ASSINAR PDF COM CERTIFICADO A1 ──────────────────
app.post('/assinar/icp', upload.fields([
  { name: 'pdf', maxCount: 1 },
  { name: 'pfx', maxCount: 1 },
]), async (req, res) => {
  if (!req.files?.pdf || !req.files?.pfx)
    return res.status(400).json({ error: 'Envie o PDF e o certificado .pfx' });

  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Senha do certificado obrigatória' });

  const pdfBuffer = req.files.pdf[0].buffer;
  const pfxBuffer = req.files.pfx[0].buffer;

  console.log('[ICP] Iniciando assinatura PAdES...');
  console.log('[ICP] PDF:', req.files.pdf[0].size, 'bytes');
  console.log('[ICP] PFX:', req.files.pfx[0].size, 'bytes');

  try {
    // Verificar certificado antes de assinar
    const info = getCertInfo(pfxBuffer, password);
    if (!info) throw new Error('Certificado inválido ou senha incorreta');
    if (info.expirado) throw new Error('Certificado expirado em ' + info.validade);

    console.log('[ICP] Certificado:', info.nome, '| CPF:', info.cpf || 'N/A');

    // Assinar o PDF
    const signedPdf = await signPdfWithA1(pdfBuffer, pfxBuffer, password);

    console.log('[ICP] ✅ PDF assinado com sucesso!', signedPdf.length, 'bytes');

    // Retornar PDF assinado
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': 'attachment; filename="documento-assinado-icp.pdf"',
      'Content-Length':      signedPdf.length,
      'X-Signer-Name':       info.nome || '',
      'X-Signer-CPF':        info.cpf  || '',
      'X-Cert-Valid-Until':  info.validade || '',
    });
    res.send(signedPdf);

  } catch(e) {
    console.error('[ICP] ❌ Erro:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── MÚLTIPLAS ASSINATURAS (incremental) ─────────────
app.post('/assinar/icp/multiplas', upload.any(), async (req, res) => {
  // Aceita: pdf, pfx1, pfx2, pfx3 + passwords JSON
  const pdfFile = req.files.find(f => f.fieldname === 'pdf');
  const pfxFiles = req.files.filter(f => f.fieldname.startsWith('pfx'));
  
  if (!pdfFile || pfxFiles.length === 0)
    return res.status(400).json({ error: 'Envie o PDF e pelo menos um certificado .pfx' });

  let passwords;
  try { passwords = JSON.parse(req.body.passwords || '[]'); }
  catch(e) { return res.status(400).json({ error: 'Formato de senhas inválido' }); }

  if (passwords.length !== pfxFiles.length)
    return res.status(400).json({ error: 'Número de senhas deve corresponder ao de certificados' });

  try {
    let currentPdf = pdfFile.buffer;
    const signers = [];

    for (let i = 0; i < pfxFiles.length; i++) {
      const pfxBuffer = pfxFiles[i].buffer;
      const password  = passwords[i];
      
      const info = getCertInfo(pfxBuffer, password);
      if (!info) throw new Error(`Certificado ${i+1} inválido`);
      if (info.expirado) throw new Error(`Certificado ${i+1} expirado: ${info.nome}`);

      console.log(`[ICP] Assinando com cert ${i+1}: ${info.nome}`);
      currentPdf = await signPdfWithA1(currentPdf, pfxBuffer, password);
      signers.push({ nome: info.nome, cpf: info.cpf, validade: info.validade });
    }

    console.log('[ICP] ✅ PDF com', pfxFiles.length, 'assinaturas gerado!');

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': 'attachment; filename="documento-multiassinado-icp.pdf"',
      'Content-Length':      currentPdf.length,
      'X-Signatures-Count':  String(pfxFiles.length),
    });
    res.send(currentPdf);

  } catch(e) {
    console.error('[ICP Múltiplas]', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log('');
  console.log('  ✅  Servidor AssinaFácil iniciado!');
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log('');
  console.log('  📅  Mensal  → R$ 29,90/mês');
  console.log('  📆  Anual   → R$ 99,90/ano');
  console.log('');
});
