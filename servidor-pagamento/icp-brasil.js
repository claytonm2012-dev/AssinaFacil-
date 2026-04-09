/**
 * ═══════════════════════════════════════════════════════════════
 *  AssinaFácil — Assinatura Digital ICP-Brasil A1
 *  Padrão: PAdES-BES / CAdES / PKCS#7 detached embutido no PDF
 *  Compatível: Adobe Acrobat Reader, validar.iti.gov.br
 *  Nível: PRODUÇÃO — uso jurídico real
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const forge  = require('node-forge');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════
//  FUNÇÃO PRINCIPAL: signPdfWithA1
//  Recebe PDF buffer + PFX buffer + senha
//  Retorna PDF assinado em buffer (PAdES/PKCS#7 embutido)
// ═══════════════════════════════════════════════════════════════
async function signPdfWithA1(pdfBuffer, pfxBuffer, password) {

  // ── ETAPA 1: Carregar e descriptografar o .pfx ──────────────
  let p12;
  try {
    const pfxDer  = forge.util.createBuffer(pfxBuffer.toString('binary'));
    const pfxAsn1 = forge.asn1.fromDer(pfxDer);
    p12 = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, false, password);
  } catch (e) {
    if (e.message && e.message.includes('PKCS#12')) {
      throw new Error('Senha incorreta para o certificado .pfx');
    }
    throw new Error('Certificado inválido ou corrompido: ' + e.message);
  }

  // ── ETAPA 2: Extrair chave privada e certificados ───────────
  const bags = {
    key:  p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag],
    cert: p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag],
  };

  // Tentar também keyBag simples
  if (!bags.key || bags.key.length === 0) {
    const keyBags = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag];
    if (keyBags && keyBags.length > 0) bags.key = keyBags;
  }

  if (!bags.key || bags.key.length === 0) throw new Error('Chave privada não encontrada no .pfx');
  if (!bags.cert || bags.cert.length === 0) throw new Error('Certificado não encontrado no .pfx');

  const privateKey  = bags.key[0].key;
  const certificate = bags.cert[0].cert;

  // ── ETAPA 3: Validar certificado ────────────────────────────
  const now = new Date();
  if (now < certificate.validity.notBefore) throw new Error('Certificado ainda não é válido');
  if (now > certificate.validity.notAfter)  throw new Error('Certificado expirado em ' + certificate.validity.notAfter.toLocaleDateString('pt-BR'));

  // ── ETAPA 4: Montar cadeia de certificação ──────────────────
  const certChain = [];
  bags.cert.forEach(bag => { if (bag.cert) certChain.push(bag.cert); });

  // ── ETAPA 5: Preparar estrutura PAdES no PDF ────────────────
  // Reservar 65536 bytes para a assinatura PKCS#7 (suficiente para A1)
  const PLACEHOLDER = 65536;
  const pdfStr      = pdfBuffer.toString('binary');

  // Verificar PDF válido
  if (!pdfStr.startsWith('%PDF')) throw new Error('Arquivo inválido: não é um PDF');

  // ── ETAPA 6: Construir o PDF com slot de assinatura ─────────
  const { pdfWithSlot, byteRange, slotOffset } = buildPdfWithSignatureSlot(pdfStr, PLACEHOLDER);

  // ── ETAPA 7: Calcular hash SHA-256 dos bytes assinados ──────
  // ByteRange define quais bytes do PDF são cobertos pela assinatura
  // (tudo EXCETO o conteúdo do /Contents)
  const part1 = Buffer.from(pdfWithSlot, 'binary').slice(byteRange[0], byteRange[0] + byteRange[1]);
  const part2 = Buffer.from(pdfWithSlot, 'binary').slice(byteRange[2], byteRange[2] + byteRange[3]);
  const signedBytes = Buffer.concat([part1, part2]);

  const hash = crypto.createHash('sha256').update(signedBytes).digest();

  // ── ETAPA 8: Construir CMS SignedData (PKCS#7) ──────────────
  const p7 = forge.pkcs7.createSignedData();

  // Conteúdo vazio para PAdES detached
  p7.content = forge.util.createBuffer();

  // Adicionar todos os certificados da cadeia
  certChain.forEach(cert => p7.addCertificate(cert));

  // Data de assinatura
  const signingTime = new Date();

  // Atributos autenticados (obrigatórios para PAdES-BES)
  const authenticatedAttributes = [
    {
      type:  forge.pki.oids.contentType,
      value: forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false,
        forge.asn1.oidToDer(forge.pki.oids.data).bytes())
    },
    {
      type:  forge.pki.oids.signingTime,
      value: forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.UTCTIME, false,
        forge.util.encode64(signingTime.toISOString()))
    },
    {
      // messageDigest = hash SHA-256 do conteúdo
      type: forge.pki.oids.messageDigest,
      value: forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false,
        hash.toString('binary'))
    },
  ];

  p7.addSigner({
    key:         privateKey,
    certificate: certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes,
  });

  // ── ETAPA 9: Assinar ────────────────────────────────────────
  // Usar sign com detached=true para PAdES
  p7.sign({ detached: true });

  // ── ETAPA 10: Serializar CMS para DER → HEX ─────────────────
  const p7Asn1     = p7.toAsn1();
  const p7Der      = forge.asn1.toDer(p7Asn1).bytes();
  const p7Hex      = Buffer.from(p7Der, 'binary').toString('hex').toUpperCase();

  if (p7Hex.length > PLACEHOLDER) {
    throw new Error(
      `Assinatura PKCS#7 muito grande: ${p7Hex.length} bytes hex > ${PLACEHOLDER} reservados. ` +
      `Aumente PLACEHOLDER ou reduza a cadeia de certificação.`
    );
  }

  // Preencher com zeros à direita para manter ByteRange correto
  const p7HexPadded = p7Hex.padEnd(PLACEHOLDER, '0');

  // ── ETAPA 11: Substituir slot pela assinatura real ───────────
  const marker = '<' + '0'.repeat(PLACEHOLDER) + '>';
  const pdfFinal = pdfWithSlot.replace(marker, '<' + p7HexPadded + '>');

  if (pdfFinal === pdfWithSlot) {
    throw new Error('Falha ao inserir assinatura: slot não encontrado no PDF');
  }

  // ── ETAPA 12: Limpar dados sensíveis da memória ─────────────
  try {
    if (privateKey) {
      // Sobrescrever propriedades da chave
      ['d','p','q','dP','dQ','qInv'].forEach(k => {
        if (privateKey[k]) privateKey[k] = forge.jsbn.BigInteger.ZERO;
      });
    }
  } catch(e) { /* best effort */ }

  const signedBuffer = Buffer.from(pdfFinal, 'binary');

  // Retornar hash SHA-256 do PDF original (para auditoria)
  const docHash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

  return {
    pdfBuffer: signedBuffer,
    hash:      docHash,
    certInfo:  extractCertInfo(certificate),
    signedAt:  signingTime.toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════
//  buildPdfWithSignatureSlot
//  Adiciona estrutura PAdES ao PDF (xref incremental)
//  Retorna o PDF com slot + ByteRange calculado
// ═══════════════════════════════════════════════════════════════
function buildPdfWithSignatureSlot(pdfStr, placeholder) {
  const PLACEHOLDER = placeholder;

  // ── Encontrar o último objeto no PDF ──
  const nextObj = getNextObjNumber(pdfStr);
  const sigObjN = nextObj;
  const annObjN = nextObj + 1;

  // ── Data no formato PDF ──
  const dateStr = toPdfDate(new Date());

  // ── Localizar Root e última xref ──
  const rootRef       = extractRootRef(pdfStr);
  const lastXref      = extractLastXref(pdfStr);
  const existingObjs  = countObjects(pdfStr);

  // ── Posição base = fim do PDF atual (antes do marcador %%EOF que removeremos) ──
  // Mantemos o PDF original intacto até o %%EOF e adicionamos incrementalmente
  const eofIdx    = pdfStr.lastIndexOf('%%EOF');
  const pdfBase   = pdfStr.slice(0, eofIdx + 5); // inclui %%EOF original

  // ── Montar objeto de assinatura (sig obj) ──
  // Primeiro passo: calcular tamanho para ByteRange
  const sigObjPrefix =
    `\n${sigObjN} 0 obj\n` +
    `<<\n` +
    `/Type /Sig\n` +
    `/Filter /Adobe.PPKLite\n` +
    `/SubFilter /adbe.pkcs7.detached\n` +
    `/ByteRange [`;

  // ByteRange terá formato: [0 XXXXXXXX YYYYYYYYYY ZZZZZZZZZZ]
  // com padding para manter tamanho fixo (não alterar offsets)
  const BR_PAD = 12; // dígitos com padding
  const byteRangePlaceholder = `[${' '.repeat(BR_PAD)} ${' '.repeat(BR_PAD)} ${' '.repeat(BR_PAD)} ${' '.repeat(BR_PAD)}]`;
  const byteRangeFixed       = `[0000000000 ${' '.repeat(BR_PAD)} ${' '.repeat(BR_PAD)} ${' '.repeat(BR_PAD)}]`;

  const sigObjMiddle =
    `]\n` +
    `/Contents <${'0'.repeat(PLACEHOLDER)}>\n` +
    `/M (${dateStr})\n` +
    `/Reason (Assinado digitalmente com certificado ICP-Brasil A1 via AssinaFacil)\n` +
    `/Location (Brasil)\n` +
    `/ContactInfo (assinafacilweb@gmail.com)\n` +
    `>>\nendobj\n`;

  // ── Objeto de anotação widget (invisível) ──
  const annObj =
    `\n${annObjN} 0 obj\n` +
    `<<\n` +
    `/Type /Annot\n` +
    `/Subtype /Widget\n` +
    `/FT /Sig\n` +
    `/Rect [0 0 0 0]\n` +
    `/V ${sigObjN} 0 R\n` +
    `/T (Signature1)\n` +
    `/F 132\n` +
    `/P 1 0 R\n` +
    `>>\nendobj\n`;

  // ── Calcular offsets reais ──
  const baseLen       = pdfBase.length;
  const sigObjOffset  = baseLen;

  // Texto completo do objeto de assinatura COM o byterange placeholder
  const byteRangeStr_phase1 = `/ByteRange [0000000000 0000000000 0000000000 0000000000]`;

  const sigObjFull_phase1 =
    `\n${sigObjN} 0 obj\n` +
    `<<\n` +
    `/Type /Sig\n` +
    `/Filter /Adobe.PPKLite\n` +
    `/SubFilter /adbe.pkcs7.detached\n` +
    `${byteRangeStr_phase1}\n` +
    `/Contents <${'0'.repeat(PLACEHOLDER)}>\n` +
    `/M (${dateStr})\n` +
    `/Reason (Assinado digitalmente com certificado ICP-Brasil A1 via AssinaFacil)\n` +
    `/Location (Brasil)\n` +
    `/ContactInfo (assinafacilweb@gmail.com)\n` +
    `>>\nendobj\n`;

  const annObjOffset = sigObjOffset + sigObjFull_phase1.length;

  // ── xref incremental ──
  const xrefOffset = annObjOffset + annObj.length;

  // Número de objetos novos = 2 (sigObj + annObj)
  // +1 objeto especial (0 65535 f) se ainda não existe
  const xrefStr =
    `xref\n` +
    `${sigObjN} 2\n` +
    `${String(sigObjOffset + 1).padStart(10,'0')} 00000 n \n` +  // +1 pelo \n inicial
    `${String(annObjOffset + 1).padStart(10,'0')} 00000 n \n`;

  const trailer =
    `trailer\n` +
    `<<\n` +
    `/Size ${annObjN + 1}\n` +
    `/Root ${rootRef}\n` +
    `/Prev ${lastXref}\n` +
    `>>\n` +
    `startxref\n` +
    `${xrefOffset}\n` +
    `%%EOF\n`;

  // ── Montar PDF com slot ──
  const pdfWithSlot = pdfBase + sigObjFull_phase1 + annObj + xrefStr + trailer;

  // ── Calcular ByteRange real ──
  // byteRange[0] = 0 (início)
  // byteRange[1] = posição do '<' do /Contents
  const contentsTag   = `/Contents <${'0'.repeat(PLACEHOLDER)}>`;
  const contentsStart = pdfWithSlot.indexOf(contentsTag);
  if (contentsStart === -1) throw new Error('Tag /Contents não encontrada após montagem');

  const br0 = 0;
  const br1 = contentsStart + `/Contents <`.length;                    // posição do '<'
  const br2 = br1 + 1 + PLACEHOLDER + 1;                              // após '>' fechando
  const br3 = pdfWithSlot.length - br2;

  // ── Substituir byterange placeholder pelo valor real ──
  const byteRangeReal = `/ByteRange [${String(br0).padStart(10,'0')} ${String(br1).padStart(10,'0')} ${String(br2).padStart(10,'0')} ${String(br3).padStart(10,'0')}]`;
  const pdfFinal      = pdfWithSlot.replace(byteRangeStr_phase1, byteRangeReal);

  // Verificar que o byterange foi substituído
  if (pdfFinal === pdfWithSlot) throw new Error('Falha ao inserir ByteRange no PDF');

  return {
    pdfWithSlot: pdfFinal,
    byteRange:   [br0, br1, br2, br3],
    slotOffset:  contentsStart,
  };
}

// ═══════════════════════════════════════════════════════════════
//  getCertInfo — lê informações do certificado .pfx
// ═══════════════════════════════════════════════════════════════
function getCertInfo(pfxBuffer, password) {
  try {
    const pfxDer  = forge.util.createBuffer(pfxBuffer.toString('binary'));
    const pfxAsn1 = forge.asn1.fromDer(pfxDer);
    const p12     = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, false, password);
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
    if (!certBags || certBags.length === 0) return null;

    const cert = certBags[0].cert;
    return extractCertInfo(cert);
  } catch (e) {
    if (e.message && (e.message.includes('PKCS#12') || e.message.includes('padding'))) {
      throw new Error('Senha incorreta');
    }
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════
function extractCertInfo(cert) {
  const subject = {};
  cert.subject.attributes.forEach(a => { subject[a.shortName || a.type] = a.value; });

  const issuer = {};
  cert.issuer.attributes.forEach(a => { issuer[a.shortName || a.type] = a.value; });

  return {
    nome:      subject['CN'] || 'Desconhecido',
    cpf:       extractCpfFromCert(cert),
    validade:  cert.validity.notAfter.toLocaleDateString('pt-BR'),
    expirado:  new Date() > cert.validity.notAfter,
    emissor:   issuer['O'] || issuer['CN'] || 'AC ICP-Brasil',
    serial:    cert.serialNumber,
    tipo:      detectCertType(cert),
  };
}

function extractCpfFromCert(cert) {
  try {
    // ICP-Brasil coloca CPF na SAN OID 2.16.76.1.3.1
    const ext = cert.getExtension({ id: '2.5.29.17' }); // subjectAltName
    if (ext) {
      const sanStr = JSON.stringify(ext);
      const cpfMatch = sanStr.match(/\d{11}/);
      if (cpfMatch) {
        return cpfMatch[0].replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
      }
    }
    // Fallback: buscar no CN
    const cn = cert.subject.attributes.find(a => a.shortName === 'CN')?.value || '';
    const cpfInCN = cn.match(/\d{11}/);
    if (cpfInCN) return cpfInCN[0].replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    return null;
  } catch(e) { return null; }
}

function detectCertType(cert) {
  const cn = cert.subject.attributes.find(a => a.shortName === 'CN')?.value || '';
  if (cn.includes('A1') || cert.validity.notAfter - cert.validity.notBefore < 366 * 24 * 3600 * 1000) {
    return 'A1';
  }
  return 'A3';
}

function toPdfDate(d) {
  const p = n => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const tzSign = tz >= 0 ? '+' : '-';
  const tzH = p(Math.floor(Math.abs(tz) / 60));
  const tzM = p(Math.abs(tz) % 60);
  return `D:${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${tzSign}${tzH}'${tzM}'`;
}

function getNextObjNumber(pdfStr) {
  const matches = [...pdfStr.matchAll(/^(\d+)\s+\d+\s+obj\b/gm)];
  if (matches.length === 0) return 10;
  return Math.max(...matches.map(m => parseInt(m[1]))) + 1;
}

function extractRootRef(pdfStr) {
  const m = pdfStr.match(/\/Root\s+(\d+\s+\d+\s+R)/);
  return m ? m[1] : '1 0 R';
}

function extractLastXref(pdfStr) {
  const m = pdfStr.match(/startxref\s+(\d+)\s+%%EOF/);
  return m ? parseInt(m[1]) : 0;
}

function countObjects(pdfStr) {
  const matches = pdfStr.match(/^\d+\s+\d+\s+obj\b/gm);
  return matches ? matches.length : 0;
}

module.exports = { signPdfWithA1, getCertInfo };
