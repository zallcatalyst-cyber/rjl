const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    downloadContentFromMessage,
    generateWAMessageFromContent,
    prepareWAMessageMedia
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fetch = require('node-fetch');
const axios = require('axios');
const readline = require('readline');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const FormData = require('form-data');
const similarity = require('similarity');

// Fungsi tambah metadata stiker (pack & author) ke WebP buffer
function addStickerMetadata(buffer, pack, author) {
    try {
        const packBuffer = Buffer.from(pack, 'utf8');
        const authorBuffer = Buffer.from(author, 'utf8');

        // Format EXIF untuk stiker WhatsApp menggunakan JSON di field UserComment
        const json = { 'sticker-pack-name': pack, 'sticker-pack-publisher': author };
        const exifJson = Buffer.from(JSON.stringify(json), 'utf8');

        // Struktur EXIF: header + IFD + data
        const exifHeader = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
        const tiffHeader = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]); // Little-endian TIFF

        // IFD dengan 1 entry: tag 0x9286 (UserComment)
        const ifdCount = Buffer.alloc(2); ifdCount.writeUInt16LE(1, 0);
        const dataOffset = 8 + 2 + 12 + 4; // tiffHeader + count + 1 IFD entry + next IFD ptr

        const ifdEntry = Buffer.alloc(12);
        ifdEntry.writeUInt16LE(0x9286, 0);  // tag: UserComment
        ifdEntry.writeUInt16LE(0x0002, 2);  // type: ASCII
        ifdEntry.writeUInt32LE(exifJson.length, 4); // count
        ifdEntry.writeUInt32LE(dataOffset, 8); // offset ke data

        const nextIfd = Buffer.alloc(4); // 0x00000000 = tidak ada IFD berikutnya

        const exifData = Buffer.concat([tiffHeader, ifdCount, ifdEntry, nextIfd, exifJson]);
        const exifChunk = Buffer.concat([exifHeader, exifData]);

        // Cari posisi RIFF WebP dan sisipkan EXIF chunk
        // Format WebP: RIFF[4] SIZE[4] WEBP[4] chunks...
        if (buffer.slice(0, 4).toString() !== 'RIFF' || buffer.slice(8, 12).toString() !== 'WEBP') {
            return buffer; // Bukan WebP, kembalikan apa adanya
        }

        // Buat EXIF chunk: "EXIF" + size (4 byte LE) + data (padding genap)
        const exifTag = Buffer.from('EXIF');
        const exifSize = Buffer.alloc(4);
        exifSize.writeUInt32LE(exifChunk.length, 0);
        const padding = exifChunk.length % 2 !== 0 ? Buffer.from([0x00]) : Buffer.alloc(0);
        const exifChunkFull = Buffer.concat([exifTag, exifSize, exifChunk, padding]);

        // Sisipkan setelah header RIFF+WEBP (12 byte pertama)
        const riffHeader = buffer.slice(0, 12);
        const webpBody = buffer.slice(12);
        const newBody = Buffer.concat([exifChunkFull, webpBody]);

        // Update ukuran RIFF
        const newRiff = Buffer.concat([riffHeader, newBody]);
        newRiff.writeUInt32LE(newRiff.length - 8, 4);

        return newRiff;
    } catch (e) {
        console.error("Metadata stiker error:", e);
        return buffer; // Fallback ke buffer original jika gagal
    }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// KONFIGURASI BOT & OWNER
const OWNER_NUMBERS = ["6283171413750"];

// Link saluran untuk preview
const CHANNEL_URL = "https://whatsapp.com/channel/0029VbCrkgg7DAX1vTdGcg0i";

// Info global bot
global.ownername = "RIJAL-MD";
global.version = "1.0.0";
global.botz = { public: true };

// Fungsi hitung runtime
function runtime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${d}h ${h}j ${m}m ${s}d`;
}

// Inisialisasi Database Sederhana di Memori
global.db = {
    data: {
        users: {}
    }
};

function checkUserDb(senderNumber) {
    if (!global.db.data.users[senderNumber]) {
        global.db.data.users[senderNumber] = {
            exp: 1000,
            money: 5000,
            suit: 0,
            win: 0
        };
    }
}

async function downloadMedia(message, messageType) {
    const stream = await downloadContentFromMessage(message, messageType);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

async function getBuffer(url, options = {}) {
    try {
        const res = await axios({
            method: "get",
            url,
            headers: { 'DNT': 1, 'Upgrade-Insecure-Requests': 1 },
            ...options,
            responseType: 'arraybuffer'
        });
        return res.data;
    } catch (e) {
        return null;
    }
}

async function uploadTelegraph(buffer, filename) {
    try {
        if (!fs.existsSync("./tmp")) fs.mkdirSync("./tmp");
        const tempPath = "./tmp/" + filename;
        fs.writeFileSync(tempPath, buffer);

        const form = new FormData();
        form.append("images", fs.createReadStream(tempPath));

        const { data } = await axios.post(
            "https://telegraph.zorner.men/upload",
            form,
            { headers: form.getHeaders() }
        );

        fs.unlinkSync(tempPath);
        return data?.links?.[0] || null;
    } catch (e) {
        console.error("Upload Telegraph Gagal:", e);
        return null;
    }
}

function convertToSticker(buffer, isVideo = false) {
    return new Promise((resolve, reject) => {
        const inputPath = path.join(__dirname, `temp_input_${Date.now()}`);
        const outputPath = path.join(__dirname, `temp_output_${Date.now()}.webp`);
        
        fs.writeFileSync(inputPath, buffer);
        
        let ff = ffmpeg(inputPath);
        if (isVideo) {
            ff.outputOptions([
                '-vcodec', 'libwebp',
                '-vf', "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease,fps=15,pad=512:512:(512-iw)/2:(512-ih)/2:color=white@0,split[a][b];[a]palettegen=reserve_transparent=on:transparency_color=ffffff[p];[b][p]paletteuse",
                '-loop', '0',
                '-ss', '00:00:00',
                '-t', '00:00:06',
                '-preset', 'default',
                '-an',
                '-vsync', '0'
            ]);
        } else {
            ff.outputOptions([
                '-vcodec', 'libwebp',
                '-vf', "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease,pad=512:512:(512-iw)/2:(512-ih)/2:color=white@0"
            ]);
        }

        ff.toFormat('webp')
          .save(outputPath)
          .on('end', () => {
              let webpBuffer = fs.readFileSync(outputPath);
              try { fs.unlinkSync(inputPath); } catch(e){}
              try { fs.unlinkSync(outputPath); } catch(e){}
              const now = new Date();
              const dd = String(now.getDate()).padStart(2,'0');
              const mm = String(now.getMonth()+1).padStart(2,'0');
              const yyyy = now.getFullYear();
              const hh = String(now.getHours()).padStart(2,'0');
              const min = String(now.getMinutes()).padStart(2,'0');
              const timestamp = `${dd}/${mm}/${yyyy} ${hh}:${min}`;
              webpBuffer = addStickerMetadata(webpBuffer, `📅 ${timestamp}`, '✨ Created by Rijal');
              resolve(webpBuffer);
          })
          .on('error', (err) => {
              try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch(e){}
              try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch(e){}
              reject(err);
          });
    });
}

async function igdl(url) {
    let data = JSON.stringify({ url, type: 'video' });
    const res = await axios.post('https://vdraw.ai/api/v1/instagram/ins-info', data, {
        headers: { 'Content-Type': 'application/json' },
    });
    return res.data?.data;
}

async function searchTikTok(query) {
    const { data } = await axios.get('https://tikwm.com/api/feed/search', {
        params: { keywords: query, count: 1 },
        timeout: 20000
    });
    if (!data || data.code !== 0 || !data.data?.videos?.length) throw new Error('Hasil tidak ditemukan');
    const v = data.data.videos[0];
    return `https://www.tiktok.com/@${v.author.unique_id}/video/${v.video_id}`;
}

