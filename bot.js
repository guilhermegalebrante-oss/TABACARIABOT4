// bot.js
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import express from 'express';
const app = express();
app.get('/', (_, res) => res.send('ok'));
app.listen(process.env.PORT || 3000);


// ================== CONFIG BÁSICA ==================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const N8N_WEBHOOK   = process.env.N8N_WEBHOOK || '';


const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ================== HELPERS DE DATA ==================
function formatDateYMD(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const [{ value: dd }, , { value: mm }, , { value: yyyy }] = fmt.formatToParts(date);
  return `${yyyy}-${mm}-${dd}`;
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function pad2(n) { return n.toString().padStart(2,'0'); }

// parse de data amigável com sugestão quando ambígua
function parseDateSmart(input) {
  const raw = (input || '').trim().toLowerCase();

  if (raw === 'hoje')  return { ok: true, value: formatDateYMD() };
  if (raw === 'ontem') return { ok: true, value: formatDateYMD(addDays(new Date(), -1)) };

  // dd/mm/aaaa ou dd-mm-aaaa
  let m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const dd = pad2(m[1]), mm = pad2(m[2]), yyyy = m[3];
    return { ok: true, value: `${yyyy}-${mm}-${dd}` };
  }

  // aaaa-mm-dd ou aaaa/mm/dd
  m = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    const yyyy = m[1], mm = pad2(m[2]), dd = pad2(m[3]);
    return { ok: true, value: `${yyyy}-${mm}-${dd}` };
  }

  // dd/mm (sem ano) -> sugerir ano atual
  m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const dd = pad2(m[1]), mm = pad2(m[2]);
    return { ok: false, suggest: `${yyyy}-${mm}-${dd}` };
  }

  // dd/mm/aa (ano 2 dígitos) -> sugerir 20xx
  m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m) {
    const dd = pad2(m[1]), mm = pad2(m[2]), aa = m[3];
    const yyyy = `20${aa}`;
    return { ok: false, suggest: `${yyyy}-${mm}-${dd}` };
  }

  return { ok: false, suggest: null };
}

// ================== UI HELPERS ==================
function chunkButtons(items, prefix) {
  const rows = [];
  for (let i = 0; i < items.length; i += 5) {
    const slice = items.slice(i, i + 5);
    const row = new ActionRowBuilder();
    slice.forEach(label => {
      row.addComponents(
        new ButtonBuilder().setCustomId(`${prefix}:${label}`).setLabel(label).setStyle(ButtonStyle.Primary)
      );
    });
    rows.push(row);
  }
  return rows;
}
function backRow(target) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`back:${target}`).setLabel('◀️ Voltar').setStyle(ButtonStyle.Secondary)
  );
}
function tipoMenuRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tipo:Entrada').setLabel('Entrada 💰').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tipo:Saída').setLabel('Saída 🧾').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('func:SaldoAtual').setLabel('Saldo Atual 💵').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('func:SaidasPorCategoria').setLabel('Saídas por Categoria 📊').setStyle(ButtonStyle.Secondary)
  );
}

// Seletor rápido de data (sem calendário)
function dateQuickRows(hasLastDate) {
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('date:Hoje').setLabel('Hoje').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('date:Ontem').setLabel('Ontem').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('date:Msg').setLabel('Data da mensagem').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('date:Digit').setLabel('Digitar data').setStyle(ButtonStyle.Secondary)
  );
  if (hasLastDate) {
    const r0 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('date:Ultima').setLabel('Usar última data').setStyle(ButtonStyle.Secondary)
    );
    return [r0, r1];
  }
  return [r1];
}

// ================== CONFIG DINÂMICA (arquivos) ==================
const CFG_DIR = path.resolve('./config');

function loadJSON(name, fallback) {
  try {
    const p = path.join(CFG_DIR, name);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn(`[config] Falha ao ler ${name}: ${e.message}`);
    return fallback;
  }
}

// valores carregados dinamicamente
let entradaOptions   = loadJSON('entradas.json', []);
let categorias       = loadJSON('categorias.json', []);
let subcats          = loadJSON('subcats.json', {});      // { "Categoria": ["Sub 1", "Sub 2"] }
let formasPagamento  = loadJSON('pagamentos.json', []);
let settings         = loadJSON('settings.json', { launchCommand: '!lancar', reloadCommand: '!reload' });

