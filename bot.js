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

const WEBHOOK_TIPOS     = process.env.WEBHOOK_TIPOS;     // { tipo, ...meta } -> { options:[...marcas] }
const WEBHOOK_SABORES   = process.env.Webhook_Sabores || process.env.WEBHOOK_SABORES; // compat
const WEBHOOK_LASTPRICE = process.env.WEBHOOK_LASTPRICE; // { tipo, marca, sabor, ...meta } -> { lastPrice }
const WEBHOOK_SAVE      = process.env.WEBHOOK_SAVE;      // { ...dados, ...meta }

if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN ausente');
for (const [k, v] of Object.entries({ WEBHOOK_TIPOS, WEBHOOK_SABORES, WEBHOOK_SAVE })) {
  if (!v) throw new Error(`${k} ausente nas variáveis de ambiente`);
}
const HAS_LASTPRICE = !!WEBHOOK_LASTPRICE;

// opcional: restringe por nomes de canais (ex: "absolem-nome-da-cidade,canal-teste")
const CHANNEL_WHITELIST = (process.env.CHANNEL_WHITELIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/* ================== UI HELPERS ================== */
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

/* === meta helpers === */
async function resolveChannelName(client, interactionOrMessage) {
  try {
    const channel = interactionOrMessage.channel
      ?? (interactionOrMessage.channelId
            ? await client.channels.fetch(interactionOrMessage.channelId)
            : null);
    if (!channel) return null;
    if ('name' in channel && channel.name) return channel.name;
    if ('isDMBased' in channel && channel.isDMBased?.()) return 'DM';
    return channel?.name ?? null;
  } catch { return null; }
}
async function buildMetaFromInteraction(client, interaction) {
  const channelName = await resolveChannelName(client, interaction);
  return {
    guildId:        interaction.guildId || null,
    guildName:      interaction.guild?.name || null,
    channelId:      interaction.channelId || null,
    channelName,
    userId:         interaction.user?.id || interaction.member?.user?.id || null,
    username:       interaction.user?.username || interaction.member?.user?.username || null,
    messageJumpUrl: interaction.message?.url || null,
  };
}
function allowedByWhitelist(channelName) {
  if (CHANNEL_WHITELIST.length === 0) return true;
  return channelName && CHANNEL_WHITELIST.includes(channelName);
}

/* === webhooks que aceitam meta === */
async function fetchMarcas(tipo, meta = {}) {
  const data = await post(WEBHOOK_TIPOS, { tipo, ...meta });
  return Array.isArray(data?.options) ? data.options : [];
}
async function fetchSabores(tipo, marca, meta = {}) {
  const data = await post(WEBHOOK_SABORES, { tipo, marca, ...meta });
  return Array.isArray(data?.options) ? data.options : [];
}
async function fetchLastPrice(tipo, marca, sabor, meta = {}) {
  if (!HAS_LASTPRICE) return '';
  try {
    const data = await post(WEBHOOK_LASTPRICE, { tipo, marca, sabor, ...meta });
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message]
});

client.once(Events.ClientReady, () => console.log(`✅ Bot Tabacaria online: ${client.user.tag}`));

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
    const reply = { content: '⚠️ Use dentro de um servidor.', ephemeral: true };
    if (interaction.isButton()) return interaction.reply(reply);
    if (interaction.isModalSubmit()) return interaction.reply(reply);
    return;
  }

  const channelName = await resolveChannelName(client, interaction);
  if (!allowedByWhitelist(channelName)) {
    const reply = { content: '⛔ Canal não habilitado.', ephemeral: true };
    if (interaction.isButton()) return interaction.reply(reply);
    if (interaction.isModalSubmit()) return interaction.reply(reply);
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
      const meta = await buildMetaFromInteraction(client, interaction);
      const marcas = await fetchMarcas(ctx.tipo, meta);
      return interaction.update({
        content: `🛒 **${ctx.tipo}** — escolha a **Marca**:`,
        components: [...chunkButtons(marcas, 'marca'), backRow('main')]
      });
    }
    if (to === 'marca') {
      const meta = await buildMetaFromInteraction(client, interaction);
      const sabores = await fetchSabores(ctx.tipo, ctx.marca, meta);
      return interaction.update({
        content: `🛒 **${ctx.tipo} / ${ctx.marca}** — escolha o **Sabor**:`,
        components: [...chunkButtons(sabores, 'sabor'), backRow('tipo')]
      });
    }
  }

  // Passo 1: Tipo → marcas (manda meta no 1º webhook)
  if (interaction.isButton() && interaction.customId.startsWith('item:')) {
    const tipo = interaction.customId.split(':')[1];
    ctxByUser.set(interaction.user.id, { tipo });

    try {
      const meta = await buildMetaFromInteraction(client, interaction);
      const marcas = await fetchMarcas(tipo, meta);

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

  // Passo 2: Marca → sabores (manda meta)
  if (interaction.isButton() && interaction.customId.startsWith('marca:')) {
    const marca = interaction.customId.split(':')[1];
    const ctx = ctxByUser.get(interaction.user.id) || {};
    ctx.marca = marca;
    ctxByUser.set(interaction.user.id, ctx);

    try {
      const meta = await buildMetaFromInteraction(client, interaction);
      const sabores = await fetchSabores(ctx.tipo, ctx.marca, meta);

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

  // Passo 3: Sabor → modal (manda meta pro lastPrice)
  if (interaction.isButton() && interaction.customId.startsWith('sabor:')) {
    const sabor = interaction.customId.split(':')[1];
    const ctx = ctxByUser.get(interaction.user.id) || {};
    ctx.sabor = sabor;
    ctxByUser.set(interaction.user.id, ctx);

    const meta = await buildMetaFromInteraction(client, interaction);
    const lastPrice = await fetchLastPrice(ctx.tipo, ctx.marca, ctx.sabor, meta);

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

  // Passo 4: Modal → save (manda meta)
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

    const meta = await buildMetaFromInteraction(client, interaction);

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
        ...meta, // channelId, channelName, guildId, guildName, messageJumpUrl...
      });

      await interaction.editReply(
        `✅ Registrado: **${ctx.tipo} / ${ctx.marca} / ${ctx.sabor}** — **${quantidade}x** a **R$ ${Number(valor).toFixed(2)}**.\n` +
        `📍 **${mesa}**${observacao ? ` · 📝 ${observacao}` : ''}\n` +
        (meta.channelName ? `#️⃣ Canal: **${meta.channelName}**` : '')
      );
    } catch (e) {
      console.error('SAVE ERROR', e?.response?.status, e?.response?.data || e.message);
      await interaction.editReply('❌ Falha ao salvar no n8n.');
    }
  }
});

client.login(DISCORD_TOKEN);
