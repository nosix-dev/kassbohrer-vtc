const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn, execFileSync, execFile } = require("child_process");
const express = require("express");
const cors = require("cors");

const milevoxApi = require("./milevox");

const GUILD_ID = process.env.GUILD_ID_KASSBOHRER || null;
const PORT = process.env.TEAM_API_PORT_KASSBOHRER || 26081;
const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN || null;
const NGROK_DOMAIN = process.env.NGROK_DOMAIN_KASSBOHRER || null;
const NGROK_API_KEY = process.env.NGROK_API_KEY || null;

const DISCORD_EVENT_CHANNEL_ID = "1540511389842669648";

const ROLE_IDS = {
  patron: "1529977373204680754",
  chauffeurs: "1529977373188165834",
  chauffeurs_essai: "1541164557412601867",
};

const DATA_PATH = path.join(__dirname, "data.json");
const ANNOUNCED_EVENTS_PATH = path.join(__dirname, "annonced_events.json");
const NGROK_DIR = path.join(__dirname, "ngrok-bin");
const NGROK_BIN = path.join(NGROK_DIR, "ngrok");
const NGROK_TARBALL = path.join(NGROK_DIR, "ngrok.tgz");
const NGROK_URL = "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz";

const CACHE_MS = 60 * 1000;
let membersCache = null;
let membersCacheTime = 0;
let membersFetchPromise = null;
let cache = null;
let cacheTime = 0;
let started = false;
let clientRef = null;

let announcedEvents = new Set();

function chargerAnnonces() {
  try {
    if (fs.existsSync(ANNOUNCED_EVENTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(ANNOUNCED_EVENTS_PATH, "utf8"));
      announcedEvents = new Set(data);
    }
  } catch (err) {
    console.error("[team-api-kassbohrer] Erreur chargement annonces :", err.message);
  }
}

function sauvegarderAnnonces() {
  try {
    fs.writeFileSync(ANNOUNCED_EVENTS_PATH, JSON.stringify([...announcedEvents], null, 2));
  } catch (err) {
    console.error("[team-api-kassbohrer] Erreur sauvegarde annonces :", err.message);
  }
}

async function verifierNouveauxEvenementsMilevox() {
  if (!clientRef || !GUILD_ID) return;
  try {
    const events = await milevoxApi.getEvents();
    if (!Array.isArray(events)) return;
    const channel = clientRef.channels.cache.get(DISCORD_EVENT_CHANNEL_ID);
    if (!channel) return;

    for (const ev of events) {
      const id = ev.id || `${ev.date}-${ev.titre}`;
      if (announcedEvents.has(id)) continue;
      const date = new Date(ev.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
      const titre = ev.titre || "Événement sans titre";
      const lieu = ev.lieu ? `📍 Lieu : ${ev.lieu}` : "";
      const lien = ev.lien ? `\n🔗 Plus d'infos : ${ev.lien}` : "";

      const message = `📢 **Nouvel événement sur Milevox !**\n\n📅 **${date}**\n🏷️ **${titre}**\n${lieu ? lieu + "\n" : ""}${lien}`;

      try {
        await channel.send(message);
        announcedEvents.add(id);
      } catch (err) {
        console.error("[team-api-kassbohrer] Erreur envoi Discord :", err.message);
      }
    }
    sauvegarderAnnonces();
  } catch (err) {
    console.warn("[team-api-kassbohrer] Erreur polling Milevox :", err.message);
  }
}

function calculerAnciennete(joinedAt) {
  if (!joinedAt) return null;
  const maintenant = new Date();
  const debut = new Date(joinedAt);
  let mois = (maintenant.getFullYear() - debut.getFullYear()) * 12 + (maintenant.getMonth() - debut.getMonth());
  if (maintenant.getDate() < debut.getDate()) mois -= 1;
  if (mois < 0) mois = 0;
  if (mois < 1) return "< 1 mois";
  if (mois < 12) return `${mois} mois`;
  const ans = Math.floor(mois / 12);
  const moisRestants = mois % 12;
  if (moisRestants === 0) return `${ans} an${ans > 1 ? "s" : ""}`;
  return `${ans} an${ans > 1 ? "s" : ""} ${moisRestants} mois`;
}

async function getGuildMembers(guild) {
  const now = Date.now();
  if (membersCache && now - membersCacheTime < 5 * 60 * 1000) return membersCache;
  if (!membersFetchPromise) {
    membersFetchPromise = guild.members.fetch()
      .then((members) => {
        membersCache = members;
        membersCacheTime = Date.now();
        return members;
      })
      .catch(err => { throw err; })
      .finally(() => { membersFetchPromise = null; });
  }
  return membersFetchPromise;
}

async function buildTeamData(client) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) throw new Error("Guild introuvable");
  const members = await getGuildMembers(guild);
  const result = {};
  for (const [key, roleId] of Object.entries(ROLE_IDS)) {
    const role = guild.roles.cache.get(roleId);
    if (!role) { result[key] = []; continue; }
    result[key] = members.filter((m) => m.roles.cache.has(role.id)).map((m) => ({
      id: m.id,
      pseudo: m.displayName || m.user.username,
      avatar: m.displayAvatarURL({ extension: "png", size: 128 }),
      joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
      anciennete: calculerAnciennete(m.joinedAt),
    }));
  }
  return result;
}

