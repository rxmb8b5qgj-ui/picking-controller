// Contrôleur téléphone de l'IHM picking (Chrome Android + Web Bluetooth).
//
// Rôle : envoyer la commande à l'IHM (ORDER_INIT), désigner la référence prélevée en la
// touchant (SELECT_REF, remplace le scan), afficher les validations faites à l'IHM
// (REF_VALIDATED). L'IHM fait foi sur la progression : à chaque (re)connexion, son message
// STATE resynchronise la liste.
import {
  FrameAssembler, MessageEncoder, PROTOCOL_VERSION, RX_UUID, SERVICE_UUID, TX_UUID,
} from "./protocol.js";
import { SAMPLE_ORDERS, generateRandomOrder } from "./orders.js";

const STORAGE_KEY = "picking-controller/order";
const SELECT_TIMEOUT_MS = 4000;
const ORDER_TIMEOUT_MS = 8000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const expectedName = sanitizeName(params.get("device"));

const state = {
  link: "idle", // idle | connecting | connected | reconnecting
  device: null,
  rx: null,
  tx: null,
  useWriteWithoutResponse: true,
  manualDisconnect: false,
  reconnectAttempt: 0,
  order: loadOrder(),
  sync: "local", // local | sending | synced | error
  syncDetail: "",
  hmiOrder: null,
  validated: new Set(),
  active: null,
  pending: new Map(), // référence -> minuterie de SELECT_REF sans réponse
};

const encoder = new MessageEncoder();
const assembler = new FrameAssembler();
let writeChain = Promise.resolve();
let orderTimer = null;
let reconnectTimer = null;

// ------------------------------------------------------------------- démarrage
function init() {
  $("device-name").textContent = expectedName || "Toute IHM picking";
  $("device-name-inline").textContent = expectedName || "l'IHM affichée à l'écran (PICK-…)";
  $("connect-btn").addEventListener("click", connect); // geste utilisateur exigé par Chrome
  $("disconnect-btn").addEventListener("click", disconnect);
  $("change-order-btn").addEventListener("click", openOrderSheet);
  $("random-btn").addEventListener("click", () => chooseOrder(generateRandomOrder()));
  $("resend-btn").addEventListener("click", () => sendOrder());
  $("toast").addEventListener("click", () => ($("toast").hidden = true));
  renderSamples();
  checkEnvironment();
  render();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => log(`hors ligne indisponible : ${e.message}`));
  }
}

function checkEnvironment() {
  let problem = "";
  if (!window.isSecureContext) {
    problem = "Page non sécurisée : Web Bluetooth exige une adresse https:// (voir README).";
  } else if (!navigator.bluetooth) {
    problem = "Web Bluetooth indisponible : ouvrez cette page dans Google Chrome sur Android.";
  }
  if (problem) {
    showBanner(problem);
    $("connect-btn").disabled = true;
    return;
  }
  navigator.bluetooth.getAvailability?.().then((ok) => {
    if (!ok) showBanner("Bluetooth désactivé ou absent : activez-le dans les réglages rapides.");
  });
}

// ------------------------------------------------------------------- connexion
async function connect() {
  if (state.link === "connecting") return;
  hideBanner();
  const filters = [{ services: [SERVICE_UUID] }];
  if (expectedName) filters.unshift({ name: expectedName });
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({ filters, optionalServices: [SERVICE_UUID] });
  } catch (error) {
    if (error.name === "NotFoundError") toast("Aucun appareil choisi.", "warn");
    else toast(`Bluetooth : ${error.message}`, "error");
    return;
  }
  if (state.device && state.device !== device) forgetDevice();
  state.device = device;
  state.manualDisconnect = false;
  device.addEventListener("gattserverdisconnected", onDisconnected);
  if (expectedName && device.name && device.name !== expectedName) {
    $("name-warning").textContent =
      `Attention : connecté à ${device.name}, le QR code indiquait ${expectedName}.`;
    $("name-warning").hidden = false;
  } else {
    $("name-warning").hidden = true;
  }
  await openLink();
}

