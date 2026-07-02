// netlify/push-lib.mjs - envoi des notifications push a tous les appareils abonnes
import webpush from "web-push";
import { getStore } from "@netlify/blobs";

export async function notifyAll(title, body, url="/"){
  const pub = process.env.VAPID_PUBLIC, priv = process.env.VAPID_PRIVATE;
  if(!pub || !priv) return; // notifications non configurees
  try{
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:contact@maison-lumiere.fr", pub, priv);
  }catch(e){ return; }
  const store = getStore({ name: "studio-crm-push" });
  let listed;
  try{ listed = await store.list(); }catch(e){ return; }
  const blobs = (listed && listed.blobs) || [];
  const payload = JSON.stringify({ title, body, url });
  await Promise.all(blobs.map(async b => {
    try{
      const sub = await store.get(b.key, { type: "json" });
      if(sub) await webpush.sendNotification(sub, payload);
    }catch(e){
      const code = e && e.statusCode;
      if(code === 404 || code === 410){ try{ await store.delete(b.key); }catch(_){} }
    }
  }));
}
