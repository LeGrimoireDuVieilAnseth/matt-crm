// netlify/functions/mbs-chat.js
// Assistant IA du site Mybabyshoot + relais vers Matt.
// - POST {convId?, message, history?} : ajoute le message du visiteur.
//   Mode "ia" : Claude Haiku repond (et peut prevenir Matt via l'outil
//   prevenir_matt -> notification push). Mode "matt" : pas d'IA, Matt
//   repond depuis le CRM, le site recupere ses messages via le GET.
// - GET ?conv=ID&after=N : renvoie les messages a partir de l'index N
//   (polling du widget du site).
// Conversations stockees dans le store Blobs "mbs-chat" (cle conv-ID),
// index des conversations dans la cle "convindex".
import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";
import { notifyAll } from "../push-lib.mjs";
import { normBrand, systemFor, idxKey, consKey, BRAND_LABEL } from "../chat-brands.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

const FALLBACK =
  "Je ne suis pas disponible pour le moment. Vous pouvez joindre Matt directement au 06 47 76 54 17, ou laisser un message via le formulaire de contact du site : il vous répondra très vite !";

// Garde-fou : nombre maximum de reponses IA par jour (protege le budget)
const DAILY_MAX = 400;

const TOOLS = [{
  name: "noter_identite",
  description: "Enregistre l'identite du visiteur des que tu la connais, pour que Matt sache a qui il parle. A appeler des que le visiteur donne son prenom, puis a nouveau s'il donne son nom, son telephone ou son email.",
  input_schema: {
    type: "object",
    properties: {
      prenom: { type: "string", description: "Le prenom du visiteur" },
      nom:    { type: "string", description: "Son nom de famille, s'il le donne" },
      tel:    { type: "string", description: "Son telephone, s'il le donne" },
      email:  { type: "string", description: "Son email, s'il le donne" }
    },
    required: ["prenom"]
  }
}, {
  name: "prevenir_matt",
  description: "Envoie immediatement une notification sur le telephone de Matt (le photographe). A utiliser des qu'un visiteur souhaite etre rappele, parler a Matt, proposer un appel a un moment precis, ou pose une question qui merite que Matt reprenne la conversation en personne. Une seule fois par demande.",
  input_schema: {
    type: "object",
    properties: {
      resume: { type: "string", description: "Resume tres court de la demande (1 phrase), avec le prenom et le telephone du visiteur si connus" },
      quand: { type: "string", description: "Le moment souhaite si le visiteur en propose un (ex : dans 30 minutes, ce soir)" }
    },
    required: ["resume"]
  }
}];

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