async function openLink() {
  setLink(state.reconnectAttempt ? "reconnecting" : "connecting");
  try {
    const server = await state.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    state.rx = await service.getCharacteristic(RX_UUID);
    const tx = await service.getCharacteristic(TX_UUID);
    if (tx !== state.tx) {
      tx.addEventListener("characteristicvaluechanged", onNotification);
      state.tx = tx;
    }
    state.useWriteWithoutResponse = Boolean(state.rx.properties.writeWithoutResponse);
    assembler.reset();
    writeChain = Promise.resolve();
    await tx.startNotifications(); // avant HELLO : la réponse STATE ne doit pas être perdue
    state.reconnectAttempt = 0;
    setLink("connected");
    log(`connecté à ${state.device.name || "l'IHM"}`);
    await send({ type: "HELLO", v: PROTOCOL_VERSION, client: "chrome-controller" });
    if (state.order) await sendOrder(); // la commande part dès la connexion
  } catch (error) {
    log(`connexion échouée : ${error.message}`);
    if (state.link === "connecting") {
      // Tout premier essai : pas de boucle de reconnexion (mauvais appareil, IHM éteinte…).
      state.manualDisconnect = true;
      if (state.device?.gatt.connected) state.device.gatt.disconnect();
      setLink("idle");
      toast(`Connexion impossible : ${error.message}`, "error");
      return;
    }
    if (state.device?.gatt.connected) state.device.gatt.disconnect(); // -> onDisconnected -> nouvel essai
    else scheduleReconnect();
  }
}

function onDisconnected() {
  clearPending();
  clearTimeout(orderTimer);
  if (state.sync === "sending") setSync("local");
  if (state.manualDisconnect) {
    setLink("idle");
    log("déconnecté");
    return;
  }
  log("liaison perdue");
  scheduleReconnect();
}

function scheduleReconnect() {
  if (state.manualDisconnect || !state.device) {
    setLink("idle");
    return;
  }
  const delay = RECONNECT_DELAYS_MS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  state.reconnectAttempt += 1;
  setLink("reconnecting");
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!state.manualDisconnect && state.device) openLink();
  }, delay);
}

async function disconnect() {
  state.manualDisconnect = true;
  clearTimeout(reconnectTimer);
  if (state.device?.gatt.connected) {
    try {
      await send({ type: "BYE" }); // l'IHM sait tout de suite que c'est volontaire
    } catch { /* la déconnexion suit de toute façon */ }
    state.device.gatt.disconnect();
  } else {
    setLink("idle");
  }
}

function forgetDevice() {
  state.device?.removeEventListener("gattserverdisconnected", onDisconnected);
  if (state.device?.gatt.connected) state.device.gatt.disconnect();
  state.tx = null;
}

// ----------------------------------------------------------------- émission
function send(message) {
  if (state.link !== "connected" || !state.rx) return Promise.reject(new Error("téléphone non connecté"));
  const frames = encoder.encode(message);
  const job = writeChain.then(async () => {
    for (const frame of frames) await writeFrame(frame);
  });
  writeChain = job.catch(() => {});
  log(`→ ${describe(message)} (${frames.length} trame${frames.length > 1 ? "s" : ""})`);
  return job;
}

async function writeFrame(frame) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (state.useWriteWithoutResponse) await state.rx.writeValueWithoutResponse(frame);
      else await state.rx.writeValueWithResponse(frame);
      return;
    } catch (error) {
      // Pile Bluetooth occupée : on réessaie la même trame (l'IHM ignore un doublon).
      if (attempt >= 3 || !state.device?.gatt.connected) throw error;
      await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)));
    }
  }
}

async function sendOrder() {
  if (!state.order || state.link !== "connected") return;
  setSync("sending");
  clearTimeout(orderTimer);
  orderTimer = setTimeout(() => setSync("error", "pas d'accusé de réception de l'IHM"), ORDER_TIMEOUT_MS);
  try {
    await send({ type: "ORDER_INIT", ...state.order });
  } catch (error) {
    clearTimeout(orderTimer);
    setSync("error", error.message);
  }
}

async function selectReference(reference) {
  if (state.link !== "connected") return toast("Connectez d'abord le téléphone à l'IHM.", "warn");
  if (state.sync !== "synced") return toast("La commande n'est pas encore reçue par l'IHM.", "warn");
  if (state.validated.has(reference)) return toast(`${reference} est déjà validée.`, "warn");
  if (state.pending.has(reference)) return;
  state.pending.set(reference, setTimeout(() => {
    state.pending.delete(reference);
    render();
    toast(`Pas de réponse de l'IHM pour ${reference}. Réessayez.`, "error");
  }, SELECT_TIMEOUT_MS));
  render();
  navigator.vibrate?.(30);
  try {
    await send({ type: "SELECT_REF", order_number: state.order.order_number, reference_number: reference });
  } catch (error) {
    clearTimeout(state.pending.get(reference));
    state.pending.delete(reference);
    render();
    toast(`Envoi impossible : ${error.message}`, "error");
  }
}