// recarrega tudo (usado no !reload e no watcher)
function reloadAll() {
  entradaOptions  = loadJSON('entradas.json', []);
  categorias      = loadJSON('categorias.json', []);
  subcats         = loadJSON('subcats.json', {});
  formasPagamento = loadJSON('pagamentos.json', []);
  settings        = loadJSON('settings.json', { launchCommand: '!lancar', reloadCommand: '!reload' });
  console.log('[config] Reload completo.');
}

// Hot reload automático ao salvar os arquivos
['entradas.json','categorias.json','subcats.json','pagamentos.json','settings.json'].forEach(file => {
  const full = path.join(CFG_DIR, file);
  if (!fs.existsSync(full)) return;
  fs.watchFile(full, { interval: 1000 }, () => {
    console.log(`[config] Detectado update em ${file}`);
    reloadAll();
  });
});

// ================== ESTADO ==================
const state = new Map();
/*
  state por user:
  {
    tipo, entrySource, categoria, subcategoria, pagamento,
    lastDate: 'YYYY-MM-DD',
    chosenDate: 'YYYY-MM-DD'
  }
*/

// ================== BOT ==================
client.once(Events.ClientReady, () => {
  console.log(`Bot online como ${client.user.tag}`);
});

// Comandos de texto simples (usando settings.json)
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const content = message.content.trim();
  const isLaunch = content.toLowerCase() === settings.launchCommand.toLowerCase();
  const isReload = content.toLowerCase() === settings.reloadCommand.toLowerCase();

  if (isLaunch) {
    state.set(message.author.id, {});
    return message.reply({ content: '📝 **Escolha o que deseja fazer:**', components: [tipoMenuRow()] });
  }

  if (isReload) {
    reloadAll();
    return message.reply('🔄 Configurações recarregadas (entradas, categorias, subcats, pagamentos, settings).');
  }
});