async function saveConv(store, conv) {
  const brand = normBrand(conv.brand);
  conv.updatedAt = Date.now();
  await store.setJSON("conv-" + conv.id, conv);
  // index des conversations pour le CRM
  let index = [];
  try { index = (await store.get(idxKey(brand), { type: "json" })) || []; } catch (e) {}
  index = index.filter(x => x.id !== conv.id);
  const last = conv.messages[conv.messages.length - 1];
  const v = conv.visiteur || {};
  index.unshift({
    id: conv.id,
    nom: [v.prenom, v.nom].filter(Boolean).join(" ").trim(),
    tel: v.tel || "",
    updatedAt: conv.updatedAt,
    brand,
    mode: conv.mode,
    flagged: !!conv.flagged,
    unread: conv.unread || 0,
    preview: last ? String(last.content).slice(0, 90) : ""
  });
  await store.setJSON(idxKey(brand), index.slice(0, 100));
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const store = getStore({ name: "mbs-chat", consistency: "strong" });

  // ---------- GET : polling du widget ----------
  if (request.method === "GET") {
    const url = new URL(request.url);
    const id = (url.searchParams.get("conv") || "").replace(/[^a-z0-9]/gi, "");
    const after = Math.max(0, parseInt(url.searchParams.get("after"), 10) || 0);
    if (!id) return json({ ok: false, error: "conv" }, 400);
    const conv = await store.get("conv-" + id, { type: "json" });
    if (!conv) return json({ ok: false, error: "notfound" }, 404);
    return json({
      ok: true,
      brand: normBrand(conv.brand),
      // le prenom que le visiteur a lui-meme donne (sert au widget et au controle)
      nom: [(conv.visiteur || {}).prenom, (conv.visiteur || {}).nom].filter(Boolean).join(" ").trim(),
      mode: conv.mode,
      total: conv.messages.length,
      messages: conv.messages.slice(after).map(m => ({ role: m.role, content: m.content }))
    });
  }

  if (request.method !== "POST")
    return new Response("Methode non supportee", { status: 405, headers: cors });

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: "json" }, 400); }

  // ---------- message du visiteur ----------
  let text = "";
  if (typeof body.message === "string") text = body.message;
  else if (Array.isArray(body.messages)) {
    const last = body.messages[body.messages.length - 1];
    if (last && last.role === "user" && typeof last.content === "string") text = last.content;
  }
  const brand = normBrand(body.brand);
  text = (text || "").trim().slice(0, 800);
  if (!text) return json({ ok: false, error: "message" }, 400);

  // ---------- charge ou cree la conversation ----------
  const convId = (typeof body.convId === "string" ? body.convId : "").replace(/[^a-z0-9]/gi, "");
  let conv = convId ? await store.get("conv-" + convId, { type: "json" }) : null;
  if (!conv) {
    conv = { id: uid(), brand, createdAt: Date.now(), mode: "ia", flagged: false, unread: 0, messages: [] };
    // migration douce : historique deja present cote widget
    if (Array.isArray(body.history)) {
      body.history
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-12)
        .forEach(m => conv.messages.push({ role: m.role, content: m.content.slice(0, 800), t: Date.now() }));
    }
  }
  if (!conv.brand) conv.brand = brand;
  conv.messages.push({ role: "user", content: text, t: Date.now() });
  conv.unread = (conv.unread || 0) + 1;
  if (conv.messages.length > 80) conv.messages = conv.messages.slice(-80);

  // ---------- mode manuel : Matt a repris la main ----------
  if (conv.mode === "matt") {
    await saveConv(store, conv);
    try { await notifyAll("Chat " + BRAND_LABEL[conv.brand], "Nouveau message : " + text.slice(0, 90), "/"); } catch (e) {}
    return json({ ok: true, convId: conv.id, manual: true, total: conv.messages.length });
  }

  // ---------- corrections ecrites par Matt dans le CRM ----------
  let extra = "";
  try { extra = (await store.get(consKey(conv.brand))) || ""; } catch (e) {}
  const systemPrompt = extra.trim()
    ? systemFor(conv.brand) + "\n\nCONSIGNES DE MATT (PRIORITAIRES)\nCe qui suit a ete ecrit par Matt lui-meme. En cas de contradiction avec ce qui precede, ces consignes l'emportent TOUJOURS.\n" + extra.trim().slice(0, 6000)
    : systemFor(conv.brand);

  // ---------- mode IA ----------
  if (!process.env.ANTHROPIC_API_KEY) {
    await saveConv(store, conv);
    return json({ ok: true, convId: conv.id, reply: FALLBACK, off: true, total: conv.messages.length });
  }

  // plafond quotidien
  const today = new Date().toISOString().slice(0, 10);
  const quotaKey = "quota-" + today;
  let count = 0;
  try { count = parseInt(await store.get(quotaKey), 10) || 0; } catch (e) {}
  if (count >= DAILY_MAX) {
    await saveConv(store, conv);
    return json({ ok: true, convId: conv.id, reply: FALLBACK, off: true, total: conv.messages.length });
  }
  try { await store.set(quotaKey, String(count + 1)); } catch (e) {}

  // historique pour le modele (matt -> assistant, prefixe pour le contexte)
  const apiMessages = conv.messages.slice(-16).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.role === "matt" ? "Matt (le photographe) a repondu : " + m.content : m.content
  }));

  try {
    const client = new Anthropic();
    let response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 600,
      system: systemPrompt,
      tools: TOOLS,
      messages: apiMessages
    });

    // Boucle d'outils : noter_identite (qui parle) et prevenir_matt (notification).
    const fil = [...apiMessages];
    let tours = 0;
    while (response.stop_reason === "tool_use" && tours < 3) {
      tours++;
      const appels = response.content.filter(b => b.type === "tool_use");
      if (!appels.length) break;
      const resultats = [];

      for (const t of appels) {
        const inp = t.input || {};
        if (t.name === "noter_identite") {
          const v = conv.visiteur || {};
          const prendre = (k, max) => {
            const val = String(inp[k] || "").trim().slice(0, max);
            if (val) v[k] = val;
          };
          prendre("prenom", 40); prendre("nom", 40); prendre("tel", 25); prendre("email", 80);
          conv.visiteur = v;
          resultats.push({ type: "tool_result", tool_use_id: t.id, content: "Identite enregistree, merci." });
        } else if (t.name === "prevenir_matt") {
          const resume = String(inp.resume || "Demande de contact").slice(0, 120);
          const quand  = String(inp.quand || "").slice(0, 60);
          conv.flagged = true;
          const qui = conv.visiteur && conv.visiteur.prenom ? conv.visiteur.prenom + " : " : "";
          try {
            await notifyAll(
              BRAND_LABEL[conv.brand] + " : un visiteur veut te parler",
              qui + resume + (quand ? " (" + quand + ")" : ""),
              "/"
            );
          } catch (e) {}
          resultats.push({ type: "tool_result", tool_use_id: t.id, content: "Matt a bien reçu la notification sur son téléphone. Il peut répondre directement dans cette conversation." });
        } else {
          resultats.push({ type: "tool_result", tool_use_id: t.id, content: "ok" });
        }
      }

      fil.push({ role: "assistant", content: response.content });
      fil.push({ role: "user", content: resultats });
      response = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        system: systemPrompt,
        tools: TOOLS,
        messages: fil
      });
    }

    const reply = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim() || FALLBACK;

    conv.messages.push({ role: "assistant", content: reply, t: Date.now() });
    await saveConv(store, conv);
    return json({ ok: true, convId: conv.id, reply, total: conv.messages.length });
  } catch (e) {
    await saveConv(store, conv);
    return json({ ok: true, convId: conv.id, reply: FALLBACK, off: true, total: conv.messages.length });
  }
};

export const config = { path: "/.netlify/functions/mbs-chat" };
