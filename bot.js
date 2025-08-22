// bot.js
// Fluxo: !vender → [Rosh|Copão] → Marca → Sabor → Modal (valor + qtd + mesa + obs) → save
// Webhooks: TIPOS->MARCAS, SABORES, (opcional) LASTPRICE, SAVE

import 'dotenv/config';
import {
  Client, GatewayIntentBits, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  Partials
} from 'discord.js';
import axios from 'axios';

/* ================== ENV ================== */
const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;

const WEBHOOK_TIPOS     = process.env.WEBHOOK_TIPOS;     // { tipo } -> { options:[...marcas] }
const WEBHOOK_SABORES   = process.env.WEBHOOK_SABORES;   // { tipo, marca } -> { options:[...sabores] }
const WEBHOOK_LASTPRICE = process.env.WEBHOOK_LASTPRICE; // { tipo, marca, sabor } -> { lastPrice:"25.00" } (opcional)
const WEBHOOK_SAVE      = process.env.WEBHOOK_SAVE;      // { tipo, marca, sabor, valor, quantidade, mesa, observacao, userId, username, channelId, channelName, guildId, guildName }

if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN ausente');
for (const [k, v] of Object.entries({ WEBHOOK_TIPOS, WEBHOOK_SABORES, WEBHOOK_SAVE })) {
  if (!v) throw new Error(`${k} ausente nas variáveis de ambiente`);
}
const HAS_LASTPRICE = !!WEBHOOK_LASTPRICE;

// Whitelist opcional: nomes de canais separados por vírgula (ex: "loja-centro,loja-bairro")
const CHANNEL_WHITELIST = (process.env.CHANNEL_WHITELIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/* ================== HELPERS UI ================== */
function mainMenuRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('item:Rosh').setLabel('Rosh').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('item:Copão').setLabel('Copão').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('menu:refresh').setLabel('Atualizar').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('close').setLabel('Fechar').setStyle(ButtonStyle.Danger),
  );
}
function backRow(scope) { // scope: main | tipo | marca
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`back:${scope}`).setLabel('◀️ Voltar').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('menu:main').setLabel('Menu').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('close').setLabel('Fechar').setStyle(ButtonStyle.Danger),
  );
}
function chunkButtons(items, prefix) {
  const arr = (items || []).map(s => String(s ?? '').trim()).filter(Boolean).slice(0, 25);
  const rows = [];
  for (let i = 0; i < arr.length; i += 5) {
    const row = new ActionRowBuilder();
    arr.slice(i, i + 5).forEach(label => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${prefix}:${label}`)
          .setLabel(label.slice(0, 80))
          .setStyle(ButtonStyle.Primary)
      );
    });
    rows.push(row);
  }
  return rows;
}
const num = (s, d='') => { const x = String(s ?? '').replace(',', '.').trim(); return x && !isNaN(Number(x)) ? x : d; };
const txt = (s) => String(s ?? '').trim();

/* ================== REDE ================== */
async function post(url, payload, timeout = 15000) {
  const { data } = await axios.post(url, payload, { timeout });
  return data;
}
async function fetchMarcas(tipo) {
  const data = await post(WEBHOOK_TIPOS, { tipo });
  return Array.isArray(data?.options) ? data.options : [];
}
async function fetchSabores(tipo, marca) {
  const data = await post(WEBHOOK_SABORES, { tipo, marca });
  return Array.isArray(data?.options) ? data.options : [];
}
async function fetchLastPrice(tipo, marca, sabor) {
  if (!HAS_LASTPRICE) return '';
  try {
    const data = await post(WEBHOOK_LASTPRICE, { tipo, marca, sabor });
    const v = String(data?.lastPrice ?? '').replace(',', '.').trim();
    return v && !isNaN(Number(v)) ? v : '';
  } catch { return ''; }
}
async function saveSale(payload) {
  await post(WEBHOOK_SAVE, payload);
}

/* ================== ESTADO ================== */
const ctxByUser = new Map(); // userId => { tipo, marca, sabor }

/* ================== DISCORD ================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

client.once(Events.ClientReady, () => console.log(`✅ Bot Tabacaria online: ${client.user.tag}`));

/* Util: pega nome do canal com fallback (inclusive thread/DM) */
async function resolveChannelName(interactionOrMessage) {
  try {
    const channel = interactionOrMessage.channel
      ?? await client.channels.fetch(interactionOrMessage.channelId);
    if (!channel) return null;
    if ('name' in channel && channel.name) return channel.name;
    if ('isDMBased' in channel && channel.isDMBased?.()) return 'DM';
    // threads costumam ter name também
    return channel?.name ?? null;
  } catch { return null; }
}
function allowedByWhitelist(channelName) {
  if (CHANNEL_WHITELIST.length === 0) return true;
  return channelName && CHANNEL_WHITELIST.includes(channelName);
}

/* Trigger: !vender */
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.content.trim().toLowerCase() !== '!vender') return;

  // bloquear DM
  if (!message.guildId) return message.reply('⚠️ Use este comando dentro de um servidor (DM desativado).');

  const channelName = 'name' in message.channel ? message.channel.name : null;
  if (!allowedByWhitelist(channelName)) {
    return message.reply('⛔ Este canal não está habilitado para registrar vendas.');
  }

  ctxByUser.delete(message.author.id);
  return message.reply({
    content: `🛒 **Selecione o item vendido:**` + (channelName ? `\n#️⃣ Canal: **${channelName}**` : ''),
    components: [mainMenuRow()]
  });
});

