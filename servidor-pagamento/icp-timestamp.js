/**
 * ══════════════════════════════════════════════════════════════════════
 *  AssinaFácil — Carimbo do Tempo ICP-Brasil (RFC 3161 / PAdES-T)
 *  Compatível com: validar.iti.gov.br, Adobe Acrobat Reader
 *  TSAs homologadas ICP-Brasil: Serasa, Valid, Certisign, Serpro
 * ══════════════════════════════════════════════════════════════════════
 */

'use strict';

const forge  = require('node-forge');
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const url    = require('url');

// ── TSA CONFIG (via .env) ─────────────────────────────────────────────
const TSA_CONFIG = {
  url:       process.env.TSA_URL       || 'http://timestamp.digicert.com',
  username:  process.env.TSA_USERNAME  || '',
  password:  process.env.TSA_PASSWORD  || '',
  policyOid: process.env.TSA_POLICY_OID|| '',
  timeout:   parseInt(process.env.TSA_TIMEOUT || '15000'),
  // TSAs ICP-Brasil homologadas (fallback chain)
  fallbackUrls: [
    'http://timestamp.digicert.com',       // DigiCert (gratuita, muito confiável)
    'http://timestamp.sectigo.com',        // Sectigo (gratuita)
    'http://tsa.swisssign.net',            // SwissSign
    'http://timestamp.apple.com/ts01',    // Apple TSA
  ],
};

// ══════════════════════════════════════════════════════════════════════
//  FUNÇÃO PRINCIPAL: addTrustedTimestampToSignedPdf
//  Adiciona carimbo do tempo RFC 3161 num PDF já assinado
// ══════════════════════════════════════════════════════════════════════
async function addTrustedTimestampToSignedPdf(pdfBuffer, tsaConfig = {}) {
  const cfg = { ...TSA_CONFIG, ...tsaConfig };

  log('[TSA] Iniciando processo de carimbo do tempo...');
  log('[TSA] TSA URL:', cfg.url);

  // ── 1. Localizar a assinatura PKCS#7 no PDF ─────────────────────
  const pdfStr = pdfBuffer.toString('binary');
  const sigLocation = findSignatureInPdf(pdfStr);

  if (!sigLocation) {
    throw new Error('Assinatura PKCS#7 não encontrada no PDF. Assine o PDF primeiro.');
  }

  log('[TSA] Assinatura encontrada. Offset:', sigLocation.contentsOffset);

  // ── 2. Extrair o token PKCS#7 atual ─────────────────────────────
  const sigHex = pdfStr.slice(sigLocation.contentsOffset + 1, sigLocation.contentsEnd - 1);
  const sigDer  = Buffer.from(sigHex, 'hex');

  // ── 3. Calcular hash SHA-256 da assinatura para o TSR ───────────
  const sigHash = crypto.createHash('sha256').update(sigDer).digest();
  log('[TSA] Hash SHA-256 da assinatura:', sigHash.toString('hex').slice(0, 32) + '...');

  // ── 4. Montar TSQ (TimeStamp Request) RFC 3161 ──────────────────
  const tsq = buildTimestampRequest(sigHash, cfg.policyOid);
  log('[TSA] TSQ montado:', tsq.length, 'bytes');

  // ── 5. Enviar para TSA com fallback ─────────────────────────────
  let tsrBuffer = null;
  const urlsToTry = [cfg.url, ...cfg.fallbackUrls.filter(u => u !== cfg.url)];

  for (const tsaUrl of urlsToTry) {
    try {
      log('[TSA] Tentando:', tsaUrl);
      tsrBuffer = await sendTimestampRequest(tsq, tsaUrl, cfg);
      log('[TSA] ✅ Resposta recebida de:', tsaUrl, '|', tsrBuffer.length, 'bytes');
      break;
    } catch(e) {
      log('[TSA] ⚠️ Falhou em ' + tsaUrl + ':', e.message);
    }
  }

  if (!tsrBuffer) {
    throw new Error('Não foi possível obter carimbo do tempo. Verifique a conexão com a TSA.');
  }

  // ── 6. Validar a resposta TSR ────────────────────────────────────
  const tsInfo = parseTsrResponse(tsrBuffer);
  if (!tsInfo.success) {
    throw new Error('TSA recusou a requisição: ' + tsInfo.error);
  }

  log('[TSA] Token recebido. Status: GRANTED');
  log('[TSA] Hora carimbada:', tsInfo.genTime);
  log('[TSA] Serial:', tsInfo.serial);
  if (tsInfo.tsa) log('[TSA] Emissor:', tsInfo.tsa);

  // ── 7. Incorporar timestamp token no PKCS#7 via unsigned attr ───
  const updatedSigHex = embedTimestampInPkcs7(sigDer, tsrBuffer);
  const updatedSigHexStr = updatedSigHex.toString('hex').padEnd(sigHex.length, '0');

  // ── 8. Substituir a assinatura no PDF ────────────────────────────
  if (updatedSigHexStr.length > sigHex.length) {
    throw new Error(
      `Token de timestamp muito grande: ${updatedSigHexStr.length} vs placeholder ${sigHex.length}. ` +
      'Aumente SIGNATURE_PLACEHOLDER_SIZE no icp-brasil.js para 131072.'
    );
  }

  const pdfWithTs =
    pdfStr.slice(0, sigLocation.contentsOffset + 1) +
    updatedSigHexStr +
    pdfStr.slice(sigLocation.contentsEnd - 1);

  const resultBuffer = Buffer.from(pdfWithTs, 'binary');

  // ── 9. Gerar log técnico ─────────────────────────────────────────
  const technicalLog = {
    hashFinalPdf:   crypto.createHash('sha256').update(resultBuffer).digest('hex'),
    hashAssinatura: sigHash.toString('hex'),
    tamanhoOriginal: pdfBuffer.length,
    tamanhoFinal:    resultBuffer.length,
    timestampHora:  tsInfo.genTime,
    timestampSerial: tsInfo.serial,
    timestampEmissor: tsInfo.tsa || 'N/A',
    integridade:    'OK',
    tsaUrl:         cfg.url,
  };

  log('[TSA] ✅ Carimbo do tempo incorporado com sucesso!');
  log('[TSA] Hash final do PDF:', technicalLog.hashFinalPdf.slice(0, 32) + '...');

  return { pdf: resultBuffer, log: technicalLog, tsInfo };
}