client.on(Events.InteractionCreate, async interaction => {
  // -------------------- BOTÕES --------------------
  if (interaction.isButton()) {
    const [stage, value] = interaction.customId.split(':');
    const userId = interaction.user.id;
    const ctx = state.get(userId) || {};

    // -------- Funções (Saldo / Saídas por Categoria) --------
    if (stage === 'func') {
      await axios.post(N8N_WEBHOOK, { action: value === 'SaldoAtual' ? 'saldo_atual' : 'saidas_por_categoria', user: interaction.user.username });
      return interaction.deferUpdate();
    }

    // -------- Voltar --------
    if (stage === 'back') {
      if (value === 'main' || value === 'tipo') {
        state.set(userId, {});
        return interaction.update({ content: '📝 **Escolha o que deseja fazer:**', components: [tipoMenuRow()] });
      }
      if (value === 'cat') {
        ctx.subcategoria = undefined; ctx.pagamento = undefined;
        state.set(userId, ctx);
        return interaction.update({
          content: '🧾 **Saída** selecionada. Agora escolha a *categoria*:',
          components: [...chunkButtons(categorias, 'cat'), backRow('tipo')]
        });
      }
      if (value === 'entr') {
        ctx.pagamento = undefined;
        state.set(userId, ctx);
        return interaction.update({
          content: '💼 **Entrada** selecionada. Agora escolha a *origem*:',
          components: [...chunkButtons(entradaOptions, 'entr'), backRow('tipo')]
        });
      }
    }

    // -------- Tipo --------
    if (stage === 'tipo') {
      ctx.tipo = value;
      ctx.entrySource = ctx.categoria = ctx.subcategoria = ctx.pagamento = undefined;
      state.set(userId, ctx);

      if (value === 'Entrada') {
        return interaction.update({
          content: '💼 **Entrada** selecionada. Agora escolha a *origem*:',
          components: [...chunkButtons(entradaOptions, 'entr'), backRow('tipo')]
        });
      } else {
        return interaction.update({
          content: '🧾 **Saída** selecionada. Agora escolha a *categoria*:',
          components: [...chunkButtons(categorias, 'cat'), backRow('tipo')]
        });
      }
    }

    // -------- Entrada: origem --------
    if (stage === 'entr') {
      ctx.entrySource = value;
      state.set(userId, ctx);
      return interaction.update({
        content: `📥 **Origem:** ${value}. Agora escolha *forma de pagamento*:`,
        components: [...chunkButtons(formasPagamento, 'pay'), backRow('entr')]
      });
    }

    // -------- Saída: categoria -> subcategoria (com proteção) --------
    if (stage === 'cat') {
      ctx.categoria = value; ctx.subcategoria = undefined;
      state.set(userId, ctx);

      const subs = subcats[value] || [];
      if (!subs.length) {
        return interaction.update({
          content: `⚠️ **${value}** ainda não tem subcategorias. Edite **/config/subcats.json** para adicioná-las.`,
          components: [backRow('cat')]
        });
      }

      return interaction.update({
        content: `📑 **Categoria:** ${value}. Agora escolha a *subcategoria*:`,
        components: [...chunkButtons(subs, 'sub'), backRow('cat')]
      });
    }

    if (stage === 'sub') {
      ctx.subcategoria = value;
      state.set(userId, ctx);
      return interaction.update({
        content: `💳 **Subcategoria:** ${value}. Agora escolha *forma de pagamento*:`,
        components: [...chunkButtons(formasPagamento, 'pay'), backRow('cat')]
      });
    }

    // -------- Forma de pagamento -> seletor de data --------
    if (stage === 'pay') {
      ctx.pagamento = value;
      state.set(userId, ctx);
      const hasLast = !!ctx.lastDate;
      return interaction.update({
        content: '🗓️ **Escolha a data do lançamento:**',
        components: [...dateQuickRows(hasLast), backRow('entr')]
      });
    }

    // -------- Date quick actions (sem calendário) --------
    if (stage === 'date') {
      if (value === 'Digit') {
        // abrir modal de Data + Valor
        const modal = new ModalBuilder().setCustomId('lancamentoModal').setTitle('Data e Valor');
        const inputData = new TextInputBuilder()
          .setCustomId('date').setLabel('Data (AAAA-MM-DD, "hoje"/"ontem")')
          .setStyle(TextInputStyle.Short).setPlaceholder('ex: 2025-08-09 ou "hoje"').setRequired(true);
        const inputValor = new TextInputBuilder()
          .setCustomId('valor').setLabel('Valor (somente números)')
          .setStyle(TextInputStyle.Short).setPlaceholder('ex: 250').setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(inputData), new ActionRowBuilder().addComponents(inputValor));
        return interaction.showModal(modal);
      }

      let chosen = null;
      if (value === 'Hoje')   chosen = formatDateYMD();
      if (value === 'Ontem')  chosen = formatDateYMD(addDays(new Date(), -1));
      if (value === 'Ultima' && ctx.lastDate) chosen = ctx.lastDate;
      if (value === 'Msg')    chosen = formatDateYMD(interaction.createdAt);

      if (chosen) {
        ctx.chosenDate = chosen;
        state.set(userId, ctx);
        // abrir modal só de Valor (data já definida)
        const modal = new ModalBuilder().setCustomId('valorModal').setTitle(`Valor para ${chosen}`);
        const inputValor = new TextInputBuilder()
          .setCustomId('valor').setLabel('Valor (somente números)')
          .setStyle(TextInputStyle.Short).setPlaceholder('ex: 250').setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(inputValor));
        return interaction.showModal(modal);
      }
      return;
    }
  }

  // -------------------- MODAIS --------------------
  if (interaction.isModalSubmit()) {
    const userId = interaction.user.id;
    const ctx = state.get(userId) || {};

    // Modal com data + valor (digitado)
    if (interaction.customId === 'lancamentoModal') {
      const rawDate = interaction.fields.getTextInputValue('date');
      let valor = interaction.fields.getTextInputValue('valor').trim();
      valor = valor.replace(',', '.');

      const parsed = parseDateSmart(rawDate);
      if (!parsed.ok) {
        if (parsed.suggest) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`datefix:accept:${parsed.suggest}`).setLabel(`Confirmar: ${parsed.suggest}`).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`datefix:deny:${rawDate}`).setLabel('Editar data').setStyle(ButtonStyle.Secondary)
          );
          await interaction.reply({ content: `❓ Não entendi a data **"${rawDate}"**. Você quis dizer **${parsed.suggest}**?`, components: [row], ephemeral: true });
          return;
        } else {
          await interaction.reply({ content: '❌ Data inválida. Use **AAAA-MM-DD** ou "hoje"/"ontem".', ephemeral: true });
          return;
        }
      }

      const dataNorm = parsed.value;
      ctx.lastDate = dataNorm;
      state.set(userId, ctx);

      const payload = {
        tipo: ctx.tipo,
        pagamento: ctx.pagamento,
        data: dataNorm,
        valor,
        user: interaction.user.username
      };
      if (ctx.tipo === 'Entrada') payload.origem = ctx.entrySource;
      else { payload.categoria = ctx.categoria; payload.subcategoria = ctx.subcategoria; }

      try {
        await axios.post(N8N_WEBHOOK, payload);
        await interaction.reply({ content: '✅ Lançamento registrado!', ephemeral: true });
      } catch {
        await interaction.reply({ content: '❌ Falha ao enviar pro n8n.', ephemeral: true });
      } finally {
        state.delete(userId);
      }
    }

    // Modal só de valor (data já escolhida por botão rápido)
    if (interaction.customId === 'valorModal') {
      let valor = interaction.fields.getTextInputValue('valor').trim();
      valor = valor.replace(',', '.');

      const dataNorm = ctx.chosenDate || ctx.lastDate || formatDateYMD();
      const payload = {
        tipo: ctx.tipo,
        pagamento: ctx.pagamento,
        data: dataNorm,
        valor,
        user: interaction.user.username
      };
      if (ctx.tipo === 'Entrada') payload.origem = ctx.entrySource;
      else { payload.categoria = ctx.categoria; payload.subcategoria = ctx.subcategoria; }

      try {
        await axios.post(N8N_WEBHOOK, payload);
        await interaction.reply({ content: `✅ Lançamento registrado para **${dataNorm}**!`, ephemeral: true });
      } catch {
        await interaction.reply({ content: '❌ Falha ao enviar pro n8n.', ephemeral: true });
      } finally {
        state.delete(userId);
      }
    }

    // Correção de data sugerida (confirmar/editar)
    if (interaction.customId.startsWith('datefix:')) {
      const parts = interaction.customId.split(':'); // datefix:accept|deny:value
      const action = parts[1];
      const value  = parts[2];

      if (action === 'accept') {
        const fixed = value; // YYYY-MM-DD
        const modal = new ModalBuilder().setCustomId('valorModal').setTitle(`Valor para ${fixed}`);
        const inputValor = new TextInputBuilder().setCustomId('valor').setLabel('Valor (somente números)').setStyle(TextInputStyle.Short).setPlaceholder('ex: 250').setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(inputValor));

        const ctx2 = state.get(interaction.user.id) || {};
        ctx2.chosenDate = fixed;
        ctx2.lastDate   = fixed;
        state.set(interaction.user.id, ctx2);

        await interaction.update({ content: `🗓️ Data ajustada para **${fixed}**. Informe o valor:`, components: [] });
        return interaction.showModal(modal);
      } else {
        const modal = new ModalBuilder().setCustomId('lancamentoModal').setTitle('Data e Valor');
        const inputData = new TextInputBuilder().setCustomId('date').setLabel('Data (AAAA-MM-DD, "hoje"/"ontem")').setStyle(TextInputStyle.Short).setPlaceholder('ex: 2025-08-09').setRequired(true);
        const inputValor = new TextInputBuilder().setCustomId('valor').setLabel('Valor (somente números)').setStyle(TextInputStyle.Short).setPlaceholder('ex: 250').setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(inputData), new ActionRowBuilder().addComponents(inputValor));
        return interaction.showModal(modal);
      }
    }
  }
});

client.login(DISCORD_TOKEN);
