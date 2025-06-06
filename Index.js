const fs = require('fs');
const path = require('path');
const { Client, NoAuth, MessageMedia } = require('whatsapp-web.js'); // Mudança aqui
const qrcode = require('qrcode-terminal');
const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');
const mysql = require('mysql2/promise');
const ExcelJS = require('exceljs');

const dbConfig = {
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: parseInt(process.env.MYSQLPORT || '3306')
};

const tempDir = path.join(__dirname, 'temp_files');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

const client = new Client({
  authStrategy: new NoAuth(), // Mudança aqui para não salvar sessão
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ Bot pronto e conectado ao WhatsApp!'));
client.on('auth_failure', msg => console.error('❌ Falha na autenticação:', msg));

const userState = {};

function extrairNomesPorBanco(texto) {
  const linhas = texto.split('\n').map(l => l.trim().replace(/\s+/g, ' ')).filter(Boolean);
  let nomeDestinatario = 'Nome Destinatário Não Encontrado';
  let nomeRemetente = 'Nome Remetente Não Encontrado';
  const isCaixa = /CAIXA ECONÔMICA FEDERAL/i.test(texto) || /Comprovante de Pix enviado\s*CAIXA/i.test(linhas[0] || '') || /CAIXA/i.test(linhas[0] || '');
  if (isCaixa) {
    let idxRecebedorLabel = linhas.findIndex(l => /Dados do recebedor/i.test(l));
    if (idxRecebedorLabel !== -1) {
        for (let i = idxRecebedorLabel + 1; i < linhas.length; i++) {
            if (/^Nome$/i.test(linhas[i]) && linhas[i+1]) { nomeDestinatario = linhas[i+1]; break; }
            if (i === idxRecebedorLabel + 1 && linhas[i] && !/CPF|CNPJ|Instituiç/i.test(linhas[i])) {
                 nomeDestinatario = linhas[i];
                 if (linhas[i+1] && !/CPF|CNPJ|Instituiç/i.test(linhas[i+1])) { nomeDestinatario += ' ' + linhas[i+1];}
                 break;
            }
        }
    }
    let idxPagadorLabel = linhas.findIndex(l => /Dados do pagador/i.test(l));
    if (idxPagadorLabel !== -1) {
         for (let i = idxPagadorLabel + 1; i < linhas.length; i++) {
            if (/^Nome$/i.test(linhas[i]) && linhas[i+1]) { nomeRemetente = linhas[i+1]; break; }
            if (i === idxPagadorLabel + 1 && linhas[i] && !/CPF|CNPJ|Instituiç/i.test(linhas[i])) {
                 nomeRemetente = linhas[i];
                 if (linhas[i+1] && !/CPF|CNPJ|Instituiç/i.test(linhas[i+1])) { nomeRemetente += ' ' + linhas[i+1]; }
                 break;
            }
        }
    }
    if (nomeDestinatario === 'Nome Destinatário Não Encontrado' || nomeRemetente === 'Nome Remetente Não Encontrado') {
        const genericResult = extrairNomesGenerico(linhas);
        if (nomeDestinatario === 'Nome Destinatário Não Encontrado') nomeDestinatario = genericResult.nomeDestinatario;
        if (nomeRemetente === 'Nome Remetente Não Encontrado') nomeRemetente = genericResult.nomeRemetente;
    }
    return { nomeDestinatario, nomeRemetente };
  }
  if (/Bradesco/i.test(texto)) {
    const idxPagou = linhas.findIndex(l => /Dados de quem pagou/i.test(l));
    if (idxPagou !== -1 && linhas[idxPagou + 1]) nomeRemetente = linhas[idxPagou + 1];
    const idxRecebeu = linhas.findIndex(l => /Dados de quem recebeu/i.test(l));
    if (idxRecebeu !== -1 && linhas[idxRecebeu + 1]) nomeDestinatario = linhas[idxRecebeu + 1];
    return { nomeDestinatario, nomeRemetente };
  }
  if (/Banco do Brasil|BB/i.test(texto)) {
    const idxRecebedor = linhas.findIndex(l => /Recebedor|Beneficiário/i.test(l));
    if (idxRecebedor !== -1 && linhas[idxRecebedor + 1]) nomeDestinatario = linhas[idxRecebedor + 1];
    const idxPagador = linhas.findIndex(l => /Pagador/i.test(l));
    if (idxPagador !== -1 && linhas[idxPagador + 1]) nomeRemetente = linhas[idxPagador + 1];
    return { nomeDestinatario, nomeRemetente };
  }
  if (/Nu Pagamentos S\.A|Nubank|nu pagamentos/i.test(texto)) {
    const idxDestino = linhas.findIndex(l => /Destino|Enviado para/i.test(l));
    if (idxDestino !== -1 && linhas[idxDestino + 1]) nomeDestinatario = linhas[idxDestino + 1];
    const idxOrigem = linhas.findIndex(l => /Origem|Transferido de/i.test(l));
    if (idxOrigem !== -1 && linhas[idxOrigem + 1]) nomeRemetente = linhas[idxOrigem + 1];
    return { nomeDestinatario, nomeRemetente };
  }
  return extrairNomesGenerico(linhas, nomeDestinatario, nomeRemetente);
}
function extrairNomesGenerico(linhas, destJaEncontrado = 'Nome Destinatário Não Encontrado', remJaEncontrado = 'Nome Remetente Não Encontrado') {
    let nomeDestinatario = destJaEncontrado; let nomeRemetente = remJaEncontrado;
    linhas.forEach(linha => {
        if (nomeDestinatario === 'Nome Destinatário Não Encontrado' && /Favorecido|Benefici\u00e1rio|Destinatário|Recebedor|Para:/i.test(linha)) {
            const parts = linha.split(/[:\-]/); if (parts.length > 1) nomeDestinatario = parts.slice(1).join(':').trim();
        }
        if (nomeRemetente === 'Nome Remetente Não Encontrado' && /Pagador|Remetente|De:/i.test(linha)) {
            const parts = linha.split(/[:\-]/); if (parts.length > 1) nomeRemetente = parts.slice(1).join(':').trim();
        }
    });
    return { nomeDestinatario, nomeRemetente };
}
function validarComprovante(texto) {
    const palavrasChave = ['caixa', 'bradesco', 'banco do brasil', 'nubank', 'transferência', 'comprovante', 'pagador', 'favorecido', 'beneficiário', 'pix enviado', 'comprovante de pagamento', 'valor', 'data'];
    texto = texto.toLowerCase();
    return palavrasChave.some(palavra => texto.includes(palavra));
}
function extrairData(texto) {
    let match = texto.match(/\b(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})\b/);
    if (match) { let dia = match[1].padStart(2, '0'); let mes = match[2].padStart(2, '0'); let ano = match[3]; if (ano.length === 2) ano = `20${ano}`; return `${ano}-${mes}-${dia}`; }
    match = texto.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); if (match) return match[0];
    const linhas = texto.split('\n');
    for (const linha of linhas) {
        if (/data da transa|data do pag|data:/i.test(linha)) {
            match = linha.match(/\b(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4})\b/);
            if (match && match[0]) { const subMatch = match[0].match(/\b(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})\b/);
                if (subMatch) { let dia = subMatch[1].padStart(2, '0'); let mes = subMatch[2].padStart(2, '0'); let ano = subMatch[3]; if (ano.length === 2) ano = `20${ano}`; return `${ano}-${mes}-${dia}`; }
            }
            match = linha.match(/\b(\d{4}-\d{2}-\d{2})\b/); if (match) return match[0];
        }
    }
    console.log("Data não encontrada OCR, usando data atual."); return new Date().toISOString().slice(0, 10);
}
function extrairValor(texto) {
    const valorRegexGlobal = /R\$\s*([\d\.,]+)|VALOR\s*[:\-]?\s*R?\$\s*([\d\.,]+)|Valor\s*Transferido\s*[:\-]?\s*R?\$\s*([\d\.,]+)|([\d\.]*\d,\d{2})\b/gi;
    let matches; let valorNumerico = 0;
    while((matches = valorRegexGlobal.exec(texto)) !== null) {
        const valorStringComSimbolo = matches[1] || matches[2] || matches[3] || matches[4];
        if (valorStringComSimbolo) { const valorLimpo = valorStringComSimbolo.replace(/\.(?!\d{2}$)/g, '').replace(',', '.'); const tempValor = parseFloat(valorLimpo);
            if (!isNaN(tempValor) && tempValor > 0) { if (tempValor > valorNumerico) valorNumerico = tempValor; }
        }
    }
    if (valorNumerico > 0) return valorNumerico;
    const fallbackMatch = texto.match(/([\d]+[\.,]\d{2})\b/);
     if(fallbackMatch && fallbackMatch[1]){ const valorString = fallbackMatch[1].replace(/\.(?!\d{2}$)/g, '').replace(',', '.'); const tempValor = parseFloat(valorString);
        if (!isNaN(tempValor) && tempValor > 0) return tempValor;
     }
    console.log("Valor não encontrado OCR, retornando 0."); return 0;
}
function guessMimeTypeAndExtension(buffer) {
    if (!buffer || buffer.length < 4) { return { mimetype: 'application/octet-stream', extension: 'dat' }; }
    const bytes = buffer.toString('hex', 0, 8).toUpperCase();
    if (bytes.startsWith('25504446')) { return { mimetype: 'application/pdf', extension: 'pdf' }; }
    if (bytes.startsWith('89504E470D0A1A0A')) { return { mimetype: 'image/png', extension: 'png' }; }
    if (bytes.startsWith('FFD8FF')) { return { mimetype: 'image/jpeg', extension: 'jpg' }; }
    console.log(`Tipo arquivo não identificado (bytes: ${bytes.substring(0,16)}), usando genérico.`);
    return { mimetype: 'application/octet-stream', extension: 'dat' };
}

