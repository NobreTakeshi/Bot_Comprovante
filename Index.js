const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');
const mysql = require('mysql2/promise');
const ExcelJS = require('exceljs');

// --- Configuração do Banco de Dados ---
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'Ryusaki', // << SUA SENHA DO MYSQL
  database: 'mydb'     // << NOME DO SEU BANCO DE DADOS
};

// Diretório para arquivos temporários
const tempDir = path.join(__dirname, 'temp_files');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    // args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ Bot pronto e conectado ao WhatsApp!'));
client.on('auth_failure', msg => console.error('❌ Falha na autenticação:', msg));

const userState = {};

// --- Funções Auxiliares de Extração (mantidas e ajustadas) ---
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
  if (/Bradesco/i.test(texto)) { /* ... lógica Bradesco ... */ return { nomeDestinatario, nomeRemetente }; }
  if (/Banco do Brasil|BB/i.test(texto)) { /* ... lógica BB ... */ return { nomeDestinatario, nomeRemetente }; }
  if (/Nu Pagamentos S\.A|Nubank|nu pagamentos/i.test(texto)) { /* ... lógica Nubank ... */ return { nomeDestinatario, nomeRemetente }; }
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
function validarComprovante(texto) { /* ... mantida ... */ 
  const palavrasChave = ['caixa', 'bradesco', 'banco do brasil', 'nubank', 'transferência', 'comprovante', 'pagador', 'favorecido', 'beneficiário', 'pix enviado', 'comprovante de pagamento', 'valor', 'data'];
  texto = texto.toLowerCase();
  return palavrasChave.some(palavra => texto.includes(palavra));
}
function extrairData(texto) { /* ... mantida ... */ 
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
function extrairValor(texto) { /* ... mantida ... */ 
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
function guessMimeTypeAndExtension(buffer) { /* ... mantida ... */ 
    if (!buffer || buffer.length < 4) { return { mimetype: 'application/octet-stream', extension: 'dat' }; }
    const bytes = buffer.toString('hex', 0, 8).toUpperCase();
    if (bytes.startsWith('25504446')) { return { mimetype: 'application/pdf', extension: 'pdf' }; }
    if (bytes.startsWith('89504E470D0A1A0A')) { return { mimetype: 'image/png', extension: 'png' }; }
    if (bytes.startsWith('FFD8FF')) { return { mimetype: 'image/jpeg', extension: 'jpg' }; }
    console.log(`Tipo arquivo não identificado (bytes: ${bytes.substring(0,16)}), usando genérico.`);
    return { mimetype: 'application/octet-stream', extension: 'dat' };
}

// --- Lógica Principal de Mensagens ---
client.on('message', async msg => {
  const senderId = msg.from;
  const chat = await msg.getChat();
  const bodyLower = msg.body.toLowerCase().trim();

  // --- Tratamento de Estados de Confirmação ---
  if (userState[senderId]) {
    const state = userState[senderId];
    // Confirmação para !armazenar (observação)
    if (state.step === 'awaiting_observation') {
        const observationChoice = msg.body.trim();
        if (observationChoice === '1') {
            await chat.sendMessage('Por favor, envie o texto da observação.');
            userState[senderId].step = 'awaiting_observation_text';
        } else if (observationChoice === '2') {
            state.data.observacao = null;
            await salvarNoBanco(state.data, chat);
            delete userState[senderId];
        } else if (observationChoice === '3') {
            await chat.sendMessage('❌ Armazenamento cancelado.');
            delete userState[senderId];
        } else {
            await chat.sendMessage('Opção inválida. Por favor, responda com 1, 2 ou 3.');
        }
        return;
    }
    if (state.step === 'awaiting_observation_text') {
        state.data.observacao = msg.body.trim();
        await salvarNoBanco(state.data, chat);
        delete userState[senderId];
        return;
    }
    // Confirmação para !apaga
    if (state.step === 'awaiting_apaga_confirmation') {
        if (bodyLower === '!apaga confirmar') {
            let connection;
            try {
                connection = await mysql.createConnection(dbConfig);
                await connection.execute('DELETE FROM transferencias');
                await chat.sendMessage('✅ Todos os comprovantes foram apagados do banco de dados.');
            } catch (error) {
                console.error('Erro ao apagar todos os comprovantes:', error);
                await chat.sendMessage('❌ Erro ao apagar os comprovantes.');
            } finally {
                if (connection) await connection.end();
                delete userState[senderId];
            }
        } else {
            await chat.sendMessage('Comando de confirmação inválido. Operação de apagar tudo cancelada.');
            delete userState[senderId];
        }
        return;
    }
    // Confirmação para !tirar
    if (state.step === 'awaiting_tirar_confirmation') {
        if (bodyLower === '!tirar confirmar' && state.lastId) {
            let connection;
            try {
                connection = await mysql.createConnection(dbConfig);
                await connection.execute('DELETE FROM transferencias WHERE idtransferencias = ?', [state.lastId]);
                await chat.sendMessage(`✅ Último comprovante (ID: ${state.lastId}) foi removido.`);
            } catch (error) {
                console.error('Erro ao remover último comprovante:', error);
                await chat.sendMessage('❌ Erro ao remover o último comprovante.');
            } finally {
                if (connection) await connection.end();
                delete userState[senderId];
            }
        } else {
            await chat.sendMessage('Comando de confirmação inválido ou ID não encontrado. Operação de tirar último cancelada.');
            delete userState[senderId];
        }
        return;
    }
     // Novo handler para !colocar
    if (state.step === 'awaiting_colocar_data') {
        const textInput = msg.body;
        const lines = textInput.split('\n');
        const dataInput = {};
        let parseError = false;
        const errors = [];

        const expectedKeys = {
            'data': (val) => {
                if (!val || !val.match(/^\d{4}-\d{2}-\d{2}$/)) {
                    errors.push("Formato de data inválido. Use AAAA-MM-DD.");
                    return null;
                }
                return val;
            },
            'tipo de gasto': (val) => val || "Entrada manual",
            'remetente': (val) => val || "N/A",
            'destinatario': (val) => val || "N/A",
            'valor': (val) => {
                const numVal = parseFloat(String(val).replace(',', '.'));
                if (isNaN(numVal)) {
                    errors.push("Valor inválido. Use um número (ex: 150.00).");
                    return null;
                }
                return numVal;
            },
            'obs': (val) => val || null
        };

        const dbKeysMapping = {
            'data': 'data_transferencia',
            'tipo de gasto': 'tipo_gasto',
            'remetente': 'nome_remetente',
            'destinatario': 'nome_destinatario',
            'valor': 'valor',
            'obs': 'observacao'
        };
        
        let foundFieldsCount = 0;
        const requiredFields = ['data', 'tipo de gasto', 'remetente', 'destinatario', 'valor'];


        lines.forEach(line => {
            const parts = line.split(':');
            if (parts.length >= 2) {
                const key = parts[0].trim().toLowerCase();
                const value = parts.slice(1).join(':').trim();

                if (expectedKeys[key]) {
                    const processedValue = expectedKeys[key](value);
                    if (processedValue !== null || key === 'obs') { // Obs pode ser null propositalmente
                         dataInput[dbKeysMapping[key]] = processedValue;
                    }
                    if(requiredFields.includes(key) && value) foundFieldsCount++;
                }
            }
        });
        
        if (foundFieldsCount < requiredFields.length) {
             errors.push("Campos obrigatórios (data, tipo de gasto, remetente, destinatario, valor) não foram preenchidos corretamente.");
        }


        if (errors.length > 0) {
            await chat.sendMessage("❌ Erros ao processar os dados:\n- " + errors.join("\n- ") + "\n\nTente enviar os dados novamente ou use `!colocar` para ver o modelo.");
        } else {
            dataInput.arquivo = null; // Sem arquivo para entrada manual
            await salvarNoBanco(dataInput, chat);
        }
        // Sempre limpar o estado após a tentativa
        delete userState[senderId];
        return;
    }
  }


  // --- Comando !armazenar ---
  if (bodyLower.startsWith('!armazenar')) {
    if (!msg.hasQuotedMsg) {
      return chat.sendMessage('⚠️ Por favor, use o comando `!armazenar [tipo de gasto]` respondendo a uma mensagem que contenha o comprovante (foto ou PDF). Se não houver tipo de gasto, use `!armazenar` respondendo à mídia.');
    }
    const quotedMsg = await msg.getQuotedMessage();
    if (!quotedMsg.hasMedia) {
      return chat.sendMessage('❌ A mensagem marcada não contém um arquivo de mídia (imagem ou PDF).');
    }

    const commandParts = msg.body.split(' ');
    const tipoGasto = commandParts.length > 1 ? commandParts.slice(1).join(' ') : 'Não especificado';

    try {
      const media = await quotedMsg.downloadMedia();
      if (!media) return chat.sendMessage('❌ Falha ao baixar o arquivo da mensagem marcada.');

      const fileBuffer = Buffer.from(media.data, 'base64');
      const extension = media.mimetype.includes('pdf') ? '.pdf' : (media.mimetype.includes('png') ? '.png' : (media.mimetype.includes('jpeg') || media.mimetype.includes('jpg') ? '.jpg' : '.dat'));
      const tempFilename = `comprovante_temp_${Date.now()}${extension}`;
      const tempFilePath = path.join(tempDir, tempFilename);
      fs.writeFileSync(tempFilePath, fileBuffer);

      let textoExtraido = '';
      if (extension === '.pdf') {
        const dataBuffer = fs.readFileSync(tempFilePath);
        const pdfData = await pdfParse(dataBuffer);
        textoExtraido = pdfData.text;
      } else if (['.png', '.jpg', '.jpeg'].includes(extension)) {
        const result = await Tesseract.recognize(tempFilePath, 'por', { logger: m => {} });
        textoExtraido = result.data.text;
      } else {
        fs.unlinkSync(tempFilePath);
        return chat.sendMessage('❌ Tipo de arquivo não suportado. Envie PDF ou imagem (PNG, JPG).');
      }
      fs.unlinkSync(tempFilePath);

      if (!textoExtraido.trim()) {
          console.log("OCR não extraiu texto.");
          return chat.sendMessage("❌ Não foi possível extrair texto do comprovante. Verifique a qualidade da imagem/PDF.");
      }
      // console.log("Texto Extraído OCR:\n", textoExtraido); // Para debug

      const { nomeDestinatario, nomeRemetente } = extrairNomesPorBanco(textoExtraido);
      const valor = extrairValor(textoExtraido);
      const dataTransferencia = extrairData(textoExtraido);

      const dadosParaSalvar = {
        nome_remetente: nomeRemetente,
        nome_destinatario: nomeDestinatario,
        valor: valor,
        data_transferencia: dataTransferencia,
        tipo_gasto: tipoGasto,
        arquivo: fileBuffer,
        observacao: null
      };

      userState[senderId] = { step: 'awaiting_observation', data: dadosParaSalvar };

      await chat.sendMessage(
        `🧾 Dados extraídos do comprovante:\n\n` +
        `Remetente: ${nomeRemetente}\n` +
        `Destinatário: ${nomeDestinatario}\n` +
        `Valor: R$ ${valor.toFixed(2)}\n` +
        `Data: ${dataTransferencia} (Formato AAAA-MM-DD)\n` +
        `Tipo de Gasto: ${tipoGasto}\n\n` +
        `Os dados estão corretos e deseja adicionar uma observação?\n` +
        `1️⃣ - Sim, adicionar observação\n` +
        `2️⃣ - Sim, salvar sem observação\n` +
        `3️⃣ - Não, cancelar`
      );
    } catch (error) {
      console.error('Erro detalhado ao processar !armazenar:', error);
      await chat.sendMessage('❌ Ocorreu um erro ao processar o comprovante. Verifique o console do bot para mais detalhes.');
      if (userState[senderId]) delete userState[senderId];
    }
    return;
  }

  // --- Comando !colocar (inicial) ---
  if (bodyLower === '!colocar') {
    const moldeTexto = "Por favor, copie o modelo abaixo, preencha os campos e envie de volta. Mantenha o formato `campo: valor` em cada linha.\n\n" +
                       "```\n" +
                       "data: AAAA-MM-DD\n" +
                       "tipo de gasto: [descreva o gasto]\n" +
                       "remetente: [quem pagou]\n" +
                       "destinatario: [quem recebeu]\n" +
                       "valor: [ex: 150.00 ou 150,00]\n" +
                       "obs: [observação opcional - pode deixar em branco]\n" +
                       "```";
    userState[senderId] = { step: 'awaiting_colocar_data' };
    await chat.sendMessage(moldeTexto);
    return;
  }

  // --- Comando !extrato ---
  if (bodyLower === '!extrato') {
    let connection;
    try {
      connection = await mysql.createConnection(dbConfig);
      const [dbRows] = await connection.execute('SELECT data_transferencia, tipo_gasto, nome_remetente, nome_destinatario, valor, observação FROM transferencias ORDER BY data_transferencia ASC, idtransferencias ASC');
      if (dbRows.length === 0) { return chat.sendMessage('ℹ️ Nenhum comprovante para extrato.');}
      const workbook = new ExcelJS.Workbook(); workbook.creator = 'Bot'; const worksheet = workbook.addWorksheet('LANÇAMENTOS');
      worksheet.columns = [
        { header: 'DATA', key: 'data_col', width: 12, style: { numFmt: 'dd/mm/yyyy;@' } }, // Mantém formatação
        { header: 'TIPO DE GASTO', key: 'tipo_gasto_col', width: 30 }, { header: 'REMETENTE', key: 'remetente_col', width: 30 },
        { header: 'DESTINATARIO', key: 'destinatario_col', width: 30 }, { header: 'VALOR', key: 'valor_col', width: 15, style: { numFmt: '"R$"#,##0.00' } },
        { header: 'OBS', key: 'obs_col', width: 40 }, { header: 'TOTAL', key: 'total_col', width: 15, style: { numFmt: '"R$"#,##0.00' } }
      ];
      const headerRow = worksheet.getRow(1); headerRow.font = { bold: true }; headerRow.fill = { type: 'pattern', pattern:'solid', fgColor:{argb:'FFD9D9D9'} }; headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
      let runningTotal = 0;
      dbRows.forEach(dbRowData => {
        const valorTransacao = parseFloat(dbRowData.valor) || 0; runningTotal += valorTransacao;
        
        // --- AJUSTE IMPORTANTE PARA DATA NO EXCEL ---
        let dataParaExcel = null;
        if (dbRowData.data_transferencia) {
            // Se dbRowData.data_transferencia já for um objeto Date (o driver mysql2 pode fazer isso)
            if (dbRowData.data_transferencia instanceof Date) {
                dataParaExcel = dbRowData.data_transferencia;
            } 
            // Se for uma string no formato AAAA-MM-DD
            else if (typeof dbRowData.data_transferencia === 'string' && dbRowData.data_transferencia.match(/^\d{4}-\d{2}-\d{2}$/)) {
                dataParaExcel = new Date(dbRowData.data_transferencia + 'T00:00:00Z'); // Interpreta como UTC
            } else {
                console.warn(`Formato de data inesperado do banco para Excel: ${dbRowData.data_transferencia}`);
            }
        }
        // Se dataParaExcel ainda for null ou se tornou uma data inválida, exceljs geralmente deixa a célula vazia ou lida com isso.

        worksheet.addRow({ 
            data_col: dataParaExcel, 
            tipo_gasto_col: dbRowData.tipo_gasto, remetente_col: dbRowData.nome_remetente, destinatario_col: dbRowData.nome_destinatario, 
            valor_col: valorTransacao, obs_col: dbRowData.observação, total_col: runningTotal 
        });
      });
      worksheet.columns.forEach(column => { /* Seu código de ajuste de largura */ });
      const tempExcelPath = path.join(tempDir, `extrato_${Date.now()}.xlsx`); await workbook.xlsx.writeFile(tempExcelPath);
      const mediaFile = MessageMedia.fromFilePath(tempExcelPath); await chat.sendMessage(mediaFile, { caption: 'Segue o extrato.' });
      fs.unlinkSync(tempExcelPath);
    } catch (error) { console.error('Erro extrato:', error); await chat.sendMessage('❌ Erro ao gerar extrato.');
    } finally { if (connection) await connection.end(); }
    return;
  }

  if (bodyLower === '!apaga') { /* ... (lógica !apaga mantida) ... */ }
  if (bodyLower === '!tirar') { /* ... (lógica !tirar mantida) ... */ }
  if (bodyLower.startsWith('!baixar ')) { /* ... (lógica !baixar com guessMimeTypeAndExtension mantida) ... */ }
  
  // --- Comando !buscar ---
  if (bodyLower.startsWith('!buscar ')) {
    const parts = msg.body.split(' '); const subCommandOrTerm = parts[1] ? parts[1].toLowerCase() : '';
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

  // --- Comando !apaga ---
  if (bodyLower === '!apaga') {
    userState[senderId] = { step: 'awaiting_apaga_confirmation' };
    await chat.sendMessage(
        '⚠️ *ATENÇÃO!* Este comando apagará TODOS os comprovantes do banco de dados.\n' +
        'Esta ação é IRREVERSÍVEL.\n\n' +
        "Para confirmar, digite: `!apaga confirmar`\n" +
        "Para cancelar, envie qualquer outra mensagem ou aguarde."
    );
    return;
  }

  // --- Comando !tirar ---
  if (bodyLower === '!tirar') {
    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        const [rows] = await connection.execute('SELECT idtransferencias, data_transferencia, nome_remetente, valor FROM transferencias ORDER BY idtransferencias DESC LIMIT 1');
        if (rows.length > 0) {
            const lastEntry = rows[0];
            userState[senderId] = { step: 'awaiting_tirar_confirmation', lastId: lastEntry.idtransferencias };
            await chat.sendMessage(
                `⚠️ *CONFIRMAÇÃO*\nVocê deseja remover o último comprovante adicionado?\n\n` +
                `ID: ${lastEntry.idtransferencias}\n` +
                `Data: ${new Date(lastEntry.data_transferencia + 'T00:00:00').toLocaleDateString('pt-BR')}\n` +
                `Remetente: ${lastEntry.nome_remetente}\n` +
                `Valor: R$ ${(parseFloat(lastEntry.valor) || 0).toFixed(2)}\n\n` +
                "Para confirmar, digite: `!tirar confirmar`\n" +
                "Para cancelar, envie qualquer outra mensagem ou aguarde."
            );
        } else {
            await chat.sendMessage('ℹ️ Não há comprovantes para remover.');
        }
    } catch (error) {
        console.error("Erro ao buscar último item para !tirar:", error);
        await chat.sendMessage("❌ Erro ao processar o comando !tirar.");
    } finally {
        if (connection) await connection.end();
    }
    return;
  }

  // --- Comando !baixar ---
  if (bodyLower.startsWith('!baixar ')) {
    const parts = msg.body.split(' ');
    const subCommand = parts[1] ? parts[1].toLowerCase() : '';
    const queryParam = parts.slice(2).join(' ');

    if (subCommand === 'id' && queryParam) {
        const id = parseInt(queryParam);
        if (isNaN(id)) return chat.sendMessage("❌ ID inválido. Forneça um número.");
        let connection;
        try {
            connection = await mysql.createConnection(dbConfig);
            const [rows] = await connection.execute('SELECT arquivo FROM transferencias WHERE idtransferencias = ?', [id]);
            if (rows.length > 0 && rows[0].arquivo) {
                const fileBuffer = rows[0].arquivo;
                const tempFilePath = path.join(tempDir, `comprovante_id_${id}.dat`);
                fs.writeFileSync(tempFilePath, fileBuffer);
                const mediaFile = MessageMedia.fromFilePath(tempFilePath);
                await chat.sendMessage(mediaFile, { caption: `Segue o comprovante ID ${id}. Pode ser necessário renomear o arquivo com a extensão correta (ex: .pdf, .png, .jpg).` });
                fs.unlinkSync(tempFilePath);
            } else {
                await chat.sendMessage(`❌ Comprovante com ID ${id} não encontrado ou arquivo não disponível (pode ser uma entrada manual).`);
            }
        } catch (error) {
            console.error("Erro em !baixar id:", error);
            await chat.sendMessage("❌ Erro ao baixar o comprovante.");
        } finally {
            if (connection) await connection.end();
        }
    } else if (subCommand === 'nome' && queryParam) {
        await buscarRegistros(chat, queryParam, 'nome', false);
        await chat.sendMessage("ℹ️ Para baixar um comprovante da lista acima, use o comando `!baixar id SEU_ID_AQUI`.");
    } else {
        await chat.sendMessage("Uso incorreto. Tente `!baixar id <ID>` ou `!baixar nome <NOME>`.");
    }
    return;
  }

  // --- Comando !buscar ---
  if (bodyLower.startsWith('!buscar ')) {
    const parts = msg.body.split(' ');
    const subCommandOrTerm = parts[1] ? parts[1].toLowerCase() : '';
    
    if (!subCommandOrTerm) {
        return chat.sendMessage("ℹ️ Uso: `!buscar <termo>`, `!buscar id <ID>`, `!buscar data <AAAA-MM-DD>`, `!buscar nome <nome>`, ou `!buscar mês <MM>` (ex: 01 para Janeiro).");
    }

    if (subCommandOrTerm === 'mês') {
        const month = parts[2];
        if (month && month.match(/^\d{1,2}$/) && parseInt(month) >= 1 && parseInt(month) <= 12) {
            await buscarRegistros(chat, month.padStart(2, '0'), 'mes');
        } else {
            await chat.sendMessage("❌ Mês inválido. Use um número de 01 a 12. Ex: `!buscar mês 06`");
        }
    } else if (subCommandOrTerm === 'id' && parts[2]) {
        await buscarRegistros(chat, parts[2], 'id');
    } else if (subCommandOrTerm === 'data' && parts[2] && parts[2].match(/^\d{4}-\d{2}-\d{2}$/)) {
        await buscarRegistros(chat, parts[2], 'data');
    } else if (subCommandOrTerm === 'nome' && parts[2]) {
        const nomeTermo = parts.slice(2).join(' ');
        await buscarRegistros(chat, nomeTermo, 'nome');
    } else { // Busca genérica (termo único)
        const termoBusca = parts.slice(1).join(' ');
        if (!isNaN(parseInt(termoBusca)) && !termoBusca.includes('-') && !termoBusca.includes(' ')) { // Se for um número puro, assume ID
            await buscarRegistros(chat, termoBusca, 'id');
        } else if (termoBusca.match(/^\d{4}-\d{2}-\d{2}$/)) { // Se for formato AAAA-MM-DD
            await buscarRegistros(chat, termoBusca, 'data');
        } else { // Senão, assume que é nome
            await buscarRegistros(chat, termoBusca, 'nome');
        }
    }
    return;
  }
  
  // --- Comando !menu ---
  if (bodyLower === '!menu') {
    const menu = `
📋 *MENU DE COMANDOS DISPONÍVEIS* 📋

🔹 *!armazenar [tipo de gasto]* (responda a uma imagem/PDF)
   Armazena um comprovante via imagem/PDF.
   Ex: _Responda a um comprovante e digite:_ !armazenar Aluguel

🔹 *!colocar*
   Fornece um modelo para inserir dados de um comprovante manualmente via texto.

🔹 *!extrato*
   Gera e envia uma planilha Excel com todos os lançamentos e saldo acumulado.

🔹 *!buscar <termo | id | data | nome | mês>*
   Busca comprovantes:
   - \`!buscar Maria\`: Busca por nome "Maria".
   - \`!buscar 15\`: Busca pelo ID 15.
   - \`!buscar data 2025-06-04\`: Busca pela data específica.
   - \`!buscar mês 06\`: Lista todos os lançamentos de Junho (de todos os anos) e o total de gastos do mês.

🔹 *!baixar id <ID>*
   Baixa o arquivo original do comprovante com o ID especificado.
   Ex: \`!baixar id 15\`
   _(Nota: O arquivo pode precisar ser renomeado com a extensão correta, ex: .pdf, .png)_

🔹 *!baixar nome <nome>*
   Lista IDs de comprovantes que contenham o nome, para usar com "!baixar id".
   Ex: \`!baixar nome José\`

🔹 *!tirar*
   Solicita confirmação para remover o último comprovante adicionado.

🔹 *!apaga*
   Solicita confirmação para apagar TODOS os comprovantes. ⚠️ *CUIDADO!*

🔹 *!menu*
   Exibe esta lista.

📎 _A precisão da extração de dados (OCR) depende da qualidade do comprovante._
    `;
    chat.sendMessage(menu);
    return;
  }
});

// --- Função para Salvar no Banco ---
async function salvarNoBanco(data, chatContext) {
  // Esta função não precisa de alteração para a data, pois data.data_transferencia 
  // já deve estar como AAAA-MM-DD vindo de extrairData ou !colocar
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    const sql = `
      INSERT INTO transferencias (
        data_transferencia, nome_remetente, nome_destinatario, 
        valor, tipo_gasto, observação, arquivo, data_armazenada 
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    `;
    const params = [
      data.data_transferencia, data.nome_remetente, data.nome_destinatario,
      data.valor, data.tipo_gasto, data.observacao, data.arquivo
    ];
    const [result] = await connection.execute(sql, params);
    console.log('Dados salvos no banco com ID:', result.insertId, '| Data string enviada:', data.data_transferencia);

    let dataFormatada = 'N/A'; let dataOriginalParaMsg = data.data_transferencia || 'N/A';
    if (data.data_transferencia && data.data_transferencia.match(/^\d{4}-\d{2}-\d{2}$/)) {
        try { 
            const dateObj = new Date(data.data_transferencia + 'T00:00:00Z'); 
            if (!isNaN(dateObj.getTime())) { dataFormatada = dateObj.toLocaleDateString('pt-BR', {timeZone: 'UTC'}); } 
            else { console.warn("Data inválida formatação (salvarNoBanco):", data.data_transferencia); dataFormatada = "Inválida"; }
        } catch (e) { console.error("Erro formatar data (salvarNoBanco):", e); dataFormatada = "Erro Formato"; }
    }
    await chatContext.sendMessage( /* ... mensagem de sucesso ... */ );
  } catch (error) { console.error('Erro BD:', error); /* ... mensagem de erro ... */
  } finally { if (connection) await connection.end(); }
}

// --- Função Auxiliar para Buscar Registros ---
async function buscarRegistros(chat, termo, tipoBusca, enviarMensagemNenhumEncontrado = true) {
    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        let querySql = ''; let queryParams = []; let tipoMsg = ''; let totalGastosMes = null;
        switch (tipoBusca) {
            case 'id': querySql = 'SELECT * FROM transferencias WHERE idtransferencias = ?'; queryParams = [parseInt(termo)]; tipoMsg = `ID ${termo}`; break;
            case 'data': 
                querySql = 'SELECT * FROM transferencias WHERE data_transferencia = ? ORDER BY idtransferencias DESC'; 
                queryParams = [termo]; // Termo deve ser AAAA-MM-DD
                // Para exibir a data na mensagem de "busca por", formatamos
                let dataFormatadaParaTipoMsg = termo;
                try { dataFormatadaParaTipoMsg = new Date(termo + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone: 'UTC'}); } catch(e){}
                tipoMsg = `data ${dataFormatadaParaTipoMsg}`; 
                break;
            case 'nome': querySql = "SELECT * FROM transferencias WHERE nome_remetente LIKE ? OR nome_destinatario LIKE ? ORDER BY data_transferencia DESC, idtransferencias DESC"; queryParams = [`%${termo}%`, `%${termo}%`]; tipoMsg = `nome "${termo}"`; break;
            case 'mes':
                querySql = 'SELECT * FROM transferencias WHERE MONTH(data_transferencia) = ? ORDER BY data_transferencia ASC, idtransferencias ASC'; queryParams = [parseInt(termo)];
                const monthNames = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
                tipoMsg = `mês ${monthNames[parseInt(termo) - 1] || termo}`;
                const [sumRows] = await connection.execute('SELECT SUM(valor) as total FROM transferencias WHERE MONTH(data_transferencia) = ?', [parseInt(termo)]);
                totalGastosMes = (sumRows.length > 0 && sumRows[0].total !== null) ? parseFloat(sumRows[0].total) : 0;
                break;
            default: return chat.sendMessage("Tipo de busca inválido.");
        }
        const [rows] = await connection.execute(querySql, queryParams);
        if (rows.length > 0) {
            let responseText = `🔎 Resultados da busca por ${tipoMsg}:\n\n`;
            rows.slice(0, 15).forEach(row => {
                responseText += `------------------------------\n`;
                responseText += `🆔 ID: ${row.idtransferencias}\n`;
                
                // --- AJUSTE IMPORTANTE PARA DATA NA MENSAGEM DE BUSCA ---
                let dataFormatadaBusca = 'N/A';
                if (row.data_transferencia) {
                    // Se row.data_transferencia já for um objeto Date
                    if (row.data_transferencia instanceof Date && !isNaN(row.data_transferencia)) {
                        try { dataFormatadaBusca = row.data_transferencia.toLocaleDateString('pt-BR', { timeZone: 'UTC' }); } catch(e){}
                    } 
                    // Se for uma string AAAA-MM-DD
                    else if (typeof row.data_transferencia === 'string' && row.data_transferencia.match(/^\d{4}-\d{2}-\d{2}$/)) {
                        try { dataFormatadaBusca = new Date(row.data_transferencia + 'T00:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }); } catch(e){}
                    } else {
                         console.warn(`Formato de data inesperado do banco para busca: ${row.data_transferencia}`);
                    }
                }
                responseText += `🗓️ Data: ${dataFormatadaBusca}\n`;
                responseText += `💸 Valor: R$ ${(parseFloat(row.valor) || 0).toFixed(2)}\n`;
                responseText += `➡️ Remetente: ${row.nome_remetente || 'N/A'}\n`;
                responseText += `⬅️ Destinatário: ${row.nome_destinatario || 'N/A'}\n`;
                responseText += `🏷️ Tipo Gasto: ${row.tipo_gasto || 'N/A'}\n`;
                if (row.observação) responseText += `📝 Obs: ${row.observação}\n`;
                if (row.arquivo === null) responseText += `✍️ _(Entrada Manual)_\n`;
            });
            if (rows.length > 15) responseText += `\nMais ${rows.length - 15} resultados.\n`;
            if (tipoBusca === 'mes' && totalGastosMes !== null) { responseText += `\n------------------------------\n💰 *Total ${tipoMsg}: R$ ${totalGastosMes.toFixed(2)}*`;}
            await chat.sendMessage(responseText);
        } else { if (enviarMensagemNenhumEncontrado) { await chat.sendMessage(`ℹ️ Nenhum comprovante para ${tipoMsg}.`);}}
    } catch (error) { console.error(`Erro buscarRegistros (${tipoBusca}):`, error); await chat.sendMessage("❌ Erro na busca.");
    } finally { if (connection) await connection.end(); }
}


client.initialize();