async function getTeamData(client) {
  if (cache && Date.now() - cacheTime < CACHE_MS) return cache;
  cache = await buildTeamData(client);
  cacheTime = Date.now();
  return cache;
}

async function getEventsData() {
  const localEvents = [];
  if (GUILD_ID && fs.existsSync(DATA_PATH)) {
    let brut;
    try { brut = JSON.parse(fs.readFileSync(DATA_PATH, "utf8")); }
    catch (err) { brut = {}; }
    const guildData = brut.guilds && brut.guilds[GUILD_ID];
    const evenementsLocaux = (guildData && guildData.evenements) || [];
    localEvents.push(...evenementsLocaux.map((ev) => ({
      id: ev.id, date: ev.date, titre: ev.titre, lieu: ev.lieu,
      categorie: ev.categorie, lien: ev.lien || null, image: ev.image || null
    })));
  }

  let milevoxEvents = [];
  try {
    const milevoxData = await milevoxApi.getEvents().catch(err => []);
    if (Array.isArray(milevoxData)) {
      milevoxEvents = milevoxData.map(ev => ({
        id: ev.id || `mvx-${Date.now()}-${Math.random()}`,
        date: ev.date, titre: ev.titre, lieu: ev.lieu,
        categorie: ev.categorie, lien: ev.lien || null, image: ev.image || null
      }));
    }
  } catch (err) { console.error("[team-api-kassbohrer] Erreur Milevox events :", err.message); }
  return [...localEvents, ...milevoxEvents];
}

async function getStatsData() {
    try {
        const milevoxInfo = await milevoxApi.getVtcInfo();
        const vtc = milevoxInfo.vtc || milevoxInfo || {};
        return {
            chauffeurs: vtc.member_count || vtc.members || 0,
            trajets: vtc.deliveries || vtc.total_deliveries || 0,
            km: vtc.km || vtc.total_km || 0,
            evenements: vtc.events_count || vtc.events || 0
        };
    } catch (err) {
        console.error("[team-api-kassbohrer] Erreur /api/stats :", err.message);
        return { chauffeurs: 0, trajets: 0, km: 0, evenements: 0 };
    }
}