client.on('message', async msg => {
  const senderId = msg.from;
  const chat = await msg.getChat();
  const bodyLower = msg.body.toLowerCase().trim();
  const originalBody = msg.body.trim();

  if (userState[senderId]) {
    const state = userState[senderId];
    if (state.step === 'awaiting_observation') {
        const observationChoice = originalBody;
        if (observationChoice === '1') { await chat.sendMessage('Por favor, envie o texto da observação.'); userState[senderId].step = 'awaiting_observation_text';
        } else if (observationChoice === '2') { state.data.observacao = null; await salvarNoBanco(state.data, chat); delete userState[senderId];
        } else if (observationChoice === '3') { await chat.sendMessage('❌ Armazenamento cancelado.'); delete userState[senderId];
        } else { await chat.sendMessage('Opção inválida. Por favor, responda com 1, 2 ou 3.'); }
        return;
    }
    if (state.step === 'awaiting_observation_text') {
        state.data.observacao = originalBody; await salvarNoBanco(state.data, chat); delete userState[senderId]; return;
    }
    if (state.step === 'awaiting_apaga_confirmation') {
        if (bodyLower === '!apaga confirmar') {
            let connection;
            try { connection = await mysql.createConnection(dbConfig); await connection.execute('DELETE FROM transferencias'); await chat.sendMessage('✅ Todos os comprovantes foram apagados.');
            } catch (error) { console.error('Erro ao apagar:', error); await chat.sendMessage('❌ Erro ao apagar.');
            } finally { if (connection) await connection.end(); delete userState[senderId]; }
        } else { await chat.sendMessage('Confirmação inválida. Operação cancelada.'); delete userState[senderId]; }
        return;
    }
    if (state.step === 'awaiting_tirar_confirmation') {
        if (bodyLower === '!tirar confirmar' && state.lastId) {
            let connection;
            try { connection = await mysql.createConnection(dbConfig); await connection.execute('DELETE FROM transferencias WHERE idtransferencias = ?', [state.lastId]); await chat.sendMessage(`✅ ID ${state.lastId} removido.`);
            } catch (error) { console.error('Erro ao remover:', error); await chat.sendMessage('❌ Erro ao remover.');
            } finally { if (connection) await connection.end(); delete userState[senderId]; }
        } else { await chat.sendMessage('Confirmação inválida. Operação cancelada.'); delete userState[senderId]; }
        return;
    }
    if (state.step === 'awaiting_colocar_data') {
        const textInput = originalBody; const lines = textInput.split('\n'); const dataInput = {}; let errors = [];
        const expectedKeys = {
            'data': (val) => { if (!val || !val.match(/^\d{4}-\d{2}-\d{2}$/)) { errors.push("Data: formato AAAA-MM-DD obrigatório."); return null; } return val; },
            'tipo de gasto': (val) => {if(!val) { errors.push("Tipo de gasto: obrigatório."); return null;} return val; },
            'remetente': (val) => val || "N/A (Manual)",
            'destinatario': (val) => {if(!val) { errors.push("Destinatário: obrigatório."); return null;} return val; },
            'valor': (val) => { const numVal = parseFloat(String(val).replace(',', '.')); if (isNaN(numVal) || numVal <= 0) { errors.push("Valor: número positivo inválido."); return null; } return numVal; },
            'obs': (val) => val || null
        };
        const dbKeysMapping = { 'data': 'data_transferencia', 'tipo de gasto': 'tipo_gasto', 'remetente': 'nome_remetente', 'destinatario': 'nome_destinatario', 'valor': 'valor', 'obs': 'observacao' };
        const requiredFieldsForCheck = ['data_transferencia', 'tipo_gasto', 'nome_destinatario', 'valor'];
        lines.forEach(line => {
            const parts = line.split(':');
            if (parts.length >= 2) {
                const key = parts[0].trim().toLowerCase(); const value = parts.slice(1).join(':').trim();
                if (expectedKeys[key]) { const processedValue = expectedKeys[key](value); if (processedValue !== null || key === 'obs') { dataInput[dbKeysMapping[key]] = processedValue; }}
            }
        });
        for(const reqKey of requiredFieldsForCheck) { if(dataInput[reqKey] === null || dataInput[reqKey] === undefined) { if(!errors.some(e => e.toLowerCase().includes(reqKey.replace('_', ' ').split(' ')[0]))) { errors.push(`Campo ${reqKey.replace('_', ' ')} obrigatório/inválido.`);}}}
        if (errors.length > 0) { await chat.sendMessage("❌ Erros:\n- " + errors.join("\n- ") + "\n\nTente `!colocar` novamente.");
        } else { dataInput.arquivo = null; await salvarNoBanco(dataInput, chat); }
        delete userState[senderId]; return;
    }
  }
  
  if (bodyLower.startsWith('!armazenar')) {
    if (!msg.hasQuotedMsg) { return chat.sendMessage('⚠️ Use `!armazenar [tipo]` respondendo a uma mídia.'); }
    const quotedMsg = await msg.getQuotedMessage(); if (!quotedMsg.hasMedia) { return chat.sendMessage('❌ Mensagem marcada não tem mídia.');}
    const commandParts = originalBody.split(' '); const tipoGasto = commandParts.length > 1 ? commandParts.slice(1).join(' ') : 'Não especificado';
    try {
      const media = await quotedMsg.downloadMedia(); if (!media) return chat.sendMessage('❌ Falha ao baixar mídia.');
      const fileBuffer = Buffer.from(media.data, 'base64');
      let tempExtension = 'dat';
      if (media.mimetype) {
          if (media.mimetype.includes('pdf')) tempExtension = 'pdf';
          else if (media.mimetype.includes('png')) tempExtension = 'png';
          else if (media.mimetype.includes('jpeg') || media.mimetype.includes('jpg')) tempExtension = 'jpg';
      }
      const tempFilename = `comprovante_temp_${Date.now()}.${tempExtension}`;
      const tempFilePath = path.join(tempDir, tempFilename);
      fs.writeFileSync(tempFilePath, fileBuffer);
      let textoExtraido = '';
      if (media.mimetype && media.mimetype.includes('pdf')) { const dataBuffer = fs.readFileSync(tempFilePath); const pdfData = await pdfParse(dataBuffer); textoExtraido = pdfData.text;
      } else if (media.mimetype && media.mimetype.includes('image')) { const result = await Tesseract.recognize(tempFilePath, 'por', { logger: m => {} }); textoExtraido = result.data.text;
      } else { fs.unlinkSync(tempFilePath); return chat.sendMessage('❌ Tipo de arquivo não suportado. Envie PDF ou imagem.'); }
      fs.unlinkSync(tempFilePath);
      if (!textoExtraido.trim()) { console.log("OCR não extraiu texto."); return chat.sendMessage("❌ Não foi possível extrair texto."); }
      const { nomeDestinatario, nomeRemetente } = extrairNomesPorBanco(textoExtraido);
      const valor = extrairValor(textoExtraido); 
      const dataTransferencia = extrairData(textoExtraido);
      const dadosParaSalvar = { nome_remetente: nomeRemetente, nome_destinatario: nomeDestinatario, valor: valor, data_transferencia: dataTransferencia, tipo_gasto: tipoGasto, arquivo: fileBuffer, observacao: null };
      userState[senderId] = { step: 'awaiting_observation', data: dadosParaSalvar };
      await chat.sendMessage( `🧾 Dados OCR:\nRem: ${nomeRemetente}\nDest: ${nomeDestinatario}\nVal: R$ ${valor.toFixed(2)}\nData: ${dataTransferencia}\nTipo: ${tipoGasto}\n\nCorreto? Add Obs?\n1-Sim, add obs\n2-Sim, salvar s/ obs\n3-Não, cancelar`);
    } catch (error) { console.error('Erro !armazenar:', error); await chat.sendMessage('❌ Erro ao processar comprovante.'); if (userState[senderId]) delete userState[senderId];}
    return;
  }
  if (bodyLower === '!colocar') {
    const moldeTexto = "Copie, preencha e envie:\n\n```\ndata: AAAA-MM-DD\ntipo de gasto: [descrição]\nremetente: [quem pagou ou N/A]\ndestinatario: [quem recebeu]\nvalor: [ex: 150.00]\nobs: [opcional]\n```";
    userState[senderId] = { step: 'awaiting_colocar_data' }; await chat.sendMessage(moldeTexto); return;
  }
  if (bodyLower === '!extrato') {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [dbRows] = await connection.execute('SELECT idtransferencias, data_transferencia, tipo_gasto, nome_remetente, nome_destinatario, valor, observação FROM transferencias ORDER BY data_transferencia ASC, idtransferencias ASC');
      if (dbRows.length === 0) { return chat.sendMessage('ℹ️ Nenhum comprovante para extrato.');}
      const workbook = new ExcelJS.Workbook(); workbook.creator = 'Bot'; const worksheet = workbook.addWorksheet('LANÇAMENTOS');
      worksheet.columns = [
        { header: 'DATA', key: 'data_col', width: 12, style: { numFmt: 'dd/mm/yyyy;@' } },
        { header: 'TIPO DE GASTO', key: 'tipo_gasto_col', width: 30 }, { header: 'REMETENTE', key: 'remetente_col', width: 30 },
        { header: 'DESTINATARIO', key: 'destinatario_col', width: 30 }, { header: 'VALOR', key: 'valor_col', width: 15, style: { numFmt: '"R$"#,##0.00' } },
        { header: 'OBS', key: 'obs_col', width: 40 }, { header: 'TOTAL', key: 'total_col', width: 15, style: { numFmt: '"R$"#,##0.00' } }
      ];
      const headerRow = worksheet.getRow(1); headerRow.font = { bold: true }; headerRow.fill = { type: 'pattern', pattern:'solid', fgColor:{argb:'FFD9D9D9'} }; headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
      let runningTotal = 0;
      dbRows.forEach(dbRowData => {
        const valorTransacao = parseFloat(dbRowData.valor) || 0; runningTotal += valorTransacao;
        let dataParaExcel = null; const dataDoBanco = dbRowData.data_transferencia;
        if (dataDoBanco) {
            if (dataDoBanco instanceof Date && !isNaN(dataDoBanco)) { dataParaExcel = dataDoBanco; } 
            else if (typeof dataDoBanco === 'string' && dataDoBanco.match(/^\d{4}-\d{2}-\d{2}$/)) { dataParaExcel = new Date(dataDoBanco + 'T00:00:00Z'); } 
            else { console.warn(`[EXTRATO] Formato data inesperado BD->Excel: '${dataDoBanco}' (tipo: ${typeof dataDoBanco}) ID: ${dbRowData.idtransferencias}`);}
        }
        worksheet.addRow({ data_col: dataParaExcel, tipo_gasto_col: dbRowData.tipo_gasto, remetente_col: dbRowData.nome_remetente, destinatario_col: dbRowData.nome_destinatario, valor_col: valorTransacao, obs_col: dbRowData.observação, total_col: runningTotal });
      });
      worksheet.columns.forEach(column => { /* código de ajuste de largura opcional */ });
      const tempExcelPath = path.join(tempDir, `extrato_${Date.now()}.xlsx`); await workbook.xlsx.writeFile(tempExcelPath);
      const mediaFile = MessageMedia.fromFilePath(tempExcelPath); await chat.sendMessage(mediaFile, { caption: 'Segue o extrato.' });
      fs.unlinkSync(tempExcelPath);
    } catch (error) { console.error('Erro extrato:', error); await chat.sendMessage('❌ Erro ao gerar extrato.');
    } finally { if (connection) await connection.end(); }
    return;
  }
  if (bodyLower === '!apaga') { userState[senderId] = { step: 'awaiting_apaga_confirmation' }; await chat.sendMessage( '⚠️ *ATENÇÃO!* Apagará TUDO.\nIrreversível.\n\nConfirme: `!apaga confirmar`\nCancelar: outra msg.'); return; }
  if (bodyLower === '!tirar') {
    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute('SELECT idtransferencias, data_transferencia, nome_remetente, valor FROM transferencias ORDER BY idtransferencias DESC LIMIT 1');
        if (rows.length > 0) { const lastEntry = rows[0]; userState[senderId] = { step: 'awaiting_tirar_confirmation', lastId: lastEntry.idtransferencias };
            let dataExibicao = 'N/A'; const dataDoBancoTirar = lastEntry.data_transferencia;
            if (dataDoBancoTirar) {
                if (dataDoBancoTirar instanceof Date && !isNaN(dataDoBancoTirar)) { dataExibicao = dataDoBancoTirar.toLocaleDateString('pt-BR', {timeZone: 'UTC'});
                } else if (typeof dataDoBancoTirar === 'string' && dataDoBancoTirar.match(/^\d{4}-\d{2}-\d{2}$/)) {
                    try { dataExibicao = new Date(dataDoBancoTirar + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone: 'UTC'}); } catch(e){}
                }
            }
            await chat.sendMessage( `⚠️ *CONFIRMAR REMOÇÃO*\nID: ${lastEntry.idtransferencias} | Data: ${dataExibicao} | Rem: ${lastEntry.nome_remetente} | Val: R$ ${(parseFloat(lastEntry.valor) || 0).toFixed(2)}\n\nDigite: \`!tirar confirmar\``);
        } else { await chat.sendMessage('ℹ️ Nada para remover.');}
    } catch (error) { console.error("Erro !tirar:", error); await chat.sendMessage("❌ Erro em !tirar.");
    } finally { if (connection) await connection.end(); }
    return;
  }
  if (bodyLower.startsWith('!baixar ')) {
    const parts = originalBody.split(' '); const subCommand = parts[1] ? parts[1].toLowerCase() : ''; const queryParam = parts.slice(2).join(' ');
    if (subCommand === 'id' && queryParam) {
        const id = parseInt(queryParam); if (isNaN(id)) return chat.sendMessage("❌ ID inválido.");
        let connection;
        try {
            connection = await mysql.createConnection(dbConfig);
            const [rows] = await connection.execute('SELECT arquivo FROM transferencias WHERE idtransferencias = ?', [id]);
            if (rows.length > 0 && rows[0].arquivo) {
                const fileBuffer = rows[0].arquivo; 
                const { mimetype, extension } = guessMimeTypeAndExtension(fileBuffer);
                const filename = `comprovante_ID_${id}.${extension}`;
                const mediaFile = new MessageMedia(mimetype, fileBuffer.toString('base64'), filename);
                await chat.sendMessage(mediaFile, { caption: `Segue comprovante ID ${id}` });
            } else { await chat.sendMessage(`❌ ID ${id} não encontrado ou sem arquivo (manual).`);}
        } catch (error) { console.error("Erro !baixar id:", error); await chat.sendMessage("❌ Erro ao baixar.");
        } finally { if (connection) await connection.end(); }
    } else if (subCommand === 'nome' && queryParam) {
        await buscarRegistros(chat, queryParam, 'nome', false); await chat.sendMessage("ℹ️ Para baixar, use `!baixar id SEU_ID`.");
    } else { await chat.sendMessage("Uso: `!baixar id <ID>` ou `!baixar nome <NOME>`.");}
    return;
  }
  if (bodyLower.startsWith('!buscar ')) {
    const parts = originalBody.split(' '); const subCommandOrTerm = parts[1] ? parts[1].toLowerCase() : '';
    if (!subCommandOrTerm) { return chat.sendMessage("ℹ️ Uso: `!buscar <termo | id | data | nome | mês>`");}
    if (subCommandOrTerm === 'mês') {
        const month = parts[2];
        if (month && month.match(/^\d{1,2}$/) && parseInt(month) >= 1 && parseInt(month) <= 12) { await buscarRegistros(chat, month.padStart(2, '0'), 'mes'); }
        else { await chat.sendMessage("❌ Mês inválido (01-12). Ex: `!buscar mês 06`");}
    } else if (subCommandOrTerm === 'id' && parts[2]) { await buscarRegistros(chat, parts[2], 'id');
    } else if (subCommandOrTerm === 'data' && parts[2] && parts[2].match(/^\d{4}-\d{2}-\d{2}$/)) { await buscarRegistros(chat, parts[2], 'data');
    } else if (subCommandOrTerm === 'nome' && parts[2]) { const nomeTermo = parts.slice(2).join(' '); await buscarRegistros(chat, nomeTermo, 'nome');
    } else { const termoBusca = parts.slice(1).join(' ');
        if (!isNaN(parseInt(termoBusca)) && !termoBusca.includes('-') && !termoBusca.includes(' ')) { await buscarRegistros(chat, termoBusca, 'id'); }
        else if (termoBusca.match(/^\d{4}-\d{2}-\d{2}$/)) { await buscarRegistros(chat, termoBusca, 'data');}
        else { await buscarRegistros(chat, termoBusca, 'nome'); }
    }
    return;
  }
  if (bodyLower === '!menu') {
    const menu = `📋 *MENU* 📋\n\n`+
    `🔹 *!armazenar [tipo]* (resp. mídia)\n   Salva comprovante.\n   Ex: \`!armazenar Mercado\`\n\n`+
    `🔹 *!colocar*\n   Insere dados manualmente.\n\n`+
    `🔹 *!extrato*\n   Gera Excel com lançamentos.\n\n`+
    `🔹 *!buscar <...>`+
    `   Ex: \`!buscar Contas\` | \`!buscar id 10\` | \`!buscar data 2025-07-15\` | \`!buscar mês 07\`\n\n`+
    `🔹 *!baixar id <ID>\n`+
    `   Baixa arquivo do ID.\n   Ex: \`!baixar id 10\`\n\n`+
    `🔹 *!tirar*\n   Remove último comprovante (pede conf.).\n\n`+
    `🔹 *!apaga*\n   Apaga TUDO (pede conf.). ⚠️ *CUIDADO!*\n\n`+
    `🔹 *!menu*\n   Mostra este menu.`;
    chat.sendMessage(menu); return;
  }
});