// ---------------------------------------------------------------- réception
function onNotification(event) {
  const view = event.target.value;
  const frame = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let message;
  try {
    message = assembler.feed(frame);
  } catch (error) {
    log(`trame rejetée : ${error.message}`);
    return;
  }
  if (message) handleMessage(message);
}

function handleMessage(message) {
  log(`← ${describe(message)}`);
  const sameOrder = state.order && message.order_number === state.order.order_number;
  switch (message.type) {
    case "STATE":
      state.hmiOrder = message.order_number;
      if (sameOrder) {
        clearTimeout(orderTimer);
        state.validated = new Set(message.validated);
        state.active = message.active;
        setSync("synced");
      }
      break;
    case "REF_SELECTED":
      if (sameOrder) {
        settlePending(message.reference_number);
        state.active = message.reference_number;
      }
      break;
    case "REF_VALIDATED":
      if (sameOrder) {
        state.validated.add(message.reference_number);
        if (state.active === message.reference_number) state.active = null;
        navigator.vibrate?.([60, 40, 60]);
        const done = message.validated === message.total;
        toast(done ? `Commande ${message.order_number} terminée ✓`
          : `${message.reference_number} validée (${message.picked_qty}) ✓`, "ok");
      }
      break;
    case "ERROR":
      if (message.reference_number) settlePending(message.reference_number);
      if (message.code === "ORDER_INVALID") {
        clearTimeout(orderTimer);
        setSync("error", message.message);
      }
      toast(message.message || message.code, "error");
      break;
    default:
      log(`message ignoré : ${message.type}`);
  }
  render();
}

function settlePending(reference) {
  clearTimeout(state.pending.get(reference));
  state.pending.delete(reference);
}

function clearPending() {
  for (const timer of state.pending.values()) clearTimeout(timer);
  state.pending.clear();
}

// ----------------------------------------------------------------- commandes
function openOrderSheet() {
  $("order-sheet").showModal();
}

function renderSamples() {
  const list = $("sample-list");
  list.replaceChildren();
  for (const order of SAMPLE_ORDERS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sample";
    const title = document.createElement("span");
    title.className = "sample-number";
    title.textContent = order.order_number;
    const detail = document.createElement("span");
    detail.className = "sample-detail";
    const pieces = order.references.reduce((sum, r) => sum + r.quantity_to_pick, 0);
    detail.textContent = `${order.references.length} références · ${pieces} pièces · exemple IHM`;
    button.append(title, detail);
    button.addEventListener("click", () => chooseOrder(structuredClone(order)));
    list.append(button);
  }
}

function chooseOrder(order) {
  const current = state.order;
  const inProgress = current && state.sync === "synced" && state.validated.size > 0
    && state.validated.size < current.references.length;
  if (inProgress && current.order_number !== order.order_number
      && !confirm(`La commande ${current.order_number} est en cours (${state.validated.size}/`
        + `${current.references.length}). La remplacer sur l'IHM ?`)) {
    return;
  }
  $("order-sheet").close();
  state.order = order;
  state.validated = new Set();
  state.active = null;
  clearPending();
  saveOrder(order);
  setSync("local");
  toast(`Commande ${order.order_number} sélectionnée (${order.references.length} réf.)`, "info");
  if (state.link === "connected") sendOrder();
  render();
}

function loadOrder() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* stockage indisponible : on repart de l'exemple */ }
  return structuredClone(SAMPLE_ORDERS[0]);
}

function saveOrder(order) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch { /* confort seulement */ }
}

// ------------------------------------------------------------------ affichage
const LINK_TEXT = {
  idle: "Déconnecté", connecting: "Connexion…", connected: "Connecté", reconnecting: "Reconnexion…",
};

function setLink(link) {
  state.link = link;
  render();
}

function setSync(sync, detail = "") {
  state.sync = sync;
  state.syncDetail = detail;
  render();
}