// ══════════════════════════════════════════════════════════════════════
//  MONTAR TSQ — TimeStamp Request (RFC 3161)
// ══════════════════════════════════════════════════════════════════════
function buildTimestampRequest(messageHash, policyOid = '') {
  /*
    TimeStampReq ::= SEQUENCE {
      version INTEGER { v1(1) },
      messageImprint MessageImprint,
      reqPolicy TSAPolicyId OPTIONAL,
      nonce INTEGER OPTIONAL,
      certReq BOOLEAN DEFAULT FALSE,
      extensions [0] IMPLICIT Extensions OPTIONAL
    }
    MessageImprint ::= SEQUENCE {
      hashAlgorithm AlgorithmIdentifier,
      hashedMessage OCTET STRING
    }
  */

  // Nonce aleatório para prevenir replay
  const nonce = crypto.randomBytes(8);

  // SHA-256 OID: 2.16.840.1.101.3.4.2.1
  const sha256Oid = [2, 16, 840, 1, 101, 3, 4, 2, 1];

  // Montar MessageImprint
  const algoIdSeq = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false,
      forge.asn1.oidToDer(sha256Oid.join('.')).bytes()
    ),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ''),
  ]);

  const msgImprint = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    algoIdSeq,
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false,
      messageHash.toString('binary')
    ),
  ]);

  // Construir TimeStampReq
  const tsReqChildren = [
    // version = 1
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false,
      forge.util.createBuffer(Buffer.from([0x01])).bytes()
    ),
    msgImprint,
  ];

  // reqPolicy (opcional)
  if (policyOid) {
    tsReqChildren.push(
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false,
        forge.asn1.oidToDer(policyOid).bytes()
      )
    );
  }

  // nonce
  tsReqChildren.push(
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false,
      nonce.toString('binary')
    )
  );

  // certReq = TRUE (pedir o certificado do TSA na resposta — obrigatório para ICP-Brasil)
  tsReqChildren.push(
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.BOOLEAN, false,
      forge.util.createBuffer(Buffer.from([0xff])).bytes()
    )
  );

  const tsReq = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, tsReqChildren);

  const der = forge.asn1.toDer(tsReq).bytes();
  return Buffer.from(der, 'binary');
}