async function salvarNoBanco(data, chatContext) {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    const sql = `
      INSERT INTO transferencias (
        data_transferencia, nome_remetente, nome_destinatario, 
        valor, tipo_gasto, observação, arquivo, data_armazenado 
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    `;
    const params = [ data.data_transferencia, data.nome_remetente, data.nome_destinatario, data.valor, data.tipo_gasto, data.observacao, data.arquivo ];
    const [result] = await connection.execute(sql, params);
    console.log('Dados salvos no banco com ID:', result.insertId, '| Data string enviada ao BD:', data.data_transferencia);
    let dataFormatada = 'N/A'; let dataOriginalParaMsg = data.data_transferencia || 'N/A';
    if (data.data_transferencia) {
        if (data.data_transferencia instanceof Date && !isNaN(data.data_transferencia)) {
            try { dataFormatada = data.data_transferencia.toLocaleDateString('pt-BR', {timeZone: 'UTC'});} catch (e) {dataFormatada = "Erro Formato";}
        } else if(typeof data.data_transferencia === 'string' && data.data_transferencia.match(/^\d{4}-\d{2}-\d{2}$/)) {
            try { const dateObj = new Date(data.data_transferencia + 'T00:00:00Z'); 
                if (!isNaN(dateObj.getTime())) { dataFormatada = dateObj.toLocaleDateString('pt-BR', {timeZone: 'UTC'}); } 
                else { dataFormatada = "Inválida"; }
            } catch (e) { dataFormatada = "Erro Formato"; }
        }
    }
    await chatContext.sendMessage(
        `✅ ${data.arquivo ? 'Extraído e ' : ''}Armazenado!\n` +
        `Rem: ${data.nome_remetente}\nDest: ${data.nome_destinatario}\n` +
        `Val: R$ ${(typeof data.valor === 'number' ? data.valor.toFixed(2) : '0.00')}\n` +
        `Data: ${dataFormatada} (${dataOriginalParaMsg})\nTipo: ${data.tipo_gasto}\n` +
        `${data.observacao ? `Obs: ${data.observacao}\n` : ''}ID: ${result.insertId}`
    );
  } catch (error) { console.error('Erro BD ao salvar:', error); 
    if (error.sqlMessage) { await chatContext.sendMessage(`❌ Falha BD: ${error.sqlMessage}`);} 
    else { await chatContext.sendMessage('❌ Falha crítica ao salvar dados.');}
  } finally { if (connection) await connection.end(); }
}