/* Interações */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;

  // bloquear DM
  if (!interaction.guildId) {
    if (interaction.isButton()) return interaction.reply({ content: '⚠️ Use dentro de um servidor.', ephemeral: true });
    if (interaction.isModalSubmit()) return interaction.reply({ content: '⚠️ Use dentro de um servidor.', ephemeral: true });
    return;
  }

  const channelName = await resolveChannelName(interaction);
  if (!allowedByWhitelist(channelName)) {
    if (interaction.isButton()) return interaction.reply({ content: '⛔ Canal não habilitado.', ephemeral: true });
    if (interaction.isModalSubmit()) return interaction.reply({ content: '⛔ Canal não habilitado.', ephemeral: true });
    return;
  }

  // Fechar
  if (interaction.isButton() && interaction.customId === 'close') {
    ctxByUser.delete(interaction.user.id);
    return interaction.update({ content: '✅ Fechado.', components: [] });
  }

  // Menu / Refresh
  if (interaction.isButton() && (interaction.customId === 'menu:main' || interaction.customId === 'menu:refresh')) {
    ctxByUser.delete(interaction.user.id);
    return interaction.update({ content: '🛒 **Selecione o item vendido:**', components: [mainMenuRow()] });
  }

  // Voltar
  if (interaction.isButton() && interaction.customId.startsWith('back:')) {
    const to  = interaction.customId.split(':')[1];
    const ctx = ctxByUser.get(interaction.user.id) || {};

    if (to === 'main') {
      ctxByUser.delete(interaction.user.id);
      return interaction.update({ content: '🛒 **Selecione o item vendido:**', components: [mainMenuRow()] });
    }
    if (to === 'tipo') {
      const marcas = await fetchMarcas(ctx.tipo);
      return interaction.update({
        content: `🛒 **${ctx.tipo}** — escolha a **Marca**:`,
        components: [...chunkButtons(marcas, 'marca'), backRow('main')]
      });
    }
    if (to === 'marca') {
      const sabores = await fetchSabores(ctx.tipo, ctx.marca);
      return interaction.update({
        content: `🛒 **${ctx.tipo} / ${ctx.marca}** — escolha o **Sabor**:`,
        components: [...chunkButtons(sabores, 'sabor'), backRow('tipo')]
      });
    }
  }

  // Passo 1: Tipo → marcas
  if (interaction.isButton() && interaction.customId.startsWith('item:')) {
    const tipo = interaction.customId.split(':')[1];
    ctxByUser.set(interaction.user.id, { tipo });

    try {
      const marcas = await fetchMarcas(tipo);
      if (!marcas.length) {
        return interaction.update({
          content: `⚠️ Webhook de marcas respondeu sem **options** para **${tipo}**.`,
          components: [mainMenuRow()]
        });
      }
      return interaction.update({
        content: `🛒 **${tipo}** — escolha a **Marca**:`,
        components: [...chunkButtons(marcas, 'marca'), backRow('main')]
      });
    } catch {
      return interaction.update({
        content: `❌ Erro ao consultar **marcas** de **${tipo}**.`,
        components: [mainMenuRow()]
      });
    }
  }

  // Passo 2: Marca → sabores
  if (interaction.isButton() && interaction.customId.startsWith('marca:')) {
    const marca = interaction.customId.split(':')[1];
    const ctx = ctxByUser.get(interaction.user.id) || {};
    ctx.marca = marca;
    ctxByUser.set(interaction.user.id, ctx);

    try {
      const sabores = await fetchSabores(ctx.tipo, ctx.marca);
      if (!sabores.length) {
        return interaction.update({
          content: `⚠️ Webhook de sabores respondeu sem **options** para **${ctx.marca}**.`,
          components: [backRow('tipo')]
        });
      }
      return interaction.update({
        content: `🛒 **${ctx.tipo} / ${ctx.marca}** — escolha o **Sabor**:`,
        components: [...chunkButtons(sabores, 'sabor'), backRow('tipo')]
      });
    } catch {
      return interaction.update({
        content: `❌ Erro ao consultar **sabores** de **${ctx.marca}**.`,
        components: [backRow('tipo')]
      });
    }
  }

  // Passo 3: Sabor → modal (com lastPrice se disponível)
  if (interaction.isButton() && interaction.customId.startsWith('sabor:')) {
    const sabor = interaction.customId.split(':')[1];
    const ctx = ctxByUser.get(interaction.user.id) || {};
    ctx.sabor = sabor;
    ctxByUser.set(interaction.user.id, ctx);

    const lastPrice = await fetchLastPrice(ctx.tipo, ctx.marca, ctx.sabor);

    const modal = new ModalBuilder()
      .setCustomId('modal:save')
      .setTitle(`Registrar ${ctx.tipo}/${ctx.marca}/${ctx.sabor}`);

    const inputValor = new TextInputBuilder()
      .setCustomId('valor')
      .setLabel('Valor (ex: 25.00)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    if (lastPrice) inputValor.setValue(lastPrice);

    const inputQtd = new TextInputBuilder()
      .setCustomId('qtd')
      .setLabel('Quantidade')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue('1');

    const inputMesa = new TextInputBuilder()
      .setCustomId('mesa')
      .setLabel('Mesa (ex: Mesa 1)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const inputObs = new TextInputBuilder()
      .setCustomId('obs')
      .setLabel('Observação (ex: nome da pessoa / observações)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(inputValor),
      new ActionRowBuilder().addComponents(inputQtd),
      new ActionRowBuilder().addComponents(inputMesa),
      new ActionRowBuilder().addComponents(inputObs),
    );

    return interaction.showModal(modal);
  }

  // Passo 4: Modal → save (com metadados de canal/servidor)
  if (interaction.isModalSubmit() && interaction.customId === 'modal:save') {
    await interaction.deferReply({ ephemeral: true });

    const valor = num(interaction.fields.getTextInputValue('valor'), '');
    const quantidade = num(interaction.fields.getTextInputValue('qtd'), '1');
    const mesa = txt(interaction.fields.getTextInputValue('mesa'));
    const observacao = txt(interaction.fields.getTextInputValue('obs'));

    if (!valor) return interaction.editReply('❌ Valor inválido.');
    if (!quantidade || Number(quantidade) <= 0) return interaction.editReply('❌ Quantidade inválida.');
    if (!mesa) return interaction.editReply('❌ Informe a **Mesa** (ex: Mesa 1).');

    const ctx = ctxByUser.get(interaction.user.id) || {};
    if (!ctx.tipo || !ctx.marca || !ctx.sabor) {
      return interaction.editReply('❌ Fluxo incompleto. Use **!vender** de novo.');
    }

    // metadados
    const guildId   = interaction.guildId || null;
    const guildName = interaction.guild?.name || null;
    const channelId = interaction.channelId || null;
    const channelName2 = await resolveChannelName(interaction);
    const messageJumpUrl = interaction.message?.url || null;

    try {
      await saveSale({
        tipo: ctx.tipo,
        marca: ctx.marca,
        sabor: ctx.sabor,
        valor,
        quantidade,
        mesa,
        observacao,
        userId: interaction.user.id,
        username: interaction.user.username,

        // >>> metadados para n8n/planilha
        channelId,
        channelName: channelName2,
        guildId,
        guildName,
        messageJumpUrl,
      });

      await interaction.editReply(
        `✅ Registrado: **${ctx.tipo} / ${ctx.marca} / ${ctx.sabor}** — **${quantidade}x** a **R$ ${Number(valor).toFixed(2)}**.\n` +
        `📍 **${mesa}**${observacao ? ` · 📝 ${observacao}` : ''}\n` +
        (channelName2 ? `#️⃣ Canal: **${channelName2}**` : '')
      );
    } catch (e) {
      console.error('SAVE ERROR', e?.response?.status, e?.response?.data || e.message);
      await interaction.editReply('❌ Falha ao salvar no n8n.');
    }
  }
});

client.login(DISCORD_TOKEN);