async function getTikTok(url) {
    const { data } = await axios.get('https://tikwm.com/api/', {
        params: { url, hd: 1 },
        timeout: 20000
    });
    if (!data || data.code !== 0) throw new Error('Gagal mengambil data TikTok');
    return data.data;
}

function formatNumber(num = 0) { return num.toLocaleString(); }
function pickRandom(list) { return list[Math.floor(Math.random() * list.length)]; }

// ID channel dari link: https://whatsapp.com/channel/0029VbCrkgg7DAX1vTdGcg0i
// Ganti CHANNEL_ID dengan ID channel asli kamu (bisa dicek pakai .cekidch)
const CHANNEL_ID = "120363424394134903@newsletter";

// Fungsi preview channel pakai forwardedNewsletterMessageInfo
// Ini yang muncul di SEMUA WA (bukan hanya bot sendiri)
function getChannelPreview(title = "RIJAL-MULTI DEVICE", body = "Bot WhatsApp Multi Device") {
    return {
        forwardedNewsletterMessageInfo: {
            newsletterJid: CHANNEL_ID,
            newsletterName: title,
            serverMessageId: -1
        }
    };
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.suit = sock.suit || {};
    sock.tebakbendera = sock.tebakbendera || {};

    // PAIRING SYSTEM
    if (!sock.authState.creds.registered) {
        console.clear();
        console.log("\x1b[36m%s\x1b[0m", "=======================================");
        console.log("\x1b[32m%s\x1b[0m", "      BOT WA MULTI DEVICE PAIRING      ");
        console.log("\x1b[36m%s\x1b[0m", "=======================================");
        
        const phoneNumber = await question('\x1b[37m[?] Masukkan Nomor WhatsApp Bot Anda (Contoh: 628xxx): \x1b[0m');
        
        const pairingCode = await sock.requestPairingCode(phoneNumber.trim());
        
        console.log("\n\x1b[33m%s\x1b[0m", "---------------------------------------");
        console.log(`\x1b[32m KODE PAIRING ANDA: \x1b[47m\x1b[30m  ${pairingCode}  \x1b[0m`);
        console.log("\x1b[33m%s\x1b[0m", "---------------------------------------");
        console.log("\n[!] Buka WhatsApp di HP Anda -> Perangkat Tertaut -> Tautkan Perangkat -> Tautkan dengan nomor telepon.");
        console.log("[!] Masukkan kode di atas pada kolom yang tersedia di HP Anda.");
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom) 
                ? lastDisconnect.error.output?.statusCode 
                : null;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`\x1b[31m[!] Koneksi terputus. Kode: ${statusCode}. Reconnect: ${shouldReconnect}\x1b[0m`);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.clear();
            console.log("\x1b[32m%s\x1b[0m", "===============================================");
            console.log("\x1b[32m%s\x1b[0m", "  ⚡ BOT RIJAL-MULTI DEVICE BERHASIL TERHUBUNG! ⚡ ");
            console.log("\x1b[32m%s\x1b[0m", "===============================================");
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message) return;
        if (m.key.fromMe) return; // Abaikan pesan dari bot sendiri

        const from = m.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const rawSender = m.key.participant || m.key.remoteJid;
        const sender = rawSender.split(':')[0].split('@')[0];
        
        const msgType = Object.keys(m.message)[0];
        const msgContent = m.message[msgType];

        checkUserDb(sender);

        // Ambil teks pesan
        let body = '';
        if (msgType === 'conversation') body = m.message.conversation || '';
        else if (msgType === 'extendedTextMessage') body = m.message.extendedTextMessage?.text || '';
        else if (msgType === 'imageMessage') body = m.message.imageMessage?.caption || '';
        else if (msgType === 'videoMessage') body = m.message.videoMessage?.caption || '';

        // Ambil mentionedJid dengan benar
        const mentionedJid = msgContent?.contextInfo?.mentionedJid || 
                             m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

        // Ambil quoted message dengan benar
        const contextInfo = msgContent?.contextInfo || 
                            m.message?.extendedTextMessage?.contextInfo || null;
        const quotedMessage = contextInfo?.quotedMessage || null;
        const quotedParticipant = contextInfo?.participant || null;
        const quotedText = quotedMessage 
            ? (quotedMessage.conversation || 
               quotedMessage.extendedTextMessage?.text || 
               quotedMessage.imageMessage?.caption || 
               quotedMessage.videoMessage?.caption || '') 
            : '';
        const mime = quotedMessage ? Object.keys(quotedMessage)[0] : '';

        // Handler game suit pvp
        if (body) {
            let room = Object.values(sock.suit).find(room => 
                room.id && room.status && 
                [room.p.split('@')[0], room.p2?.split('@')[0]].includes(sender)
            );

            if (room) {
                const pClean = room.p.split('@')[0];
                const p2Clean = room.p2?.split('@')[0];
                let win = ''; let tie = false;

                // Respons terima/tolak di grup
                if (sender === p2Clean && /^(acc(ept)?|terima|gas|oke?|tolak|gamau|nanti|ga(k.)?bisa)/i.test(body) && isGroup && room.status === 'wait') {
                    if (/^(tolak|gamau|nanti|ga(k.)?bisa)/i.test(body)) {
                        await sock.sendMessage(from, { text: `@${p2Clean} menolak suit, suit dibatalkan`, mentions: [room.p2] }, { quoted: m });
                        clearTimeout(room.waktu);
                        delete sock.suit[room.id];
                        return;
                    }
                    room.status = 'play';
                    room.asal = from;
                    clearTimeout(room.waktu);
                    await sock.sendMessage(from, { 
                        text: `Suit telah dikirimkan ke private chat\n@${pClean} dan \n@${p2Clean}\n\nSilahkan pilih di private chat!`, 
                        mentions: [room.p, room.p2] 
                    });
                    const instruksiSuit = `*[ S U I T   P V P ]*\n\n👉 Ketik *GUNTING*\n👉 Ketik *BATU*\n👉 Ketik *KERTAS*`;
                    await sock.sendMessage(room.p, { text: instruksiSuit });
                    await sock.sendMessage(room.p2, { text: instruksiSuit });
                    return;
                }

                let jwb = sender === pClean;
                let jwb2 = sender === p2Clean;
                let reg = /^(gunting|batu|kertas)/i;

                if (jwb && reg.test(body) && !room.pilih && !isGroup) {
                    room.pilih = reg.exec(body.toLowerCase())[0];
                    room.text = body;
                    await sock.sendMessage(room.p, { text: `Kamu memilih *${body}*` });
                }
                if (jwb2 && reg.test(body) && !room.pilih2 && !isGroup) {
                    room.pilih2 = reg.exec(body.toLowerCase())[0];
                    room.text2 = body;
                    await sock.sendMessage(room.p2, { text: `Kamu memilih *${body}*` });
                }

                if (room.pilih && room.pilih2) {
                    let g = /gunting/i, b = /batu/i, k = /kertas/i;
                    let stage = room.pilih, stage2 = room.pilih2;
                    if (b.test(stage) && g.test(stage2)) win = room.p;
                    else if (b.test(stage) && k.test(stage2)) win = room.p2;
                    else if (g.test(stage) && k.test(stage2)) win = room.p;
                    else if (g.test(stage) && b.test(stage2)) win = room.p2;
                    else if (k.test(stage) && b.test(stage2)) win = room.p;
                    else if (k.test(stage) && g.test(stage2)) win = room.p2;
                    else if (stage === stage2) tie = true;

                    let hasilTeks = `*═ [ HASIL SUIT PvP ] ═*\n\n`;
                    if (tie) hasilTeks += `➔ HASIL: *SERI* 🤝\n\n`;
                    hasilTeks += `@${pClean} memilih (${room.text}) ${tie ? '' : room.p === win ? '👉 *MENANG* 🏆' : '👉 *KALAH* 😢'}\n`;
                    hasilTeks += `@${p2Clean} memilih (${room.text2}) ${tie ? '' : room.p2 === win ? '👉 *MENANG* 🏆' : '👉 *KALAH* 😢'}`;

                    await sock.sendMessage(room.asal, { 
                        text: hasilTeks, 
                        mentions: [room.p, room.p2] 
                    });
                    delete sock.suit[room.id];
                }
            }
        }

        // Handler jawaban tebak bendera
        if (body && sock.tebakbendera[from]) {
            const tbRoom = sock.tebakbendera[from];
            const jawabanBenar = tbRoom.data.name;
            const threshold = 0.72;
            if (body.toLowerCase() === jawabanBenar.toLowerCase()) {
                checkUserDb(sender);
                global.db.data.users[sender].exp += tbRoom.poin;
                clearTimeout(tbRoom.timer);
                delete sock.tebakbendera[from];
                await sock.sendMessage(from, { 
                    text: `✅ *Benar!* +${tbRoom.poin} XP\nJawabannya memang *${jawabanBenar}*! 🎉` 
                }, { quoted: m });
                return;
            } else if (similarity(body.toLowerCase(), jawabanBenar.toLowerCase()) >= threshold) {
                await sock.sendMessage(from, { text: `🔥 *Hampir benar!* Coba lagi...` }, { quoted: m });
                return;
            }
        }

        if (!body) return;

        const prefix = /^[./!#]/gi.test(body) ? body.match(/^[./!#]/gi)[0] : '#';
        const isCmd = body.startsWith(prefix);
        const command = isCmd ? body.slice(prefix.length).trim().split(/ +/).shift().toLowerCase() : '';
        const args = body.trim().split(/ +/).slice(1);
        const text = args.join(' ');

        const isOwner = OWNER_NUMBERS.includes(sender);

        let isAdmins = false;
        let isBotAdmins = false;
        let participants = [];
        if (isGroup) {
            try {
                const groupMetadata = await sock.groupMetadata(from);
                participants = groupMetadata.participants;
                const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                const senderJid = sender + '@s.whatsapp.net';
                isAdmins = participants.some(p => (p.id === rawSender || p.id === senderJid) && (p.admin === 'admin' || p.admin === 'superadmin'));
                isBotAdmins = participants.some(p => p.id === botId && (p.admin === 'admin' || p.admin === 'superadmin'));
            } catch (e) { }
        }

        const react = async (emoji) => {
            try {
                await sock.sendMessage(from, { react: { text: emoji, key: m.key } });
            } catch(e) {}
        };
        
        const replyWait = async () => {
            await sock.sendMessage(from, { text: "⏳ Sabar ya ganteng, lagi diproses..." }, { quoted: m });
        };

        if (isCmd) {
            console.log(`\x1b[35m🔥 [COMMAND]\x1b[0m User: ${sender} | Executed: ${prefix}${command}`);
        }

        // AI Image Maker
        const aiMakerRegex = /^(tobotak|tochibi|tofunk|tofigura|tofigurav2|tofigurav3|toghibli|tohijab|tojapanese|tojepang|tokacamata|tokamboja|tolego|toliquor|tomaid|tomirror|tomoai|tomonyet|topacar|topeci|topiramida|toputih|toreal|toroblox|toroh|totato|totua|toviking|tozombie|tounderground|tohitam)$/i;
        if (isCmd && aiMakerRegex.test(command)) {
            const currentMsgType = quotedMessage ? Object.keys(quotedMessage)[0] : msgType;

            if (!/imageMessage/.test(currentMsgType)) {
                return sock.sendMessage(from, { 
                    text: `✨ *AI IMAGE CONVERTER*\n\nReply/Kirim gambar dengan caption *${prefix + command}*`,
                    contextInfo: getChannelPreview("AI Image Converter", "30+ filter AI tersedia!")
                }, { quoted: m });
            }

            try {
                await replyWait();
                await react("✨");

                let targetMedia = quotedMessage ? quotedMessage.imageMessage : m.message.imageMessage;
                let buffer = await downloadMedia(targetMedia, 'image');
                let filename = `faa_${Date.now()}.jpg`;

                let imageUrl = await uploadTelegraph(buffer, filename);
                if (!imageUrl) return sock.sendMessage(from, { text: "❌ Upload media ke server gagal!" }, { quoted: m });

                let apiUrl = `https://api-faa.my.id/faa/${command}?url=${encodeURIComponent(imageUrl)}`;
                let resBuffer = await getBuffer(apiUrl);
                if (!resBuffer) return sock.sendMessage(from, { text: "❌ Sistem API sedang error, coba lagi nanti." }, { quoted: m });

                await sock.sendMessage(from, { 
                    image: resBuffer, 
                    caption: `✨ Sukses convert ke gaya *${command}*!` 
                }, { quoted: m });
                await react("✅");
            } catch (err) {
                console.error(err);
                await react("❌");
            }
            return;
        }

        if (!isCmd) return;

        switch (command) {
            case 'menu':
            case 'help': {
                await react('💦');

                const pushname = m.pushName || sender;
                const latensi = Date.now() - m.messageTimestamp * 1000;

                const menuText = `
\`Hai Kak ${pushname}\`🎗

◤───「 \`INFO USER\` 」──✦
> ⎆  [ Nama : ${pushname}
> ⎆  [ Role : ${isOwner ? '👑 Dewa' : 'Gratisan😩'}
> ⎆  [ Mode : ${global.botz.public ? 'Public' : 'Private'}
◣──────────❈

◤───「 \`INFO BOT\` 」──✦
> ⎆ Runtime : ${runtime(process.uptime())}
> ⎆ Versi : ${global.version}
> ⎆ Respon : ${Math.abs(latensi).toFixed(0)}ms
◣─────────────✦

◤───「 \`STICKER\` 」──✦
> ${prefix}brat
> ${prefix}brathd
> ${prefix}bratvid
> ${prefix}s
> ${prefix}smeme
◣─────────────✦

◤───「 \`DOWNLOADER\` 」──✦
> ${prefix}ig
> ${prefix}tt
◣─────────────✦

◤───「 \`GROUP\` 」──✦
> ${prefix}hidetag
> ${prefix}promote
> ${prefix}demote
> ${prefix}kick
◣─────────────✦

◤───「 \`GAME\` 」──✦
> ${prefix}suitpvp
> ${prefix}slot
> ${prefix}tebakbendera
◣─────────────✦

◤───「 \`FUN\` 」──✦
> ${prefix}cektt
◣─────────────✦

◤───「 \`MAKER\` 」──✦
> ${prefix}iqc
> ${prefix}tohitam
◣─────────────✦

◤───「 \`SALURAN\` 」──✦
> ${prefix}cekidch
> ${prefix}createch
◣─────────────✦

> Ketik *${prefix}owner* untuk kontak owner`;

                try {
                    const menuImageBuffer = await getBuffer('https://files.catbox.moe/4mfccw.jpeg');
                    if (menuImageBuffer) {
                        await sock.sendMessage(from, {
                            image: menuImageBuffer,
                            caption: menuText,
                            contextInfo: getChannelPreview("RIJAL-MULTI DEVICE", "Klik untuk join saluran resmi bot!")
                        }, { quoted: m });
                    } else {
                        await sock.sendMessage(from, {
                            text: menuText,
                            contextInfo: getChannelPreview("RIJAL-MULTI DEVICE", "Klik untuk join saluran resmi bot!")
                        }, { quoted: m });
                    }
                } catch (e) {
                    await sock.sendMessage(from, {
                        text: menuText,
                        contextInfo: getChannelPreview("RIJAL-MULTI DEVICE", "Klik untuk join saluran resmi bot!")
                    }, { quoted: m });
                }
                break;
            }

            case 'owner': {
                const ownerContact = OWNER_NUMBERS[0] + '@s.whatsapp.net';
                await sock.sendMessage(from, {
                    text: `◤───「 \`KONTAK OWNER\` 」──✦\n> ⎆ WA : wa.me/${OWNER_NUMBERS[0]}\n> ⎆ TikTok : tiktok.com/@zyyzall\n> ⎆ Instagram : instagram.com/abcdeezall\n> ⎆ Saluran : ${CHANNEL_URL}\n◣─────────────✦`,
                    mentions: [ownerContact],
                    contextInfo: getChannelPreview("Kontak Owner", "Hubungi owner bot di sini")
                }, { quoted: m });
                break;
            }

            case 'cekidch':
            case 'idch': {
                const input = text || quotedText;
                if (!input) return sock.sendMessage(from, { 
                    text: "⚠️ Masukkan minimal 1 link channel WhatsApp!\nContoh: " + prefix + command + " https://whatsapp.com/channel/xxxxx",
                    contextInfo: getChannelPreview()
                }, { quoted: m });
                
                await replyWait();
                const links = input.split(/\s+/).slice(0, 10);
                let captionArr = [];

                for (let link of links) {
                    if (!link.includes("https://whatsapp.com/channel/")) {
                        captionArr.push(`[ ! ] Link tidak valid: ${link}`);
                        continue;
                    }
                    let idPart = link.split('https://whatsapp.com/channel/')[1];
                    try {
                        let res = await sock.newsletterMetadata("invite", idPart);
                        captionArr.push(
                            `*${res.name || "Tanpa Nama"}*\n` +
                            `• ID Channel: ${res.id}\n` +
                            `• Pengikut: ${formatNumber(res.subscribers || 0)}\n` +
                            `• Verifikasi: ${res.verification || "–"}\n` +
                            `• State: ${res.state || "–"}\n`
                        );
                    } catch (err) {
                        captionArr.push(`[ x ] Gagal cek channel: ${link}`);
                    }
                }
                await sock.sendMessage(from, { 
                    text: captionArr.join("\n\n"),
                    contextInfo: getChannelPreview("Cek ID Channel", "Info channel WhatsApp")
                }, { quoted: m });
                break;
            }

            case 'createch':
            case 'createchannel': {
                if (!isOwner) return sock.sendMessage(from, { text: "❌ Perintah ini khusus Owner Bot saja!" }, { quoted: m });
                if (!text) return sock.sendMessage(from, { text: "📛 *Gunakan format:*\n" + prefix + "createch <nama>|<deskripsi>" }, { quoted: m });

                let [name, desc] = text.split("|");
                if (!name || !name.trim()) return sock.sendMessage(from, { text: "❌ Harap tuliskan nama channel." }, { quoted: m });
                desc = desc ? desc.trim() : "Tidak ada deskripsi.";

                await replyWait();
                await react("👁️‍🗨️");

                let imageUrl = "https://files.catbox.moe/xpntd8.jpg"; 
                const currentMsgTypeForCh = quotedMessage ? Object.keys(quotedMessage)[0] : msgType;

                if (/imageMessage/.test(currentMsgTypeForCh)) {
                    try {
                        let targetMedia = quotedMessage ? quotedMessage.imageMessage : m.message.imageMessage;
                        let mediaBuffer = await downloadMedia(targetMedia, 'image');
                        let uploadedUrl = await uploadTelegraph(mediaBuffer, `avatar_${Date.now()}.jpg`);
                        if (uploadedUrl) imageUrl = uploadedUrl;
                    } catch (e) {
                        console.error("Upload gambar channel gagal:", e);
                    }
                }

                try {
                    const newsletter = await sock.newsletterCreate(name.trim(), {
                        description: desc,
                        picture: imageUrl
                    });
                    const invite = newsletter?.invite || newsletter?.id || "❌ Tidak tersedia";
                    const id = newsletter?.id || "❓";
                    let bufferImg = await getBuffer(imageUrl);

                    await sock.sendMessage(from, {
                        text: `✅ *Channel Berhasil Dibuat!*\n\n📡 *Nama:* ${name.trim()}\n📝 *Deskripsi:* ${desc}\n🆔 *ID:* ${id}\n🔗 *Link:* https://whatsapp.com/channel/${invite}`,
                        contextInfo: {
                            externalAdReply: {
                                title: name.trim(),
                                body: "Channel berhasil dibuat via RIJAL-MULTI DEVICE",
                                sourceUrl: `https://whatsapp.com/channel/${invite}`,
                                thumbnail: bufferImg,
                                mediaType: 1,
                                renderLargerThumbnail: true,
                            },
                        },
                    }, { quoted: m });
                } catch (err) {
                    console.error("Gagal buat channel:", err);
                    sock.sendMessage(from, { text: "✖️ *Gagal membuat channel.* Akun nomor bot belum memenuhi syarat fitur WhatsApp." }, { quoted: m });
                }
                break;
            }

            case 'hidetag':
            case 'ht': {
                if (!isGroup) return sock.sendMessage(from, { text: "❌ Fitur ini hanya untuk di dalam grup!" }, { quoted: m });
                if (!isAdmins && !isOwner) return sock.sendMessage(from, { text: "❌ Hanya Admin grup yang bisa hidetag!" }, { quoted: m });
                
                let message = text || quotedText;
                if (!message) return sock.sendMessage(from, { text: 'Kirim teks atau reply pesan untuk dihidetag.' }, { quoted: m });

                await replyWait();
                let member = participants.map(u => u.id);
                await sock.sendMessage(from, { text: message, mentions: member });
                break;
            }

            case 'promote': {
                if (!isGroup) return sock.sendMessage(from, { text: "❌ Fitur ini khusus Grup!" }, { quoted: m });
                if (!isAdmins && !isOwner) return sock.sendMessage(from, { text: "❌ Kamu bukan admin!" }, { quoted: m });
                if (!isBotAdmins) return sock.sendMessage(from, { text: "❌ Jadikan bot sebagai admin terlebih dahulu!" }, { quoted: m });

                let user = quotedParticipant || mentionedJid[0] || 
                           (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
                if (!user) return sock.sendMessage(from, { text: 'Tag atau reply user yang mau di-promote.' }, { quoted: m });

                await replyWait();
                await sock.groupParticipantsUpdate(from, [user], 'promote');
                await sock.sendMessage(from, { 
                    text: `✅ Berhasil menaikkan @${user.split('@')[0]} menjadi admin grup.`, 
                    mentions: [user] 
                }, { quoted: m });
                break;
            }

            case 'demote': {
                if (!isGroup) return sock.sendMessage(from, { text: "❌ Fitur ini khusus Grup!" }, { quoted: m });
                if (!isAdmins && !isOwner) return sock.sendMessage(from, { text: "❌ Kamu bukan admin!" }, { quoted: m });
                if (!isBotAdmins) return sock.sendMessage(from, { text: "❌ Jadikan bot sebagai admin terlebih dahulu!" }, { quoted: m });

                let user = quotedParticipant || mentionedJid[0] || 
                           (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
                if (!user) return sock.sendMessage(from, { text: 'Tag atau reply user yang mau di-demote.' }, { quoted: m });

                await replyWait();
                await sock.groupParticipantsUpdate(from, [user], 'demote');
                await sock.sendMessage(from, { 
                    text: `⬇️ Berhasil menurunkan @${user.split('@')[0]} dari admin grup.`, 
                    mentions: [user] 
                }, { quoted: m });
                break;
            }

            case 'kick': {
                if (!isGroup) return sock.sendMessage(from, { text: "❌ Fitur ini khusus Grup!" }, { quoted: m });
                if (!isAdmins && !isOwner) return sock.sendMessage(from, { text: "❌ Kamu bukan admin!" }, { quoted: m });
                if (!isBotAdmins) return sock.sendMessage(from, { text: "❌ Jadikan bot sebagai admin terlebih dahulu!" }, { quoted: m });

                let user = quotedParticipant || mentionedJid[0] || 
                           (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null);
                if (!user) return sock.sendMessage(from, { text: 'Tag atau reply user yang mau dikeluarkan.' }, { quoted: m });
                if (user.split('@')[0] === sender) return sock.sendMessage(from, { text: '❌ Tidak bisa mengeluarkan diri sendiri!' }, { quoted: m });

                await replyWait();
                await sock.groupParticipantsUpdate(from, [user], 'remove');
                await sock.sendMessage(from, { 
                    text: `✅ Berhasil mengeluarkan @${user.split('@')[0]} dari grup.`, 
                    mentions: [user] 
                }, { quoted: m });
                break;
            }

            case 'iqc':
            case 'fakeiphonechat': {
                let shortcut = text || quotedText;
                if (!shortcut) return sock.sendMessage(from, { 
                    text: `*🧩 Masukkan teks!*\nContoh: ${prefix + command} info kangg` 
                }, { quoted: m });

                try {
                    await replyWait();
                    await react('⏳');
                    let iqcUrl = `https://brat.siputzx.my.id/iphone-quoted?time=12.00&batteryPercentage=90&carrierName=AXIS&messageText=${encodeURIComponent(shortcut)}&emojiStyle=apple`;
                    let bufferImg = await getBuffer(iqcUrl);
                    if (!bufferImg) return sock.sendMessage(from, { text: "❌ Gagal membuat IQC, coba lagi." }, { quoted: m });

                    await sock.sendMessage(from, { 
                        image: bufferImg, 
                        caption: '*✨ iPhone chat berhasil dibuat*' 
                    }, { quoted: m });
                    await react('✅');
                } catch (err) {
                    console.error("IQC error:", err);
                    await react('❌');
                }
                break;
            }

            case 'ig':
            case 'igdl': {
                const input = quotedText || text;
                const regex = /(https?:\/\/(?:www\.)?instagram\.com\/(p|reel)\/[a-zA-Z0-9_-]+\/?)/;
                const parseUrl = input?.match(regex)?.[0];

                if (!parseUrl) return sock.sendMessage(from, { 
                    text: `Ketik URL Instagram yang benar.\nContoh: *${prefix + command} https://www.instagram.com/reel/xxxxx*`,
                    contextInfo: getChannelPreview("Instagram Downloader", "Download foto & video IG")
                }, { quoted: m });

                try {
                    await replyWait();
                    await react('🕒');
                    const res = await igdl(parseUrl);
                    if (!res || res.error) return sock.sendMessage(from, { text: '❌ Gagal mengambil konten dari Instagram.' }, { quoted: m });

                    const result = res.info;
                    if (res.media_type === 'photo') {
                        for (let item of result) {
                            await sock.sendMessage(from, { image: { url: item.url } }, { quoted: m });
                        }
                    } else {
                        await sock.sendMessage(from, { 
                            video: { url: result[0].url }, 
                            caption: '✅ Download Instagram berhasil!' 
                        }, { quoted: m });
                    }
                    await react('✅');
                } catch (err) {
                    console.error("IG DL error:", err);
                    await react('❌');
                    await sock.sendMessage(from, { text: '❌ Gagal download dari Instagram.' }, { quoted: m });
                }
                break;
            }

            case 'tt':
            case 'tiktok': {
                const input = quotedText || text;
                if (!input) return sock.sendMessage(from, { 
                    text: `Contoh:\n${prefix + command} https://vt.tiktok.com/xxxx\natau\n${prefix + command} nama video tiktok`,
                    contextInfo: getChannelPreview("TikTok Downloader", "Download tanpa watermark")
                }, { quoted: m });
                
                try {
                    await replyWait();
                    await react('✨');
                    let url = input;
                    if (!/^https?:\/\//i.test(input)) url = await searchTikTok(input);

                    const res = await getTikTok(url);
                    const caption = `*TIKTOK DOWNLOADER* ✅\n\n*Judul:* ${res.title || '-'}\n*Views:* ${formatNumber(res.play_count || 0)}`;

                    if (Array.isArray(res.images) && res.images.length > 0) {
                        for (const img of res.images) {
                            await sock.sendMessage(from, { image: { url: img } }, { quoted: m });
                        }
                    } else if (res.play) {
                        await sock.sendMessage(from, { video: { url: res.play }, caption }, { quoted: m });
                    } else {
                        await sock.sendMessage(from, { text: '❌ Tidak ada media yang bisa didownload.' }, { quoted: m });
                    }
                    await react('✅');
                } catch (e) {
                    console.error("TikTok DL error:", e);
                    await react('❌');
                    await sock.sendMessage(from, { text: '❌ Gagal download TikTok: ' + (e.message || e) }, { quoted: m });
                }
                break;
            }

            case 'slot': {
                let user = global.db.data.users[sender];
                const betAmount = parseInt(args[0]);
                if (!args[0] || isNaN(betAmount) || betAmount <= 0) {
                    return sock.sendMessage(from, { 
                        text: `Format: *${prefix}${command} [jumlah taruhan]*\nContoh: *${prefix}slot 1000*\nSaldo kamu: Rp ${formatNumber(user.money)}`,
                        contextInfo: getChannelPreview("🎰 Slot Machine", "Uji keberuntunganmu!")
                    }, { quoted: m });
                }
                if (user.money < betAmount) return sock.sendMessage(from, { 
                    text: `❌ Uang kamu tidak cukup.\nSaldo kamu: Rp ${formatNumber(user.money)}` 
                }, { quoted: m });

                try {
                    await replyWait();
                    let symbols = ['🍊', '🍇', '🍉', '🍌', '🍍'];
                    let spins = Array.from({ length: 9 }, () => pickRandom(symbols));
                    user.money -= betAmount;

                    let isWin = spins[3] === spins[4] && spins[4] === spins[5];
                    let reward = isWin ? betAmount * 3 : 0;
                    user.money += reward;

                    let resText = `*🎰 VIRTUAL SLOTS 🎰*\n\n` +
                        `${spins.slice(0, 3).join(' | ')}\n` +
                        `${spins.slice(3, 6).join(' | ')} ◀ RESULT\n` +
                        `${spins.slice(6).join(' | ')}\n\n` +
                        `*${isWin ? '🥳 JACKPOT! Menang Rp ' + formatNumber(reward) : '🥶 KALAH! Lebih beruntung lagi ya~'}*\n` +
                        `💰 Saldo kamu: Rp ${formatNumber(user.money)}`;

                    await sock.sendMessage(from, { 
                        text: resText,
                        contextInfo: getChannelPreview("🎰 Slot Machine", isWin ? "JACKPOT! 🥳" : "Coba lagi!")
                    }, { quoted: m });
                } catch (e) {
                    console.error("Slot error:", e);
                }
                break;
            }

            case 'suitpvp': {
                if (!isGroup) return sock.sendMessage(from, { text: '❌ Hanya bisa di dalam grup!' }, { quoted: m });
                let who = mentionedJid[0] || null;
                if (!who) return sock.sendMessage(from, { text: '❌ Tag orang yang ingin ditantang!\nContoh: ' + prefix + 'suitpvp @nama' }, { quoted: m });
                if (who.split('@')[0] === sender) return sock.sendMessage(from, { text: '❌ Tidak bisa menantang diri sendiri!' }, { quoted: m });

                let id = "suit_" + Date.now();
                sock.suit[id] = {
                    id, 
                    p: rawSender, 
                    p2: who, 
                    status: "wait",
                    asal: from, 
                    pilih: null,
                    pilih2: null,
                    text: '',
                    text2: '',
                    waktu: setTimeout(() => { 
                        delete sock.suit[id];
                        sock.sendMessage(from, { 
                            text: `⏰ Waktu suit antara @${sender} dan @${who.split('@')[0]} habis!`,
                            mentions: [rawSender, who]
                        }).catch(() => {});
                    }, 60000)
                };
                await sock.sendMessage(from, { 
                    text: `🎮 @${sender} menantang @${who.split('@')[0]} main suit!\n\nKetik *terima* / *gas* untuk mulai bermain!\n_(Timeout: 60 detik)_`, 
                    mentions: [rawSender, who],
                    contextInfo: getChannelPreview("Suit PvP Game", "Gunting Batu Kertas!")
                }, { quoted: m });
                break;
            }

            case 'brat': {
                let shortcut = quotedText || text;
                if (!shortcut) return sock.sendMessage(from, { text: `Contoh: ${prefix}brat halo dunia` }, { quoted: m });
                try {
                    await replyWait();
                    await react('🕒');
                    const rawBuffer = await getBuffer(`https://aqul-brat.hf.space?text=${encodeURIComponent(shortcut)}`);
                    if (!rawBuffer) throw new Error('Buffer kosong');
                    const stickerBuffer = await convertToSticker(rawBuffer, false);
                    await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
                    await react('✅');
                } catch (e) {
                    console.error("Brat error:", e);
                    await react('❌');
                    await sock.sendMessage(from, { text: '❌ Gagal buat stiker brat.' }, { quoted: m });
                }
                break;
            }

            case 'brathd': {
                let shortcut = quotedText || text;
                if (!shortcut) return sock.sendMessage(from, { text: `Contoh: ${prefix}brathd halo dunia` }, { quoted: m });
                try {
                    await replyWait();
                    await react('🕒');
                    const rawBuffer = await getBuffer(`https://api-faa.my.id/faa/brathd?text=${encodeURIComponent(shortcut)}`);
                    if (!rawBuffer) throw new Error('Buffer kosong');
                    const stickerBuffer = await convertToSticker(rawBuffer, false);
                    await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
                    await react('✅');
                } catch (e) {
                    console.error("BratHD error:", e);
                    await react('❌');
                    await sock.sendMessage(from, { text: '❌ Gagal buat stiker brat HD.' }, { quoted: m });
                }
                break;
            }

            case 's':
            case 'sticker': {
                let isMedia = /imageMessage|videoMessage/.test(msgType);
                let isQuotedMedia = mime && /imageMessage|videoMessage/.test(mime);

                if (isMedia || isQuotedMedia) {
                    try {
                        await replyWait();
                        await react('🕒');

                        let mediaMsg, mediaTypeClean;
                        if (isQuotedMedia && quotedMessage) {
                            mediaMsg = quotedMessage[mime];
                            mediaTypeClean = mime.replace('Message', '');
                        } else {
                            mediaMsg = m.message[msgType];
                            mediaTypeClean = msgType.replace('Message', '');
                        }

                        let rawBuffer = await downloadMedia(mediaMsg, mediaTypeClean);
                        let isVideo = /video/.test(mime || msgType);
                        let stickerBuffer = await convertToSticker(rawBuffer, isVideo);
                        await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
                        await react('✅');
                    } catch (e) {
                        console.error("Sticker error:", e);
                        await react('❌');
                        await sock.sendMessage(from, { text: '❌ Gagal membuat stiker.' }, { quoted: m });
                    }
                } else {
                    sock.sendMessage(from, { 
                        text: `❌ Balas foto atau video dengan teks *${prefix}s*\nContoh: Reply foto lalu ketik *${prefix}s*` 
                    }, { quoted: m });
                }
                break;
            }

            case 'smeme': {
                // Format: .smeme teks atas | teks bawah (reply/kirim gambar)
                const isMedia = /imageMessage/.test(msgType);
                const isQuotedMedia = mime && /imageMessage/.test(mime);

                if (!isMedia && !isQuotedMedia) {
                    return sock.sendMessage(from, { 
                        text: `❌ *Cara pakai ${prefix}smeme:*\nReply atau kirim gambar dengan caption:\n*${prefix}smeme teks atas | teks bawah*\n\nContoh:\n*${prefix}smeme Ketika deadline | Tapi malah tidur*` 
                    }, { quoted: m });
                }

                const parts = text.split('|');
                const topText = parts[0]?.trim() || '';
                const bottomText = parts[1]?.trim() || '';

                if (!topText && !bottomText) {
                    return sock.sendMessage(from, { 
                        text: `❌ Masukkan teks meme!\nContoh: *${prefix}smeme Teks atas | Teks bawah*` 
                    }, { quoted: m });
                }

                try {
                    await replyWait();
                    await react('🕒');

                    let mediaMsg, mediaTypeClean;
                    if (isQuotedMedia && quotedMessage) {
                        mediaMsg = quotedMessage[mime];
                        mediaTypeClean = mime.replace('Message', '');
                    } else {
                        mediaMsg = m.message[msgType];
                        mediaTypeClean = msgType.replace('Message', '');
                    }

                    // Download gambar
                    const imgBuffer = await downloadMedia(mediaMsg, mediaTypeClean);
                    const filename = `meme_${Date.now()}.jpg`;
                    const imgUrl = await uploadTelegraph(imgBuffer, filename);

                    if (!imgUrl) return sock.sendMessage(from, { text: '❌ Gagal upload gambar.' }, { quoted: m });

                    // Buat meme via API
                    const memeUrl = `https://api.memegen.link/images/custom/${encodeURIComponent(topText || '_')}/${encodeURIComponent(bottomText || '_')}.jpg?background=${encodeURIComponent(imgUrl)}`;
                    const memeBuffer = await getBuffer(memeUrl);

                    if (!memeBuffer) return sock.sendMessage(from, { text: '❌ Gagal membuat meme.' }, { quoted: m });

                    await sock.sendMessage(from, { 
                        image: memeBuffer, 
                        caption: `🎭 *Meme berhasil dibuat!*` 
                    }, { quoted: m });
                    await react('✅');
                } catch (e) {
                    console.error("Smeme error:", e);
                    await react('❌');
                    await sock.sendMessage(from, { text: '❌ Gagal membuat meme, coba lagi.' }, { quoted: m });
                }
                break;
            }

            case 'bratvid': {
                const bratText = quotedText || text;
                if (!bratText) return sock.sendMessage(from, { text: `✨ Masukin teks dong!\nContoh: ${prefix}bratvid halo dunia` }, { quoted: m });
                try {
                    await replyWait();
                    await react('🕒');
                    const bratUrl = `https://brat.siputzx.my.id/gif?text=${encodeURIComponent(bratText)}`;
                    const rawBuffer = await getBuffer(bratUrl);
                    if (!rawBuffer) throw new Error('Buffer kosong');
                    const stickerBuffer = await convertToSticker(rawBuffer, true);
                    await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
                    await react('✅');
                } catch (e) {
                    console.error("Bratvid error:", e);
                    await react('❌');
                    await sock.sendMessage(from, { text: '❌ Gagal buat stiker bratvid.' }, { quoted: m });
                }
                break;
            }

            case 'cektt':
            case 'cekpentil': {
                if (!text) return sock.sendMessage(from, { text: `• *Contoh:* ${prefix}cektt nama` }, { quoted: m });
                const cekttResult = `╭━━━━°「 *TT nya ${text}* 」°\n┃\n┊• Nama : ${text}\n┃• TT : ${pickRandom(['Putih','Hitam','Putih mulus','Hitam banget','Karatan ☠️'])}\n┊• Pentil : ${pickRandom(['Hitam','Pink','Kecil','Perfect'])}\n┃• Ukuran : ${pickRandom(['Tepos','Spek Nasi KFC','Tobrut','32','34','36'])}\n╰═┅═━––––––๑`;
                await sock.sendMessage(from, { text: cekttResult }, { quoted: m });
                break;
            }

            case 'tebakbendera':
            case 'tb': {
                const tbId = from;
                if (sock.tebakbendera[tbId]) {
                    return sock.sendMessage(from, { text: '⚠️ Masih ada soal yang belum terjawab di chat ini!' }, { quoted: m });
                }
                try {
                    await react('🏳️');
                    const tbSrc = await (await fetch('https://raw.githubusercontent.com/BochilTeam/database/master/games/tebakbendera2.json')).json();
                    const tbJson = tbSrc[Math.floor(Math.random() * tbSrc.length)];
                    const tbTimeout = 120000;
                    const tbPoin = 500;
                    const tbCaption = `🏳️ *TEBAK BENDERA*\n\nBendera apakah ini?\n\n⏱️ Timeout: *${tbTimeout / 1000} detik*\n💡 Ketik *${prefix}tebe* untuk hint\n🎁 Bonus: *${tbPoin} XP*`;
                    const tbImgBuffer = await getBuffer(tbJson.img);
                    if (!tbImgBuffer) throw new Error('Gagal ambil gambar bendera');
                    const tbSentMsg = await sock.sendMessage(from, { image: tbImgBuffer, caption: tbCaption }, { quoted: m });
                    sock.tebakbendera[tbId] = {
                        msg: tbSentMsg,
                        data: tbJson,
                        poin: tbPoin,
                        timer: setTimeout(async () => {
                            if (sock.tebakbendera[tbId]) {
                                await sock.sendMessage(from, { text: `⏰ Waktu habis!\nJawabannya adalah *${tbJson.name}*` });
                                delete sock.tebakbendera[tbId];
                            }
                        }, tbTimeout)
                    };
                } catch (e) {
                    console.error("Tebakbendera error:", e);
                    await react('❌');
                    await sock.sendMessage(from, { text: '❌ Gagal memulai tebak bendera, coba lagi.' }, { quoted: m });
                }
                break;
            }

            case 'tebe': {
                const tebeId = from;
                if (!sock.tebakbendera[tebeId]) {
                    return sock.sendMessage(from, { text: '❌ Tidak ada game tebak bendera yang aktif.' }, { quoted: m });
                }
                const namaHint = sock.tebakbendera[tebeId].data.name.replace(/[bcdfghjklmnpqrstvwxyz]/gi, '_');
                await sock.sendMessage(from, { text: `💡 *Hint:*\n\`${namaHint}\`\n\n_Balas pesan soal bendera-nya ya!_` }, { quoted: m });
                break;
            }

            case 'addmoney': {
                if (!isOwner) return;
                let target = mentionedJid[0] ? mentionedJid[0].split('@')[0] : sender;
                let nominal = parseInt(args[0]) || 10000;
                checkUserDb(target);
                global.db.data.users[target].money += nominal;
                await sock.sendMessage(from, { 
                    text: `✅ Sukses menambahkan Rp ${formatNumber(nominal)} ke @${target}`,
                    mentions: [target + '@s.whatsapp.net']
                }, { quoted: m });
                break;
            }

            default:
                // Tidak ada respons untuk command yang tidak dikenal (opsional)
                break;
        }
    });
}

startBot();