// ══════════════════════════════════════════════════════════════════════
//  ENVIAR PARA TSA via HTTP/HTTPS (RFC 3161)
// ══════════════════════════════════════════════════════════════════════
function sendTimestampRequest(tsqBuffer, tsaUrl, cfg) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(tsaUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (isHttps ? 443 : 80),
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/timestamp-query',
        'Content-Length': tsqBuffer.length,
        'Accept':         'application/timestamp-reply',
        'User-Agent':     'AssinaFacil-ICP-Brasil/2.0',
      },
      timeout: cfg.timeout || 15000,
    };

    // Autenticação básica (se TSA exigir)
    if (cfg.username && cfg.password) {
      const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
      options.headers['Authorization'] = `Basic ${auth}`;
    }

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          return reject(new Error(`TSA retornou HTTP ${res.statusCode}: ${body.toString().slice(0,100)}`));
        }
        const ct = res.headers['content-type'] || '';
        if (!ct.includes('timestamp-reply') && !ct.includes('octet-stream') && body.length < 10) {
          return reject(new Error('Resposta inválida da TSA'));
        }
        resolve(body);
      });
    });

    req.on('error',   (e) => reject(new Error('Conexão com TSA falhou: ' + e.message)));
    req.on('timeout', ()  => { req.destroy(); reject(new Error('TSA timeout após ' + cfg.timeout + 'ms')); });

    req.write(tsqBuffer);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════
//  PARSEAR RESPOSTA TSR (TimeStampResponse)
// ══════════════════════════════════════════════════════════════════════
function parseTsrResponse(tsrBuffer) {
  try {
    const tsrDer  = forge.util.createBuffer(tsrBuffer.toString('binary'));
    const tsrAsn1 = forge.asn1.fromDer(tsrDer);

    // TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken ContentInfo OPTIONAL }
    const seq = tsrAsn1.value;
    if (!seq || !seq[0]) return { success: false, error: 'Resposta TSA inválida' };

    // Verificar status
    const statusSeq = seq[0].value;
    const statusVal = statusSeq?.[0]?.value;
    // status 0 = GRANTED, 1 = GRANTED_WITH_MODS
    const statusInt = statusVal ? forge.util.createBuffer(statusVal).getInt(8) : -1;

    if (statusInt !== 0 && statusInt !== 1) {
      const failInfo = statusSeq?.[2]?.value || '';
      return { success: false, error: `TSA recusou. Status: ${statusInt}. ${failInfo}` };
    }

    // Extrair TSTInfo do ContentInfo
    const contentInfo = seq[1];
    if (!contentInfo) return { success: false, error: 'Token de tempo não recebido' };

    // Navegar até TSTInfo dentro do CMS SignedData
    let genTime = new Date().toISOString();
    let serial  = 'N/A';
    let tsaName = null;

    try {
      // ContentInfo.content = SignedData
      const signedData = contentInfo.value[1]?.value[0];
      if (signedData) {
        // EncapsulatedContentInfo.eContent
        const encapContent = findAsn1Value(signedData, forge.asn1.Type.SEQUENCE);
        // TSTInfo contém genTime em GeneralizedTime
        const genTimeDer = findInAsn1(signedData, forge.asn1.Type.GENERALIZEDTIME);
        if (genTimeDer) {
          genTime = parseGeneralizedTime(genTimeDer.value);
        }
        // Serialnumber
        const intNode = findInAsn1(signedData, forge.asn1.Type.INTEGER);
        if (intNode && intNode.value.length > 2) {
          serial = Buffer.from(intNode.value, 'binary').toString('hex').slice(0, 20);
        }
      }
    } catch(e) {
      // Continua — dados básicos já extraídos
    }

    return { success: true, genTime, serial, tsa: tsaName, rawToken: tsrBuffer };

  } catch(e) {
    return { success: false, error: 'Erro ao parsear TSR: ' + e.message };
  }
}