function render() {
  const connected = state.link === "connected";
  const chip = $("link-chip");
  chip.dataset.state = state.link;
  chip.textContent = connected && state.device?.name ? state.device.name : LINK_TEXT[state.link];
  $("connect-btn").hidden = connected || state.link === "reconnecting";
  $("connect-btn").textContent = state.link === "connecting" ? "Connexion…" : "Connecter via Bluetooth";
  $("disconnect-btn").hidden = !(connected || state.link === "reconnecting");
  $("disconnect-btn").textContent = state.link === "reconnecting" ? "Arrêter la reconnexion" : "Déconnecter";
  $("connect-hint").hidden = connected;
  $("connect-card").dataset.state = state.link;

  const order = state.order;
  const total = order ? order.references.length : 0;
  const done = order ? order.references.filter((r) => state.validated.has(r.reference_number)).length : 0;
  $("order-number").textContent = order ? order.order_number : "—";
  $("order-count").textContent = `${done} / ${total}`;
  $("progress-fill").style.width = total ? `${(100 * done) / total}%` : "0";
  renderSync(connected);

  const list = $("ref-list");
  list.replaceChildren(...(order ? order.references.map(renderReference) : []));
  $("done-banner").hidden = !(total && done === total && state.sync === "synced");
}

function renderSync(connected) {
  const sync = $("order-sync");
  let text;
  let tone = state.sync;
  if (!state.order) text = "Aucune commande sélectionnée";
  else if (state.sync === "synced") text = "Reçue par l'IHM ✓";
  else if (state.sync === "sending") text = "Envoi à l'IHM…";
  else if (state.sync === "error") text = `Non reçue : ${state.syncDetail}`;
  else {
    text = connected ? "Prête à envoyer" : "Sera envoyée à la connexion";
    tone = "local";
  }
  sync.dataset.state = tone;
  sync.textContent = text;
  $("resend-btn").hidden = !(connected && state.sync === "error");
}

function renderReference(ref) {
  const reference = ref.reference_number;
  let status = "todo";
  if (state.validated.has(reference)) status = "done";
  else if (state.pending.has(reference)) status = "pending";
  else if (state.active === reference) status = "active";

  const item = document.createElement("li");
  const button = document.createElement("button");
  button.className = "ref";
  button.dataset.state = status;
  button.dataset.ref = reference;
  button.disabled = status === "done";
  button.addEventListener("click", () => selectReference(reference));

  const main = document.createElement("div");
  main.className = "ref-main";
  main.append(span("ref-number", reference),
    span("ref-status", { todo: "À scanner", pending: "Envoi…", active: "Sur l'IHM",
      done: "Validée ✓" }[status]));

  const meta = document.createElement("div");
  meta.className = "ref-meta";
  const qty = span("qty", "");
  qty.append(span("qty-value", String(ref.quantity_to_pick)), document.createTextNode(" à prélever"));
  meta.append(span("loc", ref.location), qty,
    span("pack", `Grappe ${ref.qty_per_grappe} · Carton ${ref.qty_per_box}`));
  button.append(main, meta);
  item.append(button);
  return item;
}

function span(className, text) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

let toastTimer = null;
function toast(text, tone = "info") {
  const element = $("toast");
  element.textContent = text;
  element.dataset.tone = tone;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.hidden = true), tone === "error" ? 5000 : 2800);
}

function showBanner(text) {
  $("env-error").textContent = text;
  $("env-error").hidden = false;
}

function hideBanner() {
  $("env-error").hidden = true;
}

function log(text) {
  const element = $("log");
  const time = new Date().toLocaleTimeString("fr-FR");
  element.textContent = `${time} ${text}\n${element.textContent}`.slice(0, 6000);
}

function describe(message) {
  if (message.type === "ORDER_INIT") return `ORDER_INIT ${message.order_number} (${message.references.length} réf.)`;
  const detail = message.reference_number ?? message.order_number ?? message.message ?? "";
  return `${message.type} ${detail ?? ""}`.trim();
}

function sanitizeName(raw) {
  if (!raw) return "";
  const name = raw.trim().slice(0, 32);
  return /^[\p{L}\p{N} ._-]+$/u.test(name) ? name : "";
}

// Accès pour les tests de bout en bout (aucun effet en usage normal).
window.__controller = { state, handleMessage };

init(); // en dernier : toutes les constantes du module sont alors initialisées
