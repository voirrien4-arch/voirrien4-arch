// Delta Gold - Baileys WhatsApp Connection
// Handles socket lifecycle, reconnection, message routing, and web command execution

import * as Baileys from '@whiskeysockets/baileys';
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = Baileys;
import pino from 'pino';
import fs from 'fs';
import { handleCommand } from './commands.js';

const logger = pino({ level: 'silent' });
let sock = null;
const startTime = Date.now();

const botStatus = {
  connected: false,
  phone: null,
  registered: false,
  restarts: 0,
};

export async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      browser: ['Delta Gold', 'Safari', '3.0'],
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
    });

    botStatus.registered = sock.authState.creds.registered;

    // Save credentials on update
    sock.ev.on('creds.update', saveCreds);

    // Connection lifecycle
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'close') {
        botStatus.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('❌ Session expirée. Suppression des credentials...');
          try { fs.rmSync('./auth_info', { recursive: true, force: true }); } catch {}
          botStatus.registered = false;
        }

        botStatus.restarts++;
        const delay = statusCode === DisconnectReason.loggedOut ? 2000 : 5000;
        console.log(`🔄 Reconnexion dans ${delay / 1000}s... (tentative #${botStatus.restarts})`);
        setTimeout(() => startBot(), delay);

      } else if (connection === 'open') {
        botStatus.connected = true;
        botStatus.registered = true;
        botStatus.phone = sock.user?.id?.split(':')[0] || null;
        console.log(`✅ Delta Gold connecté: +${botStatus.phone}`);
      }
    });

    // Message handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        try {
          await handleCommand(sock, msg, { requestPairingCode });
        } catch (err) {
          console.error('Handler error:', err.message);
        }
      }
    });

  } catch (err) {
    console.error('Bot start error:', err.message);
    botStatus.restarts++;
    setTimeout(() => startBot(), 5000);
  }
}

// ── Request Pairing Code ──
export async function requestPairingCode(phone) {
  if (!sock) throw new Error('Bot non initialisé, veuillez patienter...');
  const cleanPhone = phone.replace(/[\s\-\(\)\+]/g, '');
  try {
    const code = await sock.requestPairingCode(cleanPhone);
    return code;
  } catch (err) {
    throw new Error(`Impossible de générer le code: ${err.message}`);
  }
}

// ── Get Bot Status ──
export function getBotStatus() {
  return {
    connected: botStatus.connected,
    phone: botStatus.phone,
    registered: botStatus.registered,
    restarts: botStatus.restarts,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

// ── Send Command from Web UI ──
// Creates a synthetic message and routes it through the command handler
export async function sendMessage(commandText, isFromWeb = false) {
  if (!sock) throw new Error('Bot non initialisé. Veuillez patienter...');

  const ownerNum = process.env.OWNER_NUMBER || '224612908366';
  const ownerJid = ownerNum + '@s.whatsapp.net';

  // Build a synthetic WhatsApp message
  const syntheticMsg = {
    key: {
      remoteJid: ownerJid,
      fromMe: false,
      id: 'WEB-' + Date.now(),
      participant: ownerJid,
    },
    pushName: 'Web Dashboard',
    message: {
      conversation: commandText,
    },
  };

  // Capture the bot's reply by intercepting sendMessage
  let capturedResponse = '';
  const originalSend = sock.sendMessage.bind(sock);

  sock.sendMessage = async (jid, content, options) => {
    // Capture text content
    if (content?.image?.caption) {
      capturedResponse = content.image.caption;
    } else if (content?.text) {
      capturedResponse = content.text;
    } else if (content?.video?.caption) {
      capturedResponse = content.video.caption;
    }

    // Actually send to the owner's WhatsApp chat
    return originalSend(jid, content, options);
  };

  try {
    await handleCommand(sock, syntheticMsg, { requestPairingCode });
  } finally {
    // Restore original sendMessage
    sock.sendMessage = originalSend;
  }

  return capturedResponse || 'Commande exécutée (pas de réponse textuelle)';
}
