const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");

const milevoxApi = require("./milevox");

const GUILD_ID = process.env.GUILD_ID_KASSBOHRER || null;
const PORT = process.env.TEAM_API_PORT_KASSBOHRER || 26081;

const DISCORD_EVENT_CHANNEL_ID = "1540511389842669648";

const ROLE_IDS = {
  patron: "1529977373204680754",
  chauffeurs: "1529977373188165834",
  chauffeurs_essai: "1541164557412601867",
};

const DATA_PATH = path.join(__dirname, "data.json");
const ANNOUNCED_EVENTS_PATH = path.join(__dirname, "annonced_events.json");

const CACHE_MS = 60 * 1000;
let membersCache = null;
let membersCacheTime = 0;
let membersFetchPromise = null;
let cache = null;
let cacheTime = 0;
let started = false;
let clientRef = null;

let announcedEvents = new Set();
let premierPassage = false;

function chargerAnnonces() {
  try {
    if (fs.existsSync(ANNOUNCED_EVENTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(ANNOUNCED_EVENTS_PATH, "utf8"));
      announcedEvents = new Set(data);
    } else {
      premierPassage = true;
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

function listeEvenements(reponse) {
  if (Array.isArray(reponse)) return reponse;
  if (reponse && Array.isArray(reponse.events)) return reponse.events;
  return [];
}

function idEvenement(ev) {
  return ev.id || `${ev.date}-${ev.titre}`;
}

async function verifierNouveauxEvenementsMilevox() {
  if (!clientRef || !GUILD_ID) return;
  try {
    const events = listeEvenements(await milevoxApi.getEvents());

    // Premier lancement : on marque tout comme déjà annoncé, sans poster
    if (premierPassage) {
      premierPassage = false;
      for (const ev of events) announcedEvents.add(idEvenement(ev));
      sauvegarderAnnonces();
      console.log(`[team-api-kassbohrer] Premier passage silencieux : ${events.length} événement(s) marqué(s).`);
      return;
    }

    const channel = clientRef.channels.cache.get(DISCORD_EVENT_CHANNEL_ID);
    if (!channel) return;

    for (const ev of events) {
      const id = idEvenement(ev);
      if (announcedEvents.has(id)) continue;
      const date = new Date(ev.date).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
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

// ─── LECTURE DE data.json ───
function lireGuildData() {
  if (!GUILD_ID || !fs.existsSync(DATA_PATH)) return {};
  try {
    const brut = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    return (brut.guilds && brut.guilds[GUILD_ID]) || {};
  } catch (err) {
    console.error("[team-api-kassbohrer] Erreur lecture data.json :", err.message);
    return {};
  }
}

const getConvoisData = () => lireGuildData().convois || [];
const getMeetingsData = () => lireGuildData().meetings || [];
const getPollsData = () => lireGuildData().polls || [];
const getEmbedsData = () => lireGuildData().embeds || [];

async function getEventsData() {
  const evenementsLocaux = lireGuildData().evenements || [];
  const localEvents = evenementsLocaux.map((ev) => ({
    id: ev.id, date: ev.date, titre: ev.titre, lieu: ev.lieu,
    categorie: ev.categorie, lien: ev.lien || null, image: ev.image || null
  }));

  let milevoxEvents = [];
  try {
    const milevoxData = listeEvenements(await milevoxApi.getEvents());
    milevoxEvents = milevoxData.map((ev) => ({
      id: idEvenement(ev),
      date: ev.date, titre: ev.titre, lieu: ev.lieu,
      categorie: ev.categorie, lien: ev.lien || null, image: ev.image || null
    }));
  } catch (err) { console.error("[team-api-kassbohrer] Erreur Milevox events :", err.message); }
  return [...localEvents, ...milevoxEvents];
}

let statsLogged = false;

async function getStatsData() {
  try {
    const info = await milevoxApi.getVtcInfo();
    if (!statsLogged) {
      statsLogged = true;
      console.log("[team-api-kassbohrer] Réponse Milevox brute :", JSON.stringify(info).slice(0, 1500));
    }

    const vtc = info.vtc || info.data || info || {};
    const pick = (...cles) => {
      for (const c of cles) {
        const v = vtc[c] ?? (vtc.stats && vtc.stats[c]);
        if (v !== undefined && v !== null && !isNaN(Number(v))) return Number(v);
      }
      return 0;
    };

    let evenements = pick("events_count", "events", "total_events");
    if (!evenements) {
      try {
        evenements = listeEvenements(await milevoxApi.getEvents()).length;
      } catch (e) {}
    }

    return {
      chauffeurs: pick("member_count", "members_count", "members", "total_members", "drivers"),
      trajets: pick("total_deliveries", "deliveries_count", "deliveries", "jobs"),
      km: pick("total_km", "total_distance", "distance", "km"),
      evenements
    };
  } catch (err) {
    console.error("[team-api-kassbohrer] Erreur /api/stats :", err.message);
    return { chauffeurs: 0, trajets: 0, km: 0, evenements: 0 };
  }
}

async function getMemberStats(discordId) {
  try {
    const guildData = lireGuildData();
    if (!guildData.milevoxMapping || !guildData.milevoxMapping[discordId]) return null;
    const pseudo = guildData.milevoxMapping[discordId];
    const { members } = await milevoxApi.getMembers();
    if (!members || !Array.isArray(members)) return null;
    return members.find((m) => m.username.toLowerCase() === pseudo.toLowerCase()) || null;
  } catch (err) {
    console.error("[team-api-kassbohrer] Erreur getMemberStats :", err.message);
    return null;
  }
}

// ───────────────────────────────────────────────
// SERVEUR EXPRESS
// ───────────────────────────────────────────────
function startTeamApiKassbohrer(client, options = {}) {
  if (started) return;
  started = true;
  clientRef = client;
  chargerAnnonces();

  const port = options.port || PORT;
  const app = express();
  app.use(cors({ origin: true, methods: ["GET", "OPTIONS"] }));

  const route = (chemin, fn) => {
    app.get(chemin, async (req, res) => {
      try { res.json(await fn(req)); }
      catch (err) { console.error(`[team-api-kassbohrer] erreur ${chemin}:`, err); res.status(500).json({ error: "internal_error" }); }
    });
  };

  route("/api/team", () => getTeamData(client));
  route("/api/events", () => getEventsData());
  route("/api/stats", () => getStatsData());
  route("/api/convois", () => getConvoisData());
  route("/api/meetings", () => getMeetingsData());
  route("/api/polls", () => getPollsData());
  route("/api/embeds", () => getEmbedsData());

  app.get("/api/member/:discordId", async (req, res) => {
    try {
      const memberStats = await getMemberStats(req.params.discordId);
      if (!memberStats) {
        return res.status(404).json({ error: "Aucun lien Milevox pour cet utilisateur ou membre introuvable" });
      }
      res.json(memberStats);
    } catch (err) {
      console.error("[team-api-kassbohrer] erreur /api/member:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  app.listen(port, "0.0.0.0", () => {
    console.log(`[team-api-kassbohrer] écoute sur le port ${port}`);
  });

  setInterval(() => verifierNouveauxEvenementsMilevox(), 5 * 60 * 1000);
  verifierNouveauxEvenementsMilevox();
}

module.exports = { startTeamApiKassbohrer };