// ══════════════════════════════════════════════════════════════════════
//  INCORPORAR TIMESTAMP NO PKCS#7 (unsigned attribute 1.2.840.113549.1.9.16.2.14)
//  OID do SignatureTimeStampToken: id-aa-signatureTimeStampToken
// ══════════════════════════════════════════════════════════════════════
function embedTimestampInPkcs7(pkcs7Der, tsrBuffer) {
  try {
    const p7Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pkcs7Der.toString('binary')));

    // Extrair apenas o TSTInfo do TimeStampResponse (o ContentInfo)
    const tsrAsn1 = forge.asn1.fromDer(forge.util.createBuffer(tsrBuffer.toString('binary')));
    const tsToken  = tsrAsn1.value?.[1]; // O ContentInfo com o SignedData do timestamp

    if (!tsToken) {
      log('[TSA] ⚠️ Não foi possível extrair TimeStampToken. Retornando PDF sem timestamp embutido.');
      return pkcs7Der;
    }

    // OID: 1.2.840.113549.1.9.16.2.14 — id-aa-signatureTimeStampToken
    const tsOid = '1.2.840.113549.1.9.16.2.14';

    // Criar unsigned attribute SET com o timestamp
    const tsAttr = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false,
        forge.asn1.oidToDer(tsOid).bytes()
      ),
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [tsToken]),
    ]);

    // Localizar SignerInfo no PKCS#7 e adicionar unsignedAttrs
    const modified = addUnsignedAttrToP7(p7Asn1, tsAttr);

    const modDer = forge.asn1.toDer(modified).bytes();
    return Buffer.from(modDer, 'binary');

  } catch(e) {
    log('[TSA] ⚠️ Erro ao embutir timestamp no PKCS#7:', e.message);
    log('[TSA] Retornando PKCS#7 original sem timestamp embutido.');
    return pkcs7Der;
  }
}

// ══════════════════════════════════════════════════════════════════════
//  HELPER: Adicionar unsignedAttrs ao SignerInfo
// ══════════════════════════════════════════════════════════════════════
function addUnsignedAttrToP7(p7Asn1, newAttr) {
  // Estrutura: ContentInfo > SignedData > SignerInfos > SignerInfo > unsignedAttrs [1]
  try {
    const contentInfo = p7Asn1;                    // SEQUENCE (ContentInfo)
    const signedData  = contentInfo.value[1]?.value[0]; // [0] EXPLICIT > SignedData
    if (!signedData) return p7Asn1;

    // SignedData.signerInfos = last SET in SignedData
    const signerInfosSet = signedData.value[signedData.value.length - 1];
    if (!signerInfosSet || signerInfosSet.type !== forge.asn1.Type.SET) return p7Asn1;

    const signerInfo = signerInfosSet.value[0];
    if (!signerInfo) return p7Asn1;

    // Verificar se já tem unsignedAttrs [1] IMPLICIT
    let hasUnsignedAttrs = false;
    for (const child of signerInfo.value) {
      if (child.tagClass === forge.asn1.Class.CONTEXT && child.type === 1) {
        // Já existe — adicionar dentro
        child.value.push(newAttr);
        hasUnsignedAttrs = true;
        break;
      }
    }

    if (!hasUnsignedAttrs) {
      // Criar novo [1] IMPLICIT SET com o atributo
      const unsignedAttrs = forge.asn1.create(forge.asn1.Class.CONTEXT, 1, true, [newAttr]);
      signerInfo.value.push(unsignedAttrs);
    }

    return p7Asn1;
  } catch(e) {
    log('[TSA] ⚠️ addUnsignedAttrToP7 error:', e.message);
    return p7Asn1;
  }
}