async function buscarRegistros(chat, termo, tipoBusca, enviarMensagemNenhumEncontrado = true) {
    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        let querySql = ''; let queryParams = []; let tipoMsg = ''; let totalGastosMes = null;
        let dtVisData = termo;
        if (tipoBusca === 'data' && termo.match(/^\d{4}-\d{2}-\d{2}$/)) { try { dtVisData = new Date(termo + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone: 'UTC'});} catch(e){}
        } else if (tipoBusca === 'mes') { const monthNames = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]; dtVisData = monthNames[parseInt(termo) - 1] || termo; }
        switch (tipoBusca) {
            case 'id': querySql = 'SELECT * FROM transferencias WHERE idtransferencias = ?'; queryParams = [parseInt(termo)]; tipoMsg = `ID ${termo}`; break;
            case 'data': querySql = 'SELECT * FROM transferencias WHERE data_transferencia = ? ORDER BY idtransferencias DESC'; queryParams = [termo]; tipoMsg = `data ${dtVisData}`; break;
            case 'nome': querySql = "SELECT * FROM transferencias WHERE nome_remetente LIKE ? OR nome_destinatario LIKE ? ORDER BY data_transferencia DESC, idtransferencias DESC"; queryParams = [`%${termo}%`, `%${termo}%`]; tipoMsg = `nome "${termo}"`; break;
            case 'mes':
                querySql = 'SELECT * FROM transferencias WHERE MONTH(data_transferencia) = ? ORDER BY data_transferencia ASC, idtransferencias ASC'; queryParams = [parseInt(termo)];
                tipoMsg = `mês ${dtVisData}`;
                const [sumRows] = await connection.execute('SELECT SUM(valor) as total FROM transferencias WHERE MONTH(data_transferencia) = ?', [parseInt(termo)]);
                totalGastosMes = (sumRows.length > 0 && sumRows[0].total !== null) ? parseFloat(sumRows[0].total) : 0;
                break;
            default: return chat.sendMessage("Tipo de busca inválido.");
        }
        const [rows] = await connection.execute(querySql, queryParams);
        if (rows.length > 0) {
            let responseText = `🔎 Busca por ${tipoMsg}:\n\n`;
            rows.slice(0, 15).forEach(row => {
                responseText += `-----------------\n🆔 ID: ${row.idtransferencias}\n`;
                let dataFormatadaBuscaItem = 'N/A';
                const dataDoBancoItem = row.data_transferencia;
                if (dataDoBancoItem) {
                    if (dataDoBancoItem instanceof Date && !isNaN(dataDoBancoItem)) { try { dataFormatadaBuscaItem = dataDoBancoItem.toLocaleDateString('pt-BR', { timeZone: 'UTC' }); } catch(e){}
                    } else if (typeof dataDoBancoItem === 'string' && dataDoBancoItem.match(/^\d{4}-\d{2}-\d{2}$/)) { try { dataFormatadaBuscaItem = new Date(dataDoBancoItem + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }); } catch(e){}
                    } else { console.warn(`[BUSCA ITEM] Formato de data inesperado do banco: ${dataDoBancoItem} (ID: ${row.idtransferencias})`);}
                }
                responseText += `🗓️ Data: ${dataFormatadaBuscaItem}\n💸 Val: R$ ${(parseFloat(row.valor) || 0).toFixed(2)}\n`;
                responseText += `🗣️ Rem: ${row.nome_remetente || 'N/A'}\n👥 Dest: ${row.nome_destinatario || 'N/A'}\n`;
                responseText += `🏷️ Tipo: ${row.tipo_gasto || 'N/A'}\n`;
                if (row.observação) responseText += `📝 Obs: ${row.observação}\n`;
                if (row.arquivo === null) responseText += `✍️ _(Manual)_\n`;
            });
            if (rows.length > 15) responseText += `\nMais ${rows.length - 15} resultados.\n`;
            if (tipoBusca === 'mes' && totalGastosMes !== null) { responseText += `\n-----------------\n💰 *Total ${tipoMsg}: R$ ${totalGastosMes.toFixed(2)}*`;}
            await chat.sendMessage(responseText);
        } else { if (enviarMensagemNenhumEncontrado) { await chat.sendMessage(`ℹ️ Nada para ${tipoMsg}.`);}}
    } catch (error) { console.error(`Erro buscarRegistros (${tipoBusca}):`, error); await chat.sendMessage("❌ Erro na busca.");
    } finally { if (connection) await connection.end(); }
}

client.initialize();