// NOUVELLE FONCTION : récupérer les stats d'un membre Milevox à partir de son Discord ID
async function getMemberStats(discordId) {
    try {
        // Lire data.json pour obtenir le mapping
        const dataBrut = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
        const guildData = dataBrut.guilds?.[GUILD_ID];
        if (!guildData || !guildData.milevoxMapping || !guildData.milevoxMapping[discordId]) {
            return null; // pas de lien
        }
        const pseudo = guildData.milevoxMapping[discordId];
        // Récupérer tous les membres Milevox
        const { members } = await milevoxApi.getMembers();
        if (!members || !Array.isArray(members)) return null;
        const member = members.find(m => m.username.toLowerCase() === pseudo.toLowerCase());
        return member || null;
    } catch (err) {
        console.error("[team-api-kassbohrer] Erreur getMemberStats :", err.message);
        return null;
    }
}

// ───────────────────────────────────────────────
// NGROK (inchangé)
// ───────────────────────────────────────────────
function telechargerFichier(url, destPath, redirectsRestants = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "team-api-script" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (redirectsRestants <= 0) return reject(new Error("Trop de redirections"));
        res.resume();
        return resolve(telechargerFichier(res.headers.location, destPath, redirectsRestants - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Téléchargement échoué, HTTP ${res.statusCode}`));
      }
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on("finish", () => fileStream.close(() => resolve()));
      fileStream.on("error", reject);
    }).on("error", reject);
  });
}

async function assurerBinaireNgrok() {
  if (fs.existsSync(NGROK_BIN)) return;
  if (!fs.existsSync(NGROK_DIR)) fs.mkdirSync(NGROK_DIR, { recursive: true });
  await telechargerFichier(NGROK_URL, NGROK_TARBALL);
  execFileSync("tar", ["xzf", NGROK_TARBALL, "-C", NGROK_DIR]);
  fs.chmodSync(NGROK_BIN, 0o755);
  fs.unlinkSync(NGROK_TARBALL);
}

function tuerNgrokExistant(domaine) {
  return new Promise((resolve) => {
    execFile("pkill", ["-f", `ngrok.*${domaine}`], () => resolve());
  });
}

function couperSessionCloudNgrok(domaine) {
  return new Promise((resolve) => {
    if (!NGROK_API_KEY) return resolve(false);
    const optionsListe = { hostname: "api.ngrok.com", path: "/endpoints", method: "GET", headers: { Authorization: `Bearer ${NGROK_API_KEY}`, "Ngrok-Version": "2" } };
    const reqListe = https.request(optionsListe, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", async () => {
        let endpoints;
        try { endpoints = JSON.parse(body).endpoints || []; } catch { return resolve(false); }
        const cible = endpoints.find((e) => (e.hostport || e.url || "").includes(domaine));
        if (!cible || !cible.tunnel_session_id) return resolve(false);
        const optionsDelete = { hostname: "api.ngrok.com", path: `/tunnel_sessions/${cible.tunnel_session_id}/stop`, method: "POST", headers: { Authorization: `Bearer ${NGROK_API_KEY}`, "Ngrok-Version": "2" } };
        const reqDelete = https.request(optionsDelete, (resDelete) => {
          resDelete.on("data", () => {});
          resDelete.on("end", () => { console.log(`[team-api-kassbohrer] session distante coupée`); resolve(true); });
        });
        reqDelete.on("error", (err) => { console.error("[team-api-kassbohrer] erreur coupure distante :", err.message); resolve(false); });
        reqDelete.end();
      });
    });
    reqListe.on("error", (err) => { console.error("[team-api-kassbohrer] erreur listing ngrok :", err.message); resolve(false); });
    reqListe.end();
  });
}

let ngrokChild = null;

async function ouvrirTunnelNgrok(port) {
  if (!NGROK_AUTHTOKEN || !NGROK_DOMAIN) return console.error("[team-api-kassbohrer] NGROK config manquante.");
  try { await assurerBinaireNgrok(); } catch (err) { return console.error("[team-api-kassbohrer] Erreur binaire ngrok:", err.message); }
  await tuerNgrokExistant(NGROK_DOMAIN);
  const coupureCloud = await couperSessionCloudNgrok(NGROK_DOMAIN);
  await new Promise((r) => setTimeout(r, coupureCloud ? 2000 : 1000));

  const child = spawn(NGROK_BIN, ["http", `--url=${NGROK_DOMAIN}`, String(port)], { env: { ...process.env, NGROK_AUTHTOKEN } });
  ngrokChild = child;
  let annonce = false;
  const gererLigne = (buf) => {
    const text = buf.toString();
    console.log("[ngrok-kassbohrer]", text.trim());
    if (!annonce && /started tunnel|client session established/i.test(text)) {
      annonce = true;
      console.log(`[team-api-kassbohrer] Tunnel actif : https://${NGROK_DOMAIN}/api/stats`);
    }
  };
  child.stdout.on("data", gererLigne);
  child.stderr.on("data", gererLigne);
  let sortieRecente = "";
  child.stdout.on("data", (b) => (sortieRecente += b.toString()));
  child.stderr.on("data", (b) => (sortieRecente += b.toString()));
  child.on("exit", (code) => {
    ngrokChild = null;
    if (code !== 0) {
      console.error(`[team-api-kassbohrer] ngrok arrêté (code ${code}). Relance dans 5s...`);
      setTimeout(() => ouvrirTunnelNgrok(port), 5000);
    }
  });
  child.on("error", (err) => console.error("[team-api-kassbohrer] impossible lancer ngrok:", err.message));
}