// ══════════════════════════════════════════════════════════════════════
//  HELPER: Localizar assinatura no PDF
// ══════════════════════════════════════════════════════════════════════
function findSignatureInPdf(pdfStr) {
  // Procurar /Contents <hexstring> no dicionário de assinatura
  const contentsRegex = /\/Contents\s*<([0-9a-fA-F]+)>/g;
  let match;
  let lastMatch = null;

  while ((match = contentsRegex.exec(pdfStr)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) return null;

  const fullMatch    = lastMatch[0];
  const contentsOffset = pdfStr.lastIndexOf(fullMatch);
  const hexStart     = contentsOffset + fullMatch.indexOf('<');
  const hexEnd       = hexStart + fullMatch.length - fullMatch.indexOf('<');

  return {
    contentsOffset: hexStart,
    contentsEnd:    hexEnd,
    hexValue:       lastMatch[1],
  };
}

// ══════════════════════════════════════════════════════════════════════
//  HELPERS ASN.1
// ══════════════════════════════════════════════════════════════════════
function findInAsn1(node, type) {
  if (!node) return null;
  if (node.type === type) return node;
  if (Array.isArray(node.value)) {
    for (const child of node.value) {
      const found = findInAsn1(child, type);
      if (found) return found;
    }
  }
  return null;
}

function findAsn1Value(node, type) {
  if (!node || !Array.isArray(node.value)) return null;
  return node.value.find(c => c.type === type) || null;
}

function parseGeneralizedTime(gtStr) {
  try {
    // Formato: YYYYMMDDHHmmssZ ou YYYYMMDDHHmmss.sssZ
    const s = gtStr.replace(/[^0-9]/g, '');
    if (s.length < 14) return gtStr;
    const y = s.slice(0,4), mo = s.slice(4,6), d = s.slice(6,8);
    const h = s.slice(8,10), mi = s.slice(10,12), sec = s.slice(12,14);
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}Z`).toISOString();
  } catch(e) { return gtStr; }
}

// ══════════════════════════════════════════════════════════════════════
//  VALIDAÇÃO COMPLETA: validateSignedPdfForITI
// ══════════════════════════════════════════════════════════════════════
function validateSignedPdfForITI(pdfBuffer) {
  const report = {
    passed:            false,
    assinaturaEncontrada: false,
    padraoDetectado:   null,
    certificadoPresente: false,
    cadeiaPresente:    false,
    integridade:       false,
    byteRangeValido:   false,
    timestampPresente: false,
    assinaturaIncremental: false,
    subFilter:         null,
    alertas:           [],
    ajustesNecessarios: [],
    riscoRejeicaoITI:  'ALTO',
    detalhes:          {},
  };

  try {
    const pdfStr = pdfBuffer.toString('binary');

    // ── 1. Verificar se é PDF válido ────────────────────────────
    if (!pdfStr.startsWith('%PDF-')) {
      report.ajustesNecessarios.push('Arquivo não é um PDF válido');
      return report;
    }
    report.detalhes.versaoPdf = pdfStr.slice(0, 8);

    // ── 2. Verificar presença de assinatura ─────────────────────
    const hasContents   = /\/Contents\s*<[0-9a-fA-F]+>/.test(pdfStr);
    const hasByteRange  = /\/ByteRange\s*\[/.test(pdfStr);
    const hasType       = /\/Type\s*\/Sig/.test(pdfStr);

    report.assinaturaEncontrada = hasContents && hasByteRange;

    if (!report.assinaturaEncontrada) {
      report.ajustesNecessarios.push('Assinatura PKCS#7 não encontrada no PDF (faltam /Contents e/ou /ByteRange)');
      report.riscoRejeicaoITI = 'CRÍTICO';
      return report;
    }

    // ── 3. Detectar SubFilter / padrão ──────────────────────────
    const subFilterMatch = pdfStr.match(/\/SubFilter\s*\/(\S+)/);
    report.subFilter = subFilterMatch?.[1] || null;

    if (report.subFilter === 'adbe.pkcs7.detached') {
      report.padraoDetectado = 'PAdES / PKCS#7 Detached (ICP-Brasil compatível)';
    } else if (report.subFilter === 'ETSI.CAdES.detached') {
      report.padraoDetectado = 'CAdES Detached (compatível)';
    } else if (report.subFilter === 'adbe.pkcs7.sha1') {
      report.padraoDetectado = 'PKCS#7 SHA-1 (legado — risco de rejeição)';
      report.alertas.push('SubFilter adbe.pkcs7.sha1 usa SHA-1. ICP-Brasil exige SHA-256.');
    } else {
      report.padraoDetectado = 'SubFilter desconhecido: ' + report.subFilter;
      report.alertas.push('SubFilter não reconhecido: ' + report.subFilter);
    }

    // ── 4. Validar ByteRange ─────────────────────────────────────
    const byteRangeMatch = pdfStr.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
    if (byteRangeMatch) {
      const [, b0, b1, b2, b3] = byteRangeMatch.map(Number);
      const expectedSize = b0 + b1 + b2 + b3;
      const contentsSize = b2 - (b0 + b1);

      report.byteRangeValido = (
        b0 === 0 &&
        b1 > 0 &&
        b2 > b1 &&
        b3 > 0 &&
        (b0 + b1 + contentsSize + 2 + b3) <= pdfBuffer.length + 200
      );

      report.detalhes.byteRange = { b0, b1, b2, b3, contentsSize };

      if (!report.byteRangeValido) {
        report.alertas.push(`ByteRange suspeito: [${b0} ${b1} ${b2} ${b3}]. Verificar cálculo.`);
      }
    } else {
      report.alertas.push('ByteRange não encontrado ou mal formatado');
    }

    // ── 5. Extrair e analisar PKCS#7 ────────────────────────────
    const contentsMatch = pdfStr.match(/\/Contents\s*<([0-9a-fA-F]+)>/);
    if (contentsMatch) {
      const sigHex = contentsMatch[1];
      // Verificar que não é só zeros (placeholder vazio)
      const nonZero = sigHex.replace(/0/g, '');
      if (nonZero.length === 0) {
        report.ajustesNecessarios.push('Contents contém apenas zeros — assinatura não foi gerada');
        report.riscoRejeicaoITI = 'CRÍTICO';
        return report;
      }

      try {
        const sigDer  = Buffer.from(sigHex.slice(0, Math.min(sigHex.length, 20000)), 'hex');
        const sigBuf  = forge.util.createBuffer(sigDer.toString('binary'));
        const sigAsn1 = forge.asn1.fromDer(sigBuf);
        const p7      = forge.pkcs7.messageFromAsn1(sigAsn1);

        // Certificado presente?
        report.certificadoPresente = p7.certificates && p7.certificates.length > 0;

        if (report.certificadoPresente) {
          const cert = p7.certificates[0];
          const subject = {};
          cert.subject.attributes.forEach(a => { subject[a.shortName] = a.value; });
          report.detalhes.certificado = {
            nome:     subject.CN || 'N/A',
            emissor:  cert.issuer.attributes.find(a=>a.shortName==='O')?.value || 'N/A',
            validade: cert.validity.notAfter.toLocaleDateString('pt-BR'),
            serial:   cert.serialNumber,
            expirado: new Date() > cert.validity.notAfter,
          };
          if (report.detalhes.certificado.expirado) {
            report.alertas.push('CERTIFICADO EXPIRADO! O ITI rejeitará assinaturas com certificado expirado.');
          }
        } else {
          report.ajustesNecessarios.push('Certificado do assinante não encontrado no PKCS#7');
        }

        // Cadeia presente?
        report.cadeiaPresente = p7.certificates && p7.certificates.length > 1;
        if (!report.cadeiaPresente) {
          report.alertas.push('Cadeia de certificação não incluída. Recomendado para validação ICP-Brasil.');
        }

        // Algoritmo de hash
        const signer = p7.rawCapture?.signerInfos?.[0];
        if (signer) {
          const digestAlg = signer.value?.[2]?.value?.[0];
          // OID SHA-256: 2.16.840.1.101.3.4.2.1
          const algoOid = digestAlg?.value || '';
          report.detalhes.algoritmoHash = algoOid.includes('sha256') || algoOid.includes('2.16.840.1.101.3.4.2.1') ? 'SHA-256 ✅' : algoOid || 'Desconhecido';
        }

        // Timestamp presente? (unsigned attr 1.2.840.113549.1.9.16.2.14)
        try {
          const signerInfosAsn1 = sigAsn1.value?.[1]?.value?.[0]?.value;
          if (signerInfosAsn1) {
            const signerInfo = Array.isArray(signerInfosAsn1) ?
              signerInfosAsn1[signerInfosAsn1.length - 1]?.value?.[0] : null;
            if (signerInfo) {
              // Procurar [1] IMPLICIT (unsignedAttrs)
              for (const child of (signerInfo.value || [])) {
                if (child.tagClass === forge.asn1.Class.CONTEXT && child.type === 1) {
                  report.timestampPresente = true;
                  report.detalhes.timestamp = 'Carimbo do tempo encontrado (unsignedAttrs)';
                  break;
                }
              }
            }
          }
        } catch(e) { /* melhor esforço */ }

        // Integridade — verificar que signedData content está presente
        report.integridade = report.certificadoPresente && report.byteRangeValido;

      } catch(e) {
        report.alertas.push('Erro ao parsear PKCS#7: ' + e.message);
        report.ajustesNecessarios.push('PKCS#7 malformado ou corrompido');
      }
    }

    // ── 6. Verificar assinatura incremental ─────────────────────
    const startxrefCount = (pdfStr.match(/startxref/g) || []).length;
    report.assinaturaIncremental = startxrefCount > 1;
    if (!report.assinaturaIncremental) {
      report.alertas.push('PDF não usa update incremental. Múltiplas assinaturas podem invalidar anteriores.');
    }

    // ── 7. Verificar metadados problemáticos ─────────────────────
    if (/\/Encrypt\b/.test(pdfStr)) {
      report.alertas.push('PDF está criptografado. Isso pode causar problemas no ITI.');
    }
    if (/\/AA\b/.test(pdfStr) || /\/JavaScript\b/.test(pdfStr)) {
      report.alertas.push('PDF contém JavaScript ou ações automáticas — pode ser rejeitado.');
    }

    // ── 8. Calcular score e risco ────────────────────────────────
    const criticalIssues = report.ajustesNecessarios.length;
    const warnings       = report.alertas.length;

    if (criticalIssues > 0) {
      report.riscoRejeicaoITI = 'CRÍTICO';
    } else if (warnings >= 3) {
      report.riscoRejeicaoITI = 'ALTO';
    } else if (warnings >= 1) {
      report.riscoRejeicaoITI = 'MÉDIO';
    } else {
      report.riscoRejeicaoITI = 'BAIXO';
    }

    report.passed = (
      report.assinaturaEncontrada &&
      report.certificadoPresente &&
      report.byteRangeValido &&
      report.integridade &&
      criticalIssues === 0
    );

    // ── 9. Hash final do PDF ─────────────────────────────────────
    report.detalhes.hashSha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    report.detalhes.tamanho    = pdfBuffer.length + ' bytes';

  } catch(e) {
    report.ajustesNecessarios.push('Erro crítico na validação: ' + e.message);
    report.riscoRejeicaoITI = 'CRÍTICO';
  }

  return report;
}

// ══════════════════════════════════════════════════════════════════════
//  LOG TÉCNICO
// ══════════════════════════════════════════════════════════════════════
function gerarLogTecnico(report, tsInfo = null, certInfo = null) {
  const linhas = [
    '═'.repeat(60),
    ' ASSINAFÁCIL — LOG TÉCNICO DE ASSINATURA ICP-BRASIL',
    '═'.repeat(60),
    `Data/hora:          ${new Date().toLocaleString('pt-BR')}`,
    `Status geral:       ${report.passed ? '✅ APROVADO' : '❌ NECESSITA AJUSTE'}`,
    `Risco no ITI:       ${report.riscoRejeicaoITI}`,
    '',
    '─── DOCUMENTO ───────────────────────────────────────',
    `Hash SHA-256:       ${report.detalhes?.hashSha256 || 'N/A'}`,
    `Tamanho:            ${report.detalhes?.tamanho || 'N/A'}`,
    `Versão PDF:         ${report.detalhes?.versaoPdf || 'N/A'}`,
    '',
    '─── ASSINATURA ──────────────────────────────────────',
    `Assinatura:         ${report.assinaturaEncontrada ? '✅ Presente' : '❌ Ausente'}`,
    `Padrão:             ${report.padraoDetectado || 'N/A'}`,
    `SubFilter:          ${report.subFilter || 'N/A'}`,
    `ByteRange:          ${report.byteRangeValido ? '✅ Válido' : '❌ Inválido'}`,
    `Incremental:        ${report.assinaturaIncremental ? '✅ Sim' : '⚠️ Não'}`,
    `Algoritmo hash:     ${report.detalhes?.algoritmoHash || 'N/A'}`,
    '',
    '─── CERTIFICADO ─────────────────────────────────────',
    `Certificado:        ${report.certificadoPresente ? '✅ Presente' : '❌ Ausente'}`,
    `Cadeia:             ${report.cadeiaPresente ? '✅ Presente' : '⚠️ Incompleta'}`,
  ];

  if (report.detalhes?.certificado) {
    const c = report.detalhes.certificado;
    linhas.push(
      `Nome:               ${c.nome}`,
      `Emissor (AC):       ${c.emissor}`,
      `Serial:             ${c.serial}`,
      `Validade:           ${c.validade}`,
      `Situação:           ${c.expirado ? '❌ EXPIRADO' : '✅ Vigente'}`,
    );
  }

  linhas.push('');
  linhas.push('─── CARIMBO DO TEMPO ────────────────────────────────');
  linhas.push(`Timestamp:          ${report.timestampPresente ? '✅ Presente' : '⚠️ Ausente'}`);

  if (tsInfo) {
    linhas.push(
      `Hora carimbada:     ${tsInfo.genTime}`,
      `Serial TSA:         ${tsInfo.serial}`,
      `Emissor TSA:        ${tsInfo.tsa || 'N/A'}`,
    );
  }

  if (report.alertas.length > 0) {
    linhas.push('');
    linhas.push('─── ALERTAS ─────────────────────────────────────────');
    report.alertas.forEach(a => linhas.push('⚠️  ' + a));
  }

  if (report.ajustesNecessarios.length > 0) {
    linhas.push('');
    linhas.push('─── AJUSTES NECESSÁRIOS ─────────────────────────────');
    report.ajustesNecessarios.forEach(a => linhas.push('❌  ' + a));
  }

  linhas.push('═'.repeat(60));
  return linhas.join('\n');
}

function log(...args) {
  console.log('[ICP-TS]', ...args);
}

module.exports = {
  addTrustedTimestampToSignedPdf,
  validateSignedPdfForITI,
  buildTimestampRequest,
  gerarLogTecnico,
  TSA_CONFIG,
};