function arreterNgrokProprement() {
  if (ngrokChild) { ngrokChild.kill("SIGTERM"); ngrokChild = null; }
}
let signalHandlersInstalles = false;
function installerSignalHandlers() {
  if (signalHandlersInstalles) return;
  signalHandlersInstalles = true;
  process.on("SIGINT", () => { arreterNgrokProprement(); process.exit(0); });
  process.on("SIGTERM", () => { arreterNgrokProprement(); process.exit(0); });
}

// ───────────────────────────────────────────────
// SERVEUR EXPRESS
// ───────────────────────────────────────────────
function startTeamApiKassbohrer(client, options = {}) {
  if (started) return;
  started = true;
  installerSignalHandlers();
  clientRef = client;
  chargerAnnonces();

  const port = options.port || PORT;
  const app = express();
  app.use(cors({ origin: true, methods: ["GET", "OPTIONS"] }));
  app.use((req, res, next) => { res.setHeader("ngrok-skip-browser-warning", "true"); next(); });

  app.get("/api/team", async (req, res) => {
    try { res.json(await getTeamData(client)); }
    catch (err) { console.error("[team-api-kassbohrer] erreur /api/team:", err); res.status(500).json({ error: "internal_error" }); }
  });

  app.get("/api/events", async (req, res) => {
    try { res.json(await getEventsData()); }
    catch (err) { console.error("[team-api-kassbohrer] erreur /api/events:", err); res.status(500).json({ error: "internal_error" }); }
  });

  app.get("/api/stats", async (req, res) => {
    try { res.json(await getStatsData()); }
    catch (err) { console.error("[team-api-kassbohrer] erreur /api/stats:", err); res.status(500).json({ error: "internal_error" }); }
  });

  // NOUVELLE ROUTE : /api/member/:discordId
  app.get("/api/member/:discordId", async (req, res) => {
    try {
      const discordId = req.params.discordId;
      const memberStats = await getMemberStats(discordId);
      if (!memberStats) {
        return res.status(404).json({ error: "Aucun lien Milevox pour cet utilisateur ou membre introuvable" });
      }
      res.json(memberStats);
    } catch (err) {
      console.error("[team-api-kassbohrer] erreur /api/member:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  app.listen(port, "0.0.0.0", async () => {
    console.log(`[team-api-kassbohrer] écoute sur le port ${port}`);
    await ouvrirTunnelNgrok(port);
  });

  setInterval(() => verifierNouveauxEvenementsMilevox(), 5 * 60 * 1000);
  verifierNouveauxEvenementsMilevox();
}

module.exports = { startTeamApiKassbohrer };